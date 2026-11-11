// Events explorer (GET /apps/:id/events/summary): top events with counts and unique installs, per-day counts. Three
// Analytics Engine queries (cached 5 minutes, worker/lib/wae.ts; days are UTC days of the time the event was received)
// plus one database call for the key events stored exactly (worker/lib/key-events.ts, cached 5 minutes too): a key
// event covered for the whole range shows its exact count, unique installs and per-day counts (UTC days of reception,
// like Analytics Engine's), `source: "exact"`; every other event comes from Analytics Engine, `source: "sampled"`.
// Analytics Engine's counts of the exact events are taken out of the total (from the daily query; if it was truncated
// at its LIMIT, from the top query, and a note says the total may count some events twice).

import type { EventSummary } from "../../shared/types";
import { exactSummary, type ExactSummaryResult } from "./key-events";
import { now } from "./util";
import { analyticsConfig, num, runSql, SUMMARY_DAILY_LIMIT, summarySql, type TestFilter } from "./wae";

const DAY_MS = 86_400_000;
export const SUMMARY_MAX_DAYS = 92;
const TOP_IN_DAILY = 8;
const TOP_LIMIT = 50;
const EXACT_TTL_MS = 5 * 60_000;
const exactCache = new Map<string, { value: ExactSummaryResult; expires: number }>();


export function resetSummaryCache() {
  exactCache.clear();
}

/** The exact rows (cached 5 minutes in the isolate); none when the database call fails (Analytics Engine only then). */
async function exactRowsOf(env: Env, appId: string, fromMs: number, toMs: number, test?: TestFilter): Promise<ExactSummaryResult> {
  const key = JSON.stringify([appId, fromMs, toMs, !!test?.includeTest, test?.excludedInstalls ?? []]);
  const hit = exactCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await exactSummary(env, { appId, fromMs, toMs, test }).catch((err) => {
    console.error("exact event summary failed", err);
    return null;
  });
  if (!value) return { rows: [], note: null };
  if (exactCache.size >= 200) exactCache.delete(exactCache.keys().next().value!);
  exactCache.set(key, { value, expires: Date.now() + EXACT_TTL_MS });
  return value;
}

/** "7d", "30d", "90d" → days (1..92), null when invalid. */
export function parseRangeDays(range: string | undefined, fallback = 7): number | null {
  if (!range) return fallback;
  const m = /^(\d{1,3})d$/.exec(range.trim());
  if (!m) return null;
  const d = Number(m[1]);
  return d >= 1 && d <= SUMMARY_MAX_DAYS ? d : null;
}

/** `test`: production data from other devices than the app's test ones by default (worker/lib/test-data.ts). */
export async function eventSummary(env: Env, appId: string, days: number, opts: { origin?: string; at?: number; test?: TestFilter } = {}): Promise<EventSummary> {
  const { dataset } = analyticsConfig(env);
  const at = opts.at ?? now();
  const today = Math.floor(at / DAY_MS) * DAY_MS;
  const fromMs = today - (days - 1) * DAY_MS;
  // Rounded up to 5 minutes: repeated reads hit the cache.
  const toMs = Math.ceil(at / 300_000) * 300_000;
  const q = summarySql(dataset, appId, fromMs, toMs, opts.test);
  const [top, daily, totals, exactResult] = await Promise.all([runSql(env, q.top, opts), runSql(env, q.daily, opts), runSql(env, q.totals, opts), exactRowsOf(env, appId, fromMs, toMs, opts.test)]);
  const exactRows = exactResult.rows;
  const exact = new Map(exactRows.map((r) => [r.name, r]));
  const notes: string[] = exactResult.note ? [exactResult.note] : [];

  const sampledEvents = top
    .filter((r) => !exact.has(String(r.name ?? "")))
    .map((r) => ({ name: String(r.name ?? ""), count: Math.round(num(r.events)), installs: num(r.installs), lastSeenAt: num(r.last) || null, source: "sampled" as const }));
  const exactEvents = exactRows.filter((r) => r.count > 0).map((r) => ({ name: r.name, count: r.count, installs: r.installs, lastSeenAt: r.last, source: "exact" as const }));
  const events = [...sampledEvents, ...exactEvents].sort((a, b) => b.count - a.count).slice(0, TOP_LIMIT);
  const shown = new Set(events.slice(0, TOP_IN_DAILY).map((e) => e.name));
  const byDay = new Map<string, { date: string; count: number; byEvent: Record<string, number> }>();
  for (let t = fromMs; t <= today; t += DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10);
    byDay.set(date, { date, count: 0, byEvent: {} });
  }
  const add = (date: string, name: string, n: number) => {
    const d = byDay.get(date);
    if (!d) return;
    const key = shown.has(name) ? name : "(other)";
    d.count += n;
    d.byEvent[key] = (d.byEvent[key] ?? 0) + n;
  };
  // Analytics Engine's counts of the exact events are left out of the total and replaced by the exact ones. When the
  // daily query hit its LIMIT its rows are incomplete: the top query's totals are subtracted instead (exact events
  // outside its top 50 then stay in the sampled total).
  const truncated = daily.length >= SUMMARY_DAILY_LIMIT;
  let sampledOfExact = 0;
  for (const r of daily) {
    const n = Math.round(num(r.events));
    if (exact.has(String(r.name))) {
      if (!truncated) sampledOfExact += n;
      continue;
    }
    add(String(r.day ?? "").slice(0, 10), String(r.name), n);
  }
  if (truncated) {
    for (const r of top) if (exact.has(String(r.name ?? ""))) sampledOfExact += Math.round(num(r.events));
    notes.push(
      exact.size
        ? "Too many events per day for the daily breakdown: it is incomplete, and the total may count some exact key events twice."
        : "Too many events per day for the daily breakdown: it is incomplete.",
    );
  }
  let exactTotal = 0;
  for (const r of exactRows) {
    exactTotal += r.count;
    for (const [date, n] of Object.entries(r.daily)) add(date, r.name, n);
  }
  const t = totals[0] ?? {};
  // Sampled: Analytics Engine sampled an event shown from it (or the total, when it has events not shown exactly).
  const sampledTotal = Math.max(0, Math.round(num(t.events)) - sampledOfExact);
  const sampled = top.some((r) => !exact.has(String(r.name ?? "")) && num(r.si) > 1) || (num(t.si) > 1 && sampledTotal > 0);
  return {
    appId,
    from: new Date(fromMs).toISOString().slice(0, 10),
    to: new Date(today).toISOString().slice(0, 10),
    days,
    totalEvents: sampledTotal + exactTotal,
    uniqueInstalls: Math.max(num(t.installs), ...exactRows.map((r) => r.installs)),
    events,
    daily: [...byDay.values()],
    approximate: sampled,
    includeTest: !!opts.test?.includeTest,
    notes,
    generatedAt: at,
  };
}
