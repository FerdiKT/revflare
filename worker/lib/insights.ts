// App event alerts and the daily digest (docs/funnels.md#alerts):
//
//   events_silent       hourly from checkAlerts (worker/lib/alerts.ts), no Analytics Engine query: the per-app "last
//                       event received" note (worker/lib/events.ts) plus a small per-app state (settings
//                       `events_seen:<app>`: active hours per day) give the baseline and the app's usual volume.
//   funnel_anomaly      once a day per funnel (≥ 10:00 UTC): yesterday's step-to-step conversions against the 14 days
//                       before and against the same weekday(s) in them (two-proportion z-tests, both p < 0.01, relative
//                       drop ≥ 15 / 20 / 30 % against both), entries of each day's last 3 hours left out (offline lag).
//   release_regression  once a day per funnel: the newest app version with ≥ 200 installs (first seen ≤ 14 days ago)
//                       against the most used other version over the same days (two-proportion z-test), one alert per
//                       version, resolved by a later check that finds none.
//   daily digest        once per workspace and UTC day: the ledger part in the first tick after 00:00 UTC, event metrics
//                       from 00:30 UTC (worker/lib/digest.ts), then the digest emails.
//
// cronInsights runs every cron tick as a database call of its own (from the scheduled handler, like cronAcquisition),
// with one budget of outbound requests per tick (TickBudget, MAX_REQUESTS_PER_TICK: Analytics Engine SQL API queries,
// APNs pushes of the alerts it raises, digest emails) and at most MAX_FUNNELS_PER_TICK funnels, picked round-robin
// (settings `funnel_alerts_cursor`). Without CF_ACCOUNT_ID / CF_ANALYTICS_TOKEN / EVENTS the funnel checks are skipped
// and the digest has no event metrics.
//
// Funnel checks and the digest's installs / paywall views read the stored key events instead of Analytics Engine when
// they cover the days (worker/lib/key-events.ts: exact, no query).
// Funnel checks fetch each event step once (15 days of entries up to now, step 1 broken down by app version) and
// evaluate both rules on that data. Conversions are counted within an effective window: the funnel's window, capped at
// the time since yesterday ended (anomaly: yesterday's installs had no longer) or at 24 hours (regression, entries up
// to 24 hours ago), so both sides of each comparison had the same time to convert.

import { type FunnelStep } from "../../shared/types";
import { raiseAlert, resolveAlerts } from "./alert-store";
import { defineDbFunction, type Db } from "./db";
import { assembleDigest, digestEmail, digestEventsOf, digestKey, readDigest, type Digest, type DigestSection, type LedgerRow } from "./digest";
import { emailBinding, sendError, sender } from "./email";
import { cronExperiments } from "./experiments";
import { eventsBinding } from "./events";
import { computeFunnel, funnelAlertsOf, NO_VALUE, revenueStepData, STEP_INSTALL_CAP, stepLabel, toFunnel, toStepData, type FunnelRow, type StepData, type StepSource } from "./funnels";
import { FxCache, addDays, dayOf } from "./money";
import { apnsConfigured, localParts, parsePrefs, pushRecipients, type SendBudget } from "./push";
import { baseUrl, getSetting, setSetting } from "./settings";
import {
  eventSilence,
  MIN_ENTRANTS,
  MIN_VERSION_ENTRANTS,
  mostSensitive,
  pickRelease,
  pickRoundRobin,
  worstAnomaly,
  worstRegression,
  type SilenceState,
  type StepDrop,
} from "./stats";
import { errorMessage, parseJson } from "./util";
import { parseTestInstalls } from "./test-data";
import { analyticsConfig, analyticsMissing, DIGEST_EVENTS, digestSql, runSql, stepSql } from "./wae";
import { exactDigestRows, exactFunnelSteps } from "./key-events";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Outbound requests per cron tick (Analytics Engine SQL API queries, APNs pushes of raised alerts, digest emails), well
 * under the Workers subrequest limit.
 */
export const MAX_REQUESTS_PER_TICK = 40;
export const MAX_FUNNELS_PER_TICK = 10;
/** Funnel checks start at 10:00 UTC: yesterday's installs had at least 10 hours to convert, late events arrived. */
const FUNNEL_CHECK_HOUR = 10;
/** Anomaly: entries of each day's last 3 hours are left out (events queued offline arrive late). */
const LATE_ENTRY_MS = 3 * HOUR;
/** The digest's event metrics are added from 00:30 UTC (the ledger part comes right after midnight). */
const DIGEST_EVENTS_MINUTE = 30;
const DIGEST_APPS_PER_QUERY = 50;
const DIGEST_EMAILS_PER_TICK = 10;
/** A funnel check can raise two alerts (anomaly, regression): room for their pushes, at most this many requests. */
const PUSHES_PER_FUNNEL = 2;
const MAX_PUSH_RESERVE = 20;
const CURSOR_KEY = "funnel_alerts_cursor";
const lastEventPrefix = "events_last:";
const seenKey = (appId: string) => `events_seen:${appId}`;
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** Counts a tick's outbound requests (SQL API, emails, pushes) against one cap. */
export class TickBudget implements SendBudget {
  readonly used = { sql: 0, email: 0, push: 0 };
  constructor(public left: number) {}
  take(n = 1, kind: "sql" | "email" | "push" = "sql"): boolean {
    if (n > this.left) return false;
    this.left -= n;
    this.used[kind] += n;
    return true;
  }
  get total(): number {
    return this.used.sql + this.used.email + this.used.push;
  }
}

/** Settings rows whose key starts with `prefix` (an index range, no scan). */
async function settingsWithPrefix(db: Db, prefix: string): Promise<Map<string, string>> {
  const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  const { results } = await db.prepare("SELECT key, value FROM settings WHERE key >= ? AND key < ?").bind(prefix, upper).all<{ key: string; value: string }>();
  return new Map(results.map((r) => [r.key.slice(prefix.length), r.value]));
}

async function chunked<T>(ids: string[], run: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 90) out.push(...(await run(ids.slice(i, i + 90))));
  return out;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pValue = (p: number) => (p < 0.0001 ? "< 0.0001" : p.toFixed(4));

// --- Event silence -----------------------------------------------------------------------------------------------------

/** Open events_silent alerts per app (one statement per 90 workspaces, index range on (workspace_id, key)). */
async function openSilenceAlerts(db: Db, workspaceIds: string[]): Promise<Map<string, { key: string; created_at: number }[]>> {
  const rows = await chunked(workspaceIds, async (chunk) =>
    (
      await db
        .prepare(
          `SELECT app_id, key, created_at FROM alerts WHERE workspace_id IN (${chunk.map(() => "?").join(",")}) AND key >= 'events_silent:' AND key < 'events_silent;' AND resolved_at IS NULL`,
        )
        .bind(...chunk)
        .all<{ app_id: string | null; key: string; created_at: number }>()
    ).results,
  );
  const out = new Map<string, { key: string; created_at: number }[]>();
  for (const r of rows) if (r.app_id) out.set(r.app_id, [...(out.get(r.app_id) ?? []), r]);
  return out;
}

/**
 * Hourly (from checkAlerts): apps that usually send events (on ≥ 4 of the last 7 days) and have been silent longer than
 * their threshold (3 / 6 / 12 hours by sensitivity, longer for sparse apps). Zero Analytics Engine queries. The
 * sensitivity is the most sensitive of the app's funnels with alerts on; an app whose funnels all have alerts off gets
 * no silence alert. An open alert resolves as soon as events are back (an event newer than the alert, or a silence
 * under the threshold), even when the app no longer has a baseline.
 */
export async function checkEventSilence(env: Env, db: Db, at: number): Promise<{ raised: number; resolved: number; apps: number }> {
  const notes = await settingsWithPrefix(db, lastEventPrefix);
  if (!notes.size) return { raised: 0, resolved: 0, apps: 0 };
  const states = await settingsWithPrefix(db, "events_seen:");
  const ids = [...notes.keys()];
  const apps = await chunked(ids, async (chunk) =>
    (await db.prepare(`SELECT id, workspace_id, name FROM apps WHERE archived = 0 AND id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ id: string; workspace_id: string; name: string }>()).results,
  );
  const funnels = await chunked(apps.map((a) => a.id), async (chunk) =>
    (await db.prepare(`SELECT app_id, alerts FROM funnels WHERE app_id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ app_id: string; alerts: string | null }>()).results,
  );
  const open = await openSilenceAlerts(db, [...new Set(apps.map((a) => a.workspace_id))]);
  let raised = 0;
  let resolved = 0;
  for (const a of apps) {
    const own = funnels.filter((f) => f.app_id === a.id).map((f) => funnelAlertsOf(f.alerts));
    const on = own.filter((s) => s.enabled);
    const enabled = !own.length || on.length > 0;
    const last = Number(notes.get(a.id)) || null;
    const r = eventSilence(parseJson<SilenceState | null>(states.get(a.id), null), last, at, mostSensitive(on.map((s) => s.sensitivity)));
    if (r.changed) await setSetting(db, seenKey(a.id), JSON.stringify(r.state));
    // Only apps with an open alert cost an UPDATE.
    for (const o of open.get(a.id) ?? []) {
      const back = !enabled || r.status === "ok" || (last !== null && last > o.created_at) || (r.silentHours !== null && r.silentHours <= r.thresholdHours);
      if (!back) continue;
      await resolveAlerts(db, a.workspace_id, o.key);
      resolved++;
    }
    if (r.status === "silent" && enabled && last) {
      const hours = String(Math.floor(r.silentHours!));
      if (
        await raiseAlert(env, db, {
          workspaceId: a.workspace_id,
          appId: a.id,
          key: `events_silent:${a.id}:${dayOf(last)}`,
          kind: "events_silent",
          severity: "warning",
          title: `No app events from ${a.name}`,
          body: `No RevflareKit events arrived for ${hours} hours although ${a.name} sent events on ${r.activeDays} of the last 7 days (alert after ${r.thresholdHours} hours). Check the latest release: RevflareKit configured with the app's SDK key, events not turned off.`,
          push: { kind: "funnel", titleKey: "PUSH_TITLE_ALERT_EVENTS_SILENT", titleArgs: [a.name], bodyKey: "PUSH_BODY_ALERT_EVENTS_SILENT", bodyArgs: [hours] },
        })
      )
        raised++;
    }
  }
  return { raised, resolved, apps: apps.length };
}

// --- Funnel checks -----------------------------------------------------------------------------------------------------

interface CheckRow extends FunnelRow {
  workspace_id: string;
  app_name: string;
  /** The app's test devices (JSON), left out of the checks with sandbox / Xcode events. */
  test_installs: string | null;
}

export interface FunnelCheck {
  funnelId: string;
  anomaly: (StepDrop & { day: string }) | null;
  regression: (StepDrop & { version: string; previous: string }) | null;
  /** Why a rule did not run (too few installs, no new version...). */
  skipped: string[];
}

function sourcesFor(env: Env, funnel: { appId: string; steps: FunnelStep[] }, eventData: (StepData | null)[], first: StepData, fromMs: number, toMs: number): StepSource[] {
  return funnel.steps.map((s, i) => {
    if (i === 0) return first;
    if (s.type === "event") return eventData[i]!;
    return async (installs: string[]) => new Map(await revenueStepData(env, { appId: funnel.appId, installs, kind: s.kind, fromMs, toMs }));
  });
}

const filterFirst = (first: StepData, keep: (hit: { first: number; b?: string }) => boolean): StepData => new Map([...first].filter(([, h]) => keep(h)));
const users = (steps: { users: number }[]) => steps.map((s) => s.users);

/** Both rules for one funnel (one Analytics Engine query per event step). Raises / resolves its alerts. */
export async function checkFunnel(env: Env, db: Db, row: CheckRow, at: number, budget?: SendBudget): Promise<FunnelCheck> {
  const funnel = toFunnel(row);
  const { sensitivity } = funnel.alerts;
  const yesterday = dayOf(at - DAY);
  const yStart = dayMs(yesterday);
  const yEnd = yStart + DAY;
  const rangeFrom = yStart - 14 * DAY;
  // Rounded down to 5 minutes: the queries of one tick share the cache with a report opened at the same time.
  const endMs = Math.floor(at / 300_000) * 300_000;
  const windowMs = funnel.windowSeconds * 1000;
  const test = { excludedInstalls: parseTestInstalls(row.test_installs) };
  // Exact key events when they cover the 15 days (worker/lib/key-events.ts), else one Analytics Engine query per step.
  const exact = await exactFunnelSteps(db, {
    appId: funnel.appId,
    steps: funnel.steps.map((s, i) => (s.type === "event" ? { name: s.name, filters: s.filters, fromMs: rangeFrom, toMs: endMs, breakdown: i === 0 ? "app_version" : null } : null)),
    fromDay: dayOf(rangeFrom),
    toDay: dayOf(at),
    limit: STEP_INSTALL_CAP,
    test,
    breakdown: "app_version",
  }).catch(() => null);
  const eventData: (StepData | null)[] = exact?.exact
    ? exact.steps.map((rows) => (rows ? new Map(rows) : null))
    : await Promise.all(
        funnel.steps.map((s, i) =>
          s.type === "event"
            ? runSql(env, stepSql(analyticsConfig(env).dataset, { appId: funnel.appId, name: s.name, filters: s.filters, fromMs: rangeFrom, toMs: endMs, breakdown: i === 0 ? "app_version" : null, limit: STEP_INSTALL_CAP, test })).then(
                (rows) => toStepData(rows).data,
              )
            : null,
        ),
      );
  const first = eventData[0]!;
  const out: FunnelCheck = { funnelId: funnel.id, anomaly: null, regression: null, skipped: [] };
  const label = (k: number) => stepLabel(funnel.steps[k]);
  const app = row.app_name;
  const compute = (entries: StepData, windowMs: number) => computeFunnel(sourcesFor(env, funnel, eventData, entries, rangeFrom, endMs), { windowMs, ordered: funnel.ordered });

  // Anomaly: yesterday against the 14 days before and against the same weekday(s) in them. Entries of the last 3 hours
  // of each day are left out (events queued offline on devices arrive late), on every day alike.
  const effA = Math.min(windowMs, at - yEnd);
  const inDay = (t: number) => (t - rangeFrom) % DAY < DAY - LATE_ENTRY_MS;
  const yMap = filterFirst(first, (h) => h.first >= yStart && h.first < yEnd && inDay(h.first));
  const anomalyPrefix = `funnel_anomaly:${funnel.id}:`;
  if (effA <= 0 || yMap.size < MIN_ENTRANTS) {
    out.skipped.push(`anomaly: ${yMap.size} installs entered yesterday (needs ${MIN_ENTRANTS})`);
    await resolveAlerts(db, row.workspace_id, anomalyPrefix);
  } else {
    const bMap = filterFirst(first, (h) => h.first >= rangeFrom && h.first < yStart && inDay(h.first));
    // Days 0 and 7 of the window: 14 and 7 days before yesterday.
    const wMap = filterFirst(bMap, (h) => Math.floor((h.first - rangeFrom) / DAY) % 7 === 0);
    const cy = await compute(yMap, effA);
    const cb = await compute(bMap, effA);
    const cw = await compute(wMap, effA);
    const drop = worstAnomaly(users(cy.steps), users(cb.steps), users(cw.steps), sensitivity);
    if (drop) {
      out.anomaly = { ...drop, day: yesterday };
      const from = label(drop.step - 1);
      const to = label(drop.step);
      const p = `${Math.round(drop.drop * 100)}%`;
      const w = drop.weekday!;
      await raiseAlert(env, db, {
        workspaceId: row.workspace_id,
        appId: funnel.appId,
        key: `${anomalyPrefix}${yesterday}`,
        kind: "funnel_anomaly",
        severity: drop.drop >= 0.5 ? "critical" : "warning",
        title: `${from} → ${to} dropped ${p} in ${app}`,
        body:
          `Funnel "${funnel.name}": on ${yesterday}, ${drop.converted} of ${drop.entered} installs (${pct(drop.rate)}) went from ${from} to ${to}, ` +
          `against ${pct(drop.baseRate)} (${drop.baseConverted} of ${drop.baseEntered}) over the 14 days before and ${pct(w.rate)} (${w.converted} of ${w.entered}) on the same weekday ` +
          `(UTC days without their last 3 hours, conversions within ${Math.round(effA / HOUR)} h, p ${pValue(drop.p)}).`,
        push: { kind: "funnel", titleKey: "PUSH_TITLE_ALERT_FUNNEL", titleArgs: [app], bodyKey: "PUSH_BODY_ALERT_FUNNEL", bodyArgs: [from, to, p, pct(drop.rate), pct(drop.baseRate)], data: { funnelId: funnel.id } },
        budget,
      });
    } else await resolveAlerts(db, row.workspace_id, anomalyPrefix);
  }

  // Release regression: the newest version with enough installs against the most used other one, same entry window.
  const effR = Math.min(windowMs, DAY);
  const regressionPrefix = `release_regression:${funnel.id}:`;
  const pick = pickRelease(
    [...first.values()].map((h) => ({ first: h.first, version: h.b && h.b !== NO_VALUE ? h.b : null })),
    { at, dataFrom: rangeFrom, convertMs: effR },
  );
  if ("skipped" in pick) {
    out.skipped.push(pick.skipped);
    // No new version any more: an open regression is over (not when the new version only lacks installs today).
    if (pick.noNewVersion) await resolveAlerts(db, row.workspace_id, regressionPrefix);
  } else {
    const { version: newest, previous } = pick;
    const pair = filterFirst(first, (h) => h.first >= pick.winStart && h.first <= pick.winEnd && (h.b === newest || h.b === previous));
    const c = await compute(pair, effR);
    const drop = worstRegression(users(c.groups.get(newest) ?? []), users(c.groups.get(previous) ?? []), sensitivity);
    if (drop) {
      out.regression = { ...drop, version: newest, previous };
      const from = label(drop.step - 1);
      const to = label(drop.step);
      const p = `${Math.round(drop.drop * 100)}%`;
      await raiseAlert(env, db, {
        workspaceId: row.workspace_id,
        appId: funnel.appId,
        key: `${regressionPrefix}${newest}`,
        kind: "release_regression",
        severity: drop.drop >= 0.5 ? "critical" : "warning",
        title: `${from} → ${to} dropped ${p} in ${app} (${newest} vs ${previous})`,
        body:
          `Funnel "${funnel.name}": since ${newest} appeared (${dayOf(pick.start)}), ${drop.converted} of ${drop.entered} installs on ${newest} (${pct(drop.rate)}) went from ${from} to ${to}, ` +
          `against ${pct(drop.baseRate)} (${drop.baseConverted} of ${drop.baseEntered}) on ${previous} over the same days (conversions within ${Math.round(effR / HOUR)} h, p ${pValue(drop.p)}).`,
        push: { kind: "funnel", titleKey: "PUSH_TITLE_ALERT_RELEASE", titleArgs: [app, newest], bodyKey: "PUSH_BODY_ALERT_RELEASE", bodyArgs: [from, to, p, newest, previous], data: { funnelId: funnel.id } },
        budget,
      });
    } else await resolveAlerts(db, row.workspace_id, regressionPrefix);
  }
  return out;
}

/**
 * Funnels whose step 1 is `first_open` and whose app had too few installs for either rule (yesterday's digest: < 100
 * installs yesterday and < 400 over the 8 days) need no query today. Unknown (no digest with events): checked.
 */
function tooFewInstalls(row: CheckRow, digest: Digest | null): boolean {
  const s1 = toFunnel(row).steps[0];
  if (s1?.type !== "event" || s1.name !== "first_open" || !digest?.events) return false;
  const a = digest.apps.find((x) => x.appId === row.app_id);
  if (!a || a.installs === null) return false;
  return a.installs < MIN_ENTRANTS && a.installs + 7 * (a.avgInstalls ?? 0) < 2 * MIN_VERSION_ENTRANTS;
}

async function checkFunnels(env: Env, db: Db, at: number, budget: TickBudget, maxFunnels: number) {
  const today = dayOf(at);
  const yesterday = dayOf(at - DAY);
  const doneKey = `funnel_alerts_done:${today}`;
  if (await getSetting(db, doneKey)) return { done: true };
  const LIMIT = 500;
  const { results: rows } = await db
    .prepare(
      `SELECT f.id, f.workspace_id, f.app_id, f.name, f.definition, f.alerts, f.created_at, f.updated_at, a.name AS app_name, a.test_installs
       FROM funnels f JOIN apps a ON a.id = f.app_id WHERE a.archived = 0 AND COALESCE(f.alerts_checked, '') < ? ORDER BY f.id LIMIT ?`,
    )
    .bind(today, LIMIT)
    .all<CheckRow>();
  const notes = await settingsWithPrefix(db, lastEventPrefix);
  const digests = new Map<string, Digest | null>();
  for (const ws of new Set(rows.map((r) => r.workspace_id))) digests.set(ws, await readDigest(db, ws, yesterday));
  // Alerts off, no events for 2 days, or too few installs (from the digest): nothing to query today.
  const idle = rows.filter((r) => !funnelAlertsOf(r.alerts).enabled || Number(notes.get(r.app_id) ?? 0) < at - 2 * DAY);
  const idleIds = new Set(idle.map((r) => r.id));
  const small = rows.filter((r) => !idleIds.has(r.id) && tooFewInstalls(r, digests.get(r.workspace_id) ?? null));
  for (const r of small) {
    idleIds.add(r.id);
    await resolveAlerts(db, r.workspace_id, `funnel_anomaly:${r.id}:`);
  }
  const marked = [...idleIds];
  for (let i = 0; i < marked.length; i += 90) {
    const chunk = marked.slice(i, i + 90);
    await db.prepare(`UPDATE funnels SET alerts_checked = ? WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(today, ...chunk).run();
  }
  const due = rows.filter((r) => !idleIds.has(r.id));
  if (!due.length) {
    if (rows.length < LIMIT) await setSetting(db, doneKey, String(at));
    return { checked: 0, idle: idle.length, small: small.length };
  }
  const byId = new Map(due.map((r) => [r.id, r]));
  const picked = pickRoundRobin([...byId.keys()], await getSetting(db, CURSOR_KEY), maxFunnels);
  const log = { checked: 0, idle: idle.length, small: small.length, anomalies: 0, regressions: 0, errors: [] as string[], more: false };
  // Room for the pushes a funnel can raise (anomaly + regression, one APNs request per receiving device).
  const pushes = apnsConfigured(env) || env.TEST_MODE === "true";
  const reserves = new Map<string, number>();
  const reserveFor = async (r: CheckRow) => {
    if (!pushes) return 0;
    if (!reserves.has(r.app_id)) {
      const devices = await pushRecipients(db, r.workspace_id, { kind: "funnel", appId: r.app_id, titleKey: "", bodyKey: "" });
      reserves.set(r.app_id, Math.min(MAX_PUSH_RESERVE, PUSHES_PER_FUNNEL * devices.length));
    }
    return reserves.get(r.app_id)!;
  };
  let cursor: string | null = null;
  for (const id of picked) {
    const row = byId.get(id)!;
    const steps = toFunnel(row).steps.filter((s) => s.type === "event").length;
    if (budget.left < steps + (await reserveFor(row)) || !budget.take(steps)) {
      log.more = true;
      break;
    }
    try {
      const r = await checkFunnel(env, db, row, at, budget);
      if (r.anomaly) log.anomalies++;
      if (r.regression) log.regressions++;
    } catch (err) {
      log.errors.push(`${id}: ${errorMessage(err)}`);
    }
    await db.prepare("UPDATE funnels SET alerts_checked = ? WHERE id = ?").bind(today, id).run();
    cursor = id;
    log.checked++;
  }
  if (cursor) await setSetting(db, CURSOR_KEY, cursor);
  if (log.checked < due.length) log.more = true;
  return log;
}

// --- Daily digest ------------------------------------------------------------------------------------------------------

async function digestInputs(db: Db, workspaceId: string, day: string) {
  const { results: apps } = await db
    .prepare("SELECT id, name, test_installs FROM apps WHERE workspace_id = ? AND archived = 0 ORDER BY name")
    .bind(workspaceId)
    .all<{ id: string; name: string; test_installs: string | null }>();
  const { results: ledger } = await db
    .prepare(
      `SELECT app_id, SUM(CASE WHEN day = ? THEN gross_usd ELSE 0 END) AS rev, SUM(CASE WHEN day = ? THEN proceeds_usd ELSE 0 END) AS proceeds,
         SUM(CASE WHEN day = ? THEN new_subscriptions ELSE 0 END) AS new_subs, SUM(CASE WHEN day = ? THEN trials_started ELSE 0 END) AS trials,
         SUM(CASE WHEN day = ? THEN trial_conversions ELSE 0 END) AS conversions, SUM(CASE WHEN day < ? THEN gross_usd ELSE 0 END) AS prev_rev
       FROM daily_metrics WHERE workspace_id = ? AND day >= ? AND day <= ? GROUP BY app_id`,
    )
    .bind(day, day, day, day, day, day, workspaceId, addDays(day, -7), day)
    .all<LedgerRow>();
  return { apps, ledger };
}

/** Apps whose events can be queried for the digest (a "last event" note within 8 days). */
const digestEventApps = (apps: { id: string }[], notes: Map<string, string>, at: number) => apps.filter((a) => Number(notes.get(a.id) ?? 0) >= at - 8 * DAY).map((a) => a.id);

/**
 * The ledger part of a workspace's digest (daily_metrics only, no Analytics Engine query), stored at once;
 * `eventsPending` when the insights cron will add event metrics. Also called by the summary push when a device's
 * "yesterday" (a finished UTC day) has no digest yet.
 */
export async function writeLedgerDigest(env: Env, db: Db, workspaceId: string, day: string, at: number, notes?: Map<string, string>): Promise<Digest> {
  const { apps, ledger } = await digestInputs(db, workspaceId, day);
  notes ??= await settingsWithPrefix(db, lastEventPrefix);
  const eventsPending = insightsConfigured(env) && digestEventApps(apps, notes, at).length > 0;
  const digest = assembleDigest({ workspaceId, day, apps, ledger, events: null, eventApps: [], at, eventsPending });
  await setSetting(db, digestKey(workspaceId, day), JSON.stringify(digest));
  return digest;
}

/**
 * Yesterday's digests in two passes: the ledger part of every workspace in the first tick after 00:00 UTC (no
 * Analytics Engine query, so the 09:00 summaries of devices at UTC+9 already have it), then from 00:30 UTC the event
 * metrics (one query per workspace and 50 apps, from the tick budget) for the digests marked `eventsPending`.
 */
async function computeDigests(env: Env, db: Db, at: number, budget: TickBudget | null) {
  const day = dayOf(at - DAY);
  const doneKey = `digest_done:${day}`;
  if (await getSetting(db, doneKey)) return { done: true };
  const { results: workspaces } = await db.prepare("SELECT id FROM workspaces ORDER BY id").all<{ id: string }>();
  const notes = await settingsWithPrefix(db, lastEventPrefix);
  const log = { computed: 0, events: 0, pending: 0, errors: [] as string[] };
  const pending: string[] = [];
  for (const ws of workspaces) {
    let digest = await readDigest(db, ws.id, day);
    if (!digest) {
      digest = await writeLedgerDigest(env, db, ws.id, day, at, notes);
      log.computed++;
    }
    if (digest.eventsPending) pending.push(ws.id);
  }
  const d = new Date(at);
  const eventsDue = !!budget && d.getUTCHours() * 60 + d.getUTCMinutes() >= DIGEST_EVENTS_MINUTE;
  for (const wsId of pending) {
    if (!eventsDue) {
      log.pending++;
      continue;
    }
    const { apps, ledger } = await digestInputs(db, wsId, day);
    let eventApps = digestEventApps(apps, notes, at);
    let events = null;
    if (eventApps.length) {
      const chunks: string[][] = [];
      for (let i = 0; i < eventApps.length; i += DIGEST_APPS_PER_QUERY) chunks.push(eventApps.slice(i, i + DIGEST_APPS_PER_QUERY));
      if (!budget!.take(chunks.length)) {
        // Over this tick's budget: the remaining workspaces wait for the next tick.
        log.pending += pending.length - pending.indexOf(wsId);
        break;
      }
      try {
        const fromMs = dayMs(day) - 7 * DAY;
        // Apps whose key events cover the 8 days: exact counts from the database; the others from Analytics Engine.
        const exact = await exactDigestRows(db, apps.filter((a) => eventApps.includes(a.id)).map((a) => ({ id: a.id, test_installs: parseTestInstalls(a.test_installs) })), DIGEST_EVENTS, fromMs, dayMs(day) + DAY);
        const rest = chunks.map((c) => c.filter((id) => !exact.exactApps.includes(id))).filter((c) => c.length);
        const excluded = apps.flatMap((a) => parseTestInstalls(a.test_installs));
        const rows = rest.length ? (await Promise.all(rest.map((c) => runSql(env, digestSql(analyticsConfig(env).dataset, c, fromMs, dayMs(day) + DAY, excluded))))).flat() : [];
        events = digestEventsOf([...exact.rows, ...rows]);
      } catch (err) {
        // Kept without event metrics (no retry: every tick would spend its budget on it).
        log.errors.push(`${wsId}: ${errorMessage(err)}`);
        eventApps = [];
      }
    }
    await setSetting(db, digestKey(wsId, day), JSON.stringify(assembleDigest({ workspaceId: wsId, day, apps, ledger, events, eventApps, at })));
    log.events++;
  }
  if (!log.pending) {
    await setSetting(db, doneKey, String(at));
    // Keep a week of digests and markers.
    const cutoff = addDays(day, -8);
    await db.batch(
      ["digest:", "digest_done:", "digest_mail:", "digest_mail_done:", "funnel_alerts_done:", "experiments_snapshot_done:"].map((prefix) =>
        db.prepare("DELETE FROM settings WHERE key >= ? AND key < ? AND substr(key, -10) < ?").bind(prefix, prefix.slice(0, -1) + ";", cutoff),
      ),
    );
  }
  return log;
}

/**
 * Daily digest emails: users who turned them on, once their local time (their newest device's time zone, else UTC) is
 * past 09:00, after both digest passes. At most DIGEST_EMAILS_PER_TICK per tick (from the tick budget);
 * `digest_mail_done:<day>` once every user had theirs.
 */
async function sendDigestEmails(env: Env, db: Db, at: number, budget: TickBudget) {
  const mail = emailBinding(env);
  if (!mail) return null;
  const day = dayOf(at - DAY);
  const doneKey = `digest_mail_done:${day}`;
  if (await getSetting(db, doneKey)) return { done: true };
  if (!(await getSetting(db, `digest_done:${day}`))) return { waiting: true };
  const LIMIT = 500;
  const { results: users } = await db
    .prepare("SELECT id, email FROM users WHERE daily_digest_email = 1 AND status = 'active' ORDER BY id LIMIT ?")
    .bind(LIMIT)
    .all<{ id: string; email: string }>();
  const log = { sent: 0, failed: 0, later: 0 };
  let link = "";
  for (const u of users) {
    const markKey = `digest_mail:${u.id}:${day}`;
    if (await getSetting(db, markKey)) continue;
    const device = await db.prepare("SELECT prefs FROM devices WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1").bind(u.id).first<{ prefs: string }>();
    const local = localParts(parsePrefs(device?.prefs).timezone || "UTC", at);
    if (local.day <= day || (local.day === addDays(day, 1) && local.hm < "09:00")) {
      log.later++;
      continue;
    }
    if (log.sent + log.failed >= DIGEST_EMAILS_PER_TICK || !budget.take(1, "email")) {
      log.later++;
      break;
    }
    await setSetting(db, markKey, String(at));
    const { results: memberships } = await db
      .prepare("SELECT w.id, w.name, w.currency FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY m.created_at")
      .bind(u.id)
      .all<{ id: string; name: string; currency: string }>();
    const sections: DigestSection[] = [];
    const fx = new FxCache(db);
    for (const ws of memberships) {
      const digest = await readDigest(db, ws.id, day);
      if (!digest || !digest.apps.length) continue;
      sections.push({ workspaceName: ws.name, currency: ws.currency, rate: await fx.perUsd(ws.currency, day), digest });
    }
    if (!sections.length) continue;
    link ||= await baseUrl(env, db).catch(() => "");
    try {
      await mail.binding.send({ from: sender(mail.from), to: u.email, ...digestEmail(day, sections, link || "https://revflare.invalid") });
      log.sent++;
    } catch (err) {
      log.failed++;
      console.warn(JSON.stringify({ event: "digest_email_failed", error: sendError(err) }));
    }
  }
  if (!log.later && users.length < LIMIT) await setSetting(db, doneKey, String(at));
  return log;
}

// --- The cron entry ----------------------------------------------------------------------------------------------------

/** Analytics Engine is queryable and events are ingested. */
export const insightsConfigured = (env: Env) => analyticsMissing(env).query && !!eventsBinding(env);

export const cronInsights = defineDbFunction("cronInsights", async (db, args: { at: number; maxRequests?: number; maxFunnels?: number }, env) => {
  const at = args.at;
  const budget = new TickBudget(args.maxRequests ?? MAX_REQUESTS_PER_TICK);
  const configured = insightsConfigured(env);
  const log: Record<string, unknown> = {};
  log.digests = await computeDigests(env, db, at, configured ? budget : null);
  // Experiments: auto-stop after 90 days (always), daily exposure snapshots and confident results (Analytics Engine).
  const experiments = await cronExperiments(env, db, at, configured ? budget : null).catch((err) => ({ error: errorMessage(err) }));
  if (Object.keys(experiments).length) log.experiments = experiments;
  if (configured && new Date(at).getUTCHours() >= FUNNEL_CHECK_HOUR) log.funnels = await checkFunnels(env, db, at, budget, args.maxFunnels ?? MAX_FUNNELS_PER_TICK);
  // Emails wait for a tick without funnel checks (those can use the budget for pushes).
  const funnelsRan = ((log.funnels as { checked?: number } | undefined)?.checked ?? 0) > 0;
  const emails = funnelsRan ? null : await sendDigestEmails(env, db, at, budget);
  if (emails) log.emails = emails;
  log.requests = budget.used.sql;
  log.subrequests = budget.total;
  return log;
});
