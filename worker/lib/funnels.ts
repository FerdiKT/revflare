// Funnels over RevflareKit app events (Workers Analytics Engine) and Revflare's own sales (docs/funnels.md).
//
// Definitions: small rows in `funnels` (validated here). Reports:
//   1. One Analytics Engine query per event step: per install, first / last time of the step in the range, how many
//      times, the sample interval and (first step) the breakdown value — capped at STEP_INSTALL_CAP installs.
//   2. Revenue steps ("trial_started", "paid", "any_purchase"): the installs still in the funnel before the step are
//      looked up in install_links → transactions (indexed, ≤ 90 ids per statement, inside the database object), capped
//      at REVENUE_INSTALL_CAP installs. Never a scan of `transactions`.
//   3. computeFunnel (pure): per install, walk the steps in order. A step counts when it happens at or after the
//      previous step (ordered) or the first step (unordered) and within the window of the first step. Only first and
//      last times are known per step: when the first is before the anchor but the last is after it, the step time is the
//      last one (exact when the step happened at most twice, else flagged as inferred and the report is approximate).
// Exact key events (worker/lib/key-events.ts): when every event step is a key event stored for the whole range (and the
// breakdown has a column there), step 1 comes from the database instead (same per-install data, one database call):
// `source: "exact"`. Otherwise Analytics Engine for the whole report (`source: "sampled"`, with a note saying why when
// the key events only partly cover the range).
// Reports are cached 5 minutes in the isolate (and every Analytics Engine query by its SQL text, worker/lib/wae.ts).

import {
  EVENT_NAME_RE,
  EVENT_PROP_KEY_RE,
  FUNNEL_BREAKDOWNS,
  FUNNEL_FILTER_VALUE_RE,
  FUNNEL_LIMITS,
  type Funnel,
  type FunnelAlertSettings,
  type FunnelBreakdown,
  type FunnelPropFilter,
  type FunnelReport,
  type FunnelReportStep,
  type FunnelStep,
  type RevenueStepKind,
} from "../../shared/types";
import { defineDbFunction, type Db } from "./db";
import { DEFAULT_FUNNEL_ALERTS, isSensitivity } from "./stats";
import { newId, now, parseJson } from "./util";
import { analyticsConfig, num, runSql, stepSql, type TestFilter } from "./wae";
import { funnelStepsExact, type FunnelStepsResult } from "./key-events";

export const STEP_INSTALL_CAP = 50_000;
export const REVENUE_INSTALL_CAP = 20_000;
const REVENUE_CHUNK = 90;
const DAY_MS = 86_400_000;
/** Analytics Engine keeps data 3 months. */
export const MAX_RANGE_DAYS = 92;

type Fail = { error: string };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, "").trim();
const REVENUE_KINDS: RevenueStepKind[] = ["trial_started", "paid", "any_purchase"];

/** "30m", "1h", "1d", "7d", "2w" → seconds (null: not a duration). */
export function parseWindow(v: string): number | null {
  const m = /^(\d{1,4})\s*(m|min|h|d|w)$/i.exec(v.trim());
  if (!m) return null;
  const unit = { m: 60, min: 60, h: 3600, d: 86_400, w: 604_800 }[m[2].toLowerCase() as "m"]!;
  return Number(m[1]) * unit;
}

export function formatWindow(seconds: number): string {
  for (const [unit, s] of [
    ["w", 604_800],
    ["d", 86_400],
    ["h", 3600],
    ["m", 60],
  ] as const)
    if (seconds % s === 0) return `${seconds / s}${unit}`;
  return `${seconds}s`;
}

function parseLabel(v: unknown, where: string): string | undefined | Fail {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") return { error: `${where}: label must be a string` };
  const s = clean(v);
  if (s.length > 60) return { error: `${where}: label is longer than 60 characters` };
  return s || undefined;
}

export function parseStep(v: unknown, index: number): FunnelStep | Fail {
  const where = `Step ${index + 1}`;
  if (!isObject(v)) return { error: `${where}: expected { type: "event", name, filters? } or { type: "revenue", kind }` };
  const label = parseLabel(v.label, where);
  if (isObject(label)) return label;
  if (v.type === "revenue") {
    if (index === 0) return { error: "Step 1 must be an event (revenue steps follow the installs found by the event steps)" };
    if (!REVENUE_KINDS.includes(v.kind as RevenueStepKind)) return { error: `${where}: kind must be one of ${REVENUE_KINDS.join(", ")}` };
    return { type: "revenue", kind: v.kind as RevenueStepKind, ...(label ? { label } : {}) };
  }
  if (v.type !== "event" && v.type !== undefined) return { error: `${where}: type must be "event" or "revenue"` };
  if (typeof v.name !== "string" || !EVENT_NAME_RE.test(v.name)) return { error: `${where}: name must be an event name (letters, digits, _ . : -, at most 64 characters)` };
  const filters: FunnelPropFilter[] = [];
  if (v.filters !== undefined && v.filters !== null) {
    const raw: unknown[] = Array.isArray(v.filters) ? v.filters : isObject(v.filters) ? Object.entries(v.filters).map(([key, value]) => ({ key, value })) : [null];
    if (raw.length > FUNNEL_LIMITS.filtersPerStep) return { error: `${where}: at most ${FUNNEL_LIMITS.filtersPerStep} property filters` };
    for (const f of raw) {
      if (!isObject(f) || typeof f.key !== "string" || !EVENT_PROP_KEY_RE.test(f.key)) return { error: `${where}: each filter is { key, value } with a property key (letters, digits, _ . -)` };
      const value = typeof f.value === "number" || typeof f.value === "boolean" ? String(f.value) : f.value;
      if (typeof value !== "string" || !FUNNEL_FILTER_VALUE_RE.test(value))
        return { error: `${where}: filter "${f.key}": the value must be at most 100 characters of letters, digits, spaces and _ . : @ / + , # -` };
      if (filters.some((x) => x.key === f.key)) return { error: `${where}: filter "${f.key}" appears twice` };
      filters.push({ key: f.key, value });
    }
  }
  return { type: "event", name: v.name, ...(filters.length ? { filters } : {}), ...(label ? { label } : {}) };
}

export interface FunnelDefinition {
  name: string;
  steps: FunnelStep[];
  windowSeconds: number;
  ordered: boolean;
  alerts: FunnelAlertSettings;
}

/** `{ enabled?, sensitivity? }` merged over `prev` (default: enabled, normal). No free-form thresholds. */
export function parseFunnelAlerts(v: unknown, prev: FunnelAlertSettings = DEFAULT_FUNNEL_ALERTS): FunnelAlertSettings | Fail {
  if (v === undefined || v === null) return prev;
  if (!isObject(v)) return { error: 'alerts must be { enabled?: boolean, sensitivity?: "high" | "normal" | "low" }' };
  const unknown = Object.keys(v).filter((k) => k !== "enabled" && k !== "sensitivity");
  if (unknown.length) return { error: `alerts: unknown field ${unknown[0]} (only enabled and sensitivity)` };
  if (v.enabled !== undefined && typeof v.enabled !== "boolean") return { error: "alerts.enabled must be true or false" };
  if (v.sensitivity !== undefined && !isSensitivity(v.sensitivity)) return { error: 'alerts.sensitivity must be "high", "normal" or "low"' };
  return { enabled: (v.enabled as boolean | undefined) ?? prev.enabled, sensitivity: (v.sensitivity as FunnelAlertSettings["sensitivity"] | undefined) ?? prev.sensitivity };
}

/** Validates a POST body, or a PATCH body merged over `prev`. */
export function parseFunnel(body: unknown, prev?: FunnelDefinition): FunnelDefinition | Fail {
  if (!isObject(body)) return { error: "Expected a JSON object { name, steps, window?, ordered? }" };
  const b = { ...(prev ?? {}), ...body } as Record<string, unknown>;
  if (typeof b.name !== "string" || !clean(b.name)) return { error: "name is required" };
  const name = clean(b.name);
  if (name.length > 100) return { error: "name is longer than 100 characters" };
  if (!Array.isArray(b.steps)) return { error: "steps must be a list" };
  if (b.steps.length < FUNNEL_LIMITS.minSteps || b.steps.length > FUNNEL_LIMITS.maxSteps) return { error: `A funnel has ${FUNNEL_LIMITS.minSteps} to ${FUNNEL_LIMITS.maxSteps} steps` };
  const steps: FunnelStep[] = [];
  for (const [i, s] of b.steps.entries()) {
    const step = parseStep(s, i);
    if ("error" in step) return step;
    steps.push(step);
  }
  let windowSeconds = prev?.windowSeconds ?? 7 * 86_400;
  if (body.window !== undefined && body.window !== null) {
    const w = typeof body.window === "string" ? parseWindow(body.window) : null;
    if (w === null) return { error: 'window must be a duration such as "1h", "1d", "7d" or "30d"' };
    windowSeconds = w;
  } else if (body.windowSeconds !== undefined) {
    if (typeof body.windowSeconds !== "number" || !Number.isInteger(body.windowSeconds)) return { error: "windowSeconds must be an integer" };
    windowSeconds = body.windowSeconds;
  }
  if (windowSeconds < FUNNEL_LIMITS.minWindowSeconds || windowSeconds > FUNNEL_LIMITS.maxWindowSeconds) return { error: "The conversion window must be between 1 minute and 90 days" };
  if (b.ordered !== undefined && typeof b.ordered !== "boolean") return { error: "ordered must be true or false" };
  const alerts = parseFunnelAlerts(body.alerts, prev?.alerts);
  if ("error" in alerts) return alerts;
  return { name, steps, windowSeconds, ordered: b.ordered === undefined ? true : (b.ordered as boolean), alerts };
}

// --- Storage --------------------------------------------------------------------------------------------------------

export interface FunnelRow {
  id: string;
  app_id: string;
  name: string;
  definition: string;
  alerts: string | null;
  created_at: number;
  updated_at: number;
}

/** Stored alert settings (NULL: the defaults). */
export function funnelAlertsOf(json: string | null): FunnelAlertSettings {
  const r = parseFunnelAlerts(parseJson<unknown>(json, null));
  return "error" in r ? DEFAULT_FUNNEL_ALERTS : r;
}

export function toFunnel(r: FunnelRow): Funnel {
  const d = parseJson<Partial<FunnelDefinition>>(r.definition, {});
  return {
    id: r.id,
    appId: r.app_id,
    name: r.name,
    steps: d.steps ?? [],
    windowSeconds: d.windowSeconds ?? 7 * 86_400,
    ordered: d.ordered ?? true,
    alerts: funnelAlertsOf(r.alerts),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const definitionJson = (d: FunnelDefinition) => JSON.stringify({ steps: d.steps, windowSeconds: d.windowSeconds, ordered: d.ordered });

export async function listFunnels(db: Db, workspaceId: string, appId: string): Promise<Funnel[]> {
  const { results } = await db.prepare("SELECT * FROM funnels WHERE app_id = ? AND workspace_id = ? ORDER BY created_at").bind(appId, workspaceId).all<FunnelRow>();
  return results.map(toFunnel);
}

export async function getFunnel(db: Db, workspaceId: string, appId: string, id: string): Promise<Funnel | null> {
  const r = await db.prepare("SELECT * FROM funnels WHERE id = ? AND app_id = ? AND workspace_id = ?").bind(id, appId, workspaceId).first<FunnelRow>();
  return r ? toFunnel(r) : null;
}

export async function createFunnel(db: Db, workspaceId: string, appId: string, body: unknown): Promise<{ funnel: Funnel } | { error: string; status: 400 | 409 }> {
  const d = parseFunnel(body);
  if ("error" in d) return { error: d.error, status: 400 };
  const count = await db.prepare("SELECT COUNT(*) AS n FROM funnels WHERE app_id = ?").bind(appId).first<{ n: number }>();
  if ((count?.n ?? 0) >= FUNNEL_LIMITS.funnelsPerApp) return { error: `At most ${FUNNEL_LIMITS.funnelsPerApp} funnels per app`, status: 409 };
  const t = now();
  const row: FunnelRow = { id: newId("fn_"), app_id: appId, name: d.name, definition: definitionJson(d), alerts: JSON.stringify(d.alerts), created_at: t, updated_at: t };
  await db
    .prepare("INSERT INTO funnels (id, workspace_id, app_id, name, definition, alerts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(row.id, workspaceId, appId, row.name, row.definition, row.alerts, t, t)
    .run();
  return { funnel: toFunnel(row) };
}

export async function updateFunnel(db: Db, workspaceId: string, appId: string, id: string, body: unknown): Promise<{ funnel: Funnel } | { error: string; status: 400 | 404 }> {
  const old = await getFunnel(db, workspaceId, appId, id);
  if (!old) return { error: "Not found", status: 404 };
  const d = parseFunnel(body, old);
  if ("error" in d) return { error: d.error, status: 400 };
  const t = Math.max(now(), old.updatedAt + 1);
  await db.prepare("UPDATE funnels SET name = ?, definition = ?, alerts = ?, updated_at = ? WHERE id = ?").bind(d.name, definitionJson(d), JSON.stringify(d.alerts), t, id).run();
  return { funnel: { ...old, ...d, updatedAt: t } };
}

export async function deleteFunnel(db: Db, workspaceId: string, appId: string, id: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM funnels WHERE id = ? AND app_id = ? AND workspace_id = ?").bind(id, appId, workspaceId).run();
  return r.meta.changes > 0;
}

// --- Computation ----------------------------------------------------------------------------------------------------

/** Per install: first / last time (ms) of a step, how many times it happened, breakdown value (first step). */
export interface StepHit {
  first: number;
  last: number;
  n: number;
  b?: string;
}
export type StepData = Map<string, StepHit>;
/** Event steps: their data. Revenue steps: a lookup for the installs still in the funnel. */
export type StepSource = StepData | ((installs: string[]) => Promise<StepData>);

export interface ComputedStep {
  users: number;
  /** Milliseconds from the previous step (ordered) or the first step (unordered), per converted install. */
  deltas: number[];
}

export interface ComputedFunnel {
  steps: ComputedStep[];
  groups: Map<string, ComputedStep[]>;
  /** Installs whose step time had to be inferred (first before the anchor, last after it, more than two times). */
  inferred: number;
}

export const NO_VALUE = "(none)";

/** Walks every install of the first step through the steps (see the top of this file). */
export async function computeFunnel(sources: StepSource[], opts: { windowMs: number; ordered: boolean }): Promise<ComputedFunnel> {
  const first = sources[0];
  if (!(first instanceof Map)) throw new Error("The first step must be an event step");
  const empty = (): ComputedStep[] => sources.map(() => ({ users: 0, deltas: [] }));
  const steps = empty();
  const groups = new Map<string, ComputedStep[]>();
  // Installs still in the funnel: install → { t0, prev }.
  let alive = new Map<string, { t0: number; prev: number; group: string }>();
  for (const [install, hit] of first) alive.set(install, { t0: hit.first, prev: hit.first, group: hit.b ?? NO_VALUE });
  const count = (k: number, group: string, delta: number | null) => {
    let g = groups.get(group);
    if (!g) groups.set(group, (g = empty()));
    for (const s of [steps[k], g[k]]) {
      s.users++;
      if (delta !== null) s.deltas.push(delta);
    }
  };
  for (const a of alive.values()) count(0, a.group, null);
  let inferred = 0;
  for (let k = 1; k < sources.length; k++) {
    if (!alive.size) break;
    const src = sources[k];
    const data = src instanceof Map ? src : await src([...alive.keys()]);
    const next = new Map<string, { t0: number; prev: number; group: string }>();
    for (const [install, a] of alive) {
      const hit = data.get(install);
      if (!hit) continue;
      const anchor = opts.ordered ? a.prev : a.t0;
      const deadline = a.t0 + opts.windowMs;
      let t: number;
      let guessed = false;
      if (hit.first >= anchor) t = hit.first;
      else if (hit.last >= anchor) {
        t = hit.last;
        guessed = hit.n > 2;
      } else continue;
      if (t > deadline) {
        // Inferred times are upper bounds: an earlier occurrence might fit the window. Counted as not converted.
        if (guessed) inferred++;
        continue;
      }
      if (guessed) inferred++;
      next.set(install, { ...a, prev: t });
      count(k, a.group, t - anchor);
    }
    alive = next;
  }
  return { steps, groups, inferred };
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function stepLabel(s: FunnelStep): string {
  if (s.label) return s.label;
  if (s.type === "revenue") return { trial_started: "Trial started", paid: "Paid", any_purchase: "Purchase" }[s.kind];
  return s.filters?.length ? `${s.name} (${s.filters.map((f) => `${f.key}=${f.value}`).join(", ")})` : s.name;
}

export function reportSteps(funnel: { steps: FunnelStep[] }, computed: ComputedStep[]): FunnelReportStep[] {
  const top = computed[0]?.users ?? 0;
  return computed.map((s, i) => {
    const prev = i ? computed[i - 1].users : s.users;
    const med = median(s.deltas);
    return {
      index: i,
      label: stepLabel(funnel.steps[i]),
      users: s.users,
      conversionFromPrevious: i === 0 ? 1 : prev ? s.users / prev : 0,
      conversionFromFirst: top ? s.users / top : 0,
      dropOff: i === 0 ? 0 : prev - s.users,
      medianSecondsFromPrevious: i === 0 || med === null ? null : Math.round(med / 1000),
    };
  });
}

// --- Revenue steps --------------------------------------------------------------------------------------------------

const KIND_SQL: Record<RevenueStepKind, string> = {
  trial_started: "t.kind = 'trial'",
  paid: "t.kind != 'trial' AND t.gross_usd > 0",
  any_purchase: "1 = 1",
};

/** Purchases of installs (install_links → transactions), first / last time per install. ≤ 90 ids per statement. */
export const revenueStepData = defineDbFunction(
  "funnels.revenue",
  async (db, args: { appId: string; installs: string[]; kind: RevenueStepKind; fromMs: number; toMs: number }): Promise<[string, StepHit][]> => {
    const kind = KIND_SQL[args.kind];
    if (!kind) throw new Error("Unknown revenue step");
    const out: [string, StepHit][] = [];
    const ids = args.installs.slice(0, REVENUE_INSTALL_CAP);
    for (let i = 0; i < ids.length; i += REVENUE_CHUNK) {
      const chunk = ids.slice(i, i + REVENUE_CHUNK);
      const { results } = await db
        .prepare(
          `SELECT l.install_id AS install, MIN(t.purchased_at) AS first, MAX(t.purchased_at) AS last, COUNT(*) AS n
           FROM install_links l JOIN transactions t ON t.app_id = l.app_id AND t.original_transaction_id = l.original_transaction_id
           WHERE l.app_id = ? AND l.install_id IN (${chunk.map(() => "?").join(",")}) AND t.purchased_at >= ? AND t.purchased_at < ? AND ${kind}
           GROUP BY l.install_id`,
        )
        .bind(args.appId, ...chunk, args.fromMs, args.toMs)
        .all<{ install: string; first: number; last: number; n: number }>();
      for (const r of results) out.push([r.install, { first: r.first, last: r.last, n: r.n }]);
    }
    return out;
  },
);

// --- Report ---------------------------------------------------------------------------------------------------------

const reportCache = new Map<string, { report: FunnelReport; expires: number }>();
const REPORT_TTL_MS = 5 * 60_000;

export function resetFunnelCache() {
  reportCache.clear();
}

export interface ReportArgs {
  from: string;
  to: string;
  breakdown: FunnelBreakdown | null;
  /** Production data from other devices than the app's test ones unless includeTest (part of the report cache key). */
  test?: TestFilter;
}

const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** Validates ?from&to (entry dates, UTC, inclusive) or ?range=Nd (default 30d) and ?breakdown. */
export function parseReportQuery(q: { from?: string; to?: string; range?: string; breakdown?: string }, at = now()): ReportArgs | Fail {
  const today = new Date(at).toISOString().slice(0, 10);
  const re = /^\d{4}-\d{2}-\d{2}$/;
  let to = q.to || today;
  let from: string;
  if (q.from) from = q.from;
  else {
    const m = /^(\d{1,3})d$/.exec(q.range || "30d");
    if (!m) return { error: "range must be a number of days such as 7d, 30d or 90d" };
    from = new Date(dayMs(to) - (Number(m[1]) - 1) * DAY_MS).toISOString().slice(0, 10);
  }
  if (!re.test(from) || !re.test(to) || Number.isNaN(dayMs(from)) || Number.isNaN(dayMs(to))) return { error: "from and to must be YYYY-MM-DD" };
  if (to > today) to = today;
  if (from > to) return { error: "from is after to" };
  if ((dayMs(to) - dayMs(from)) / DAY_MS + 1 > MAX_RANGE_DAYS) return { error: `At most ${MAX_RANGE_DAYS} days (Analytics Engine keeps events 3 months)` };
  const oldest = new Date(at - (MAX_RANGE_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  if (from < oldest) from = oldest;
  let breakdown: FunnelBreakdown | null = null;
  if (q.breakdown && q.breakdown !== "none") {
    if (!(FUNNEL_BREAKDOWNS as readonly string[]).includes(q.breakdown)) return { error: `breakdown must be one of ${FUNNEL_BREAKDOWNS.join(", ")}` };
    breakdown = q.breakdown as FunnelBreakdown;
  }
  return { from, to, breakdown };
}

export function toStepData(rows: Record<string, unknown>[]): { data: StepData; sampled: number } {
  const data: StepData = new Map();
  let sampled = 1;
  for (const r of rows) {
    const install = typeof r.install === "string" ? r.install : "";
    if (!install) continue;
    sampled = Math.max(sampled, num(r.si) || 1);
    data.set(install, { first: num(r.first), last: num(r.last), n: num(r.n), ...(r.b !== undefined ? { b: String(r.b ?? "") || NO_VALUE } : {}) });
  }
  return { data, sampled };
}

const MAX_GROUPS = 10;

/** GET /apps/:id/funnels/:fid/report. */
export async function funnelReport(env: Env, funnel: Funnel, args: ReportArgs, opts: { origin?: string } = {}): Promise<FunnelReport> {
  const key = JSON.stringify([funnel.id, funnel.updatedAt, args]);
  const hit = reportCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.report;

  const windowMs = funnel.windowSeconds * 1000;
  const fromMs = dayMs(args.from);
  const entryTo = Math.min(dayMs(args.to) + DAY_MS, now());
  // Round the end to 5 minutes: the same report asked again hits the query cache.
  const endMs = Math.ceil(Math.min(entryTo + windowMs, now()) / 300_000) * 300_000;
  const entryEnd = Math.ceil(entryTo / 300_000) * 300_000;
  const notes: string[] = [];
  let sampled = 1;
  const capNote = (i: number) => `Step ${i + 1} had more than ${STEP_INSTALL_CAP.toLocaleString("en-US")} installs: the first ${STEP_INSTALL_CAP.toLocaleString("en-US")} (by time) were used.`;
  const exact: FunnelStepsResult = await funnelStepsExact(env, {
    appId: funnel.appId,
    steps: funnel.steps.map((s, i) => (s.type === "event" ? { name: s.name, filters: s.filters, fromMs, toMs: i === 0 ? entryEnd : endMs, breakdown: i === 0 ? args.breakdown : null } : null)),
    fromDay: args.from,
    toDay: new Date(Math.max(fromMs, endMs - 1)).toISOString().slice(0, 10),
    limit: STEP_INSTALL_CAP + 1,
    test: args.test,
    breakdown: args.breakdown,
  }).catch((err): FunnelStepsResult => {
    console.error("exact funnel steps failed", err);
    return { exact: false, note: null };
  });
  let eventData: (StepData | null)[];
  if (exact.exact) {
    eventData = exact.steps.map((rows, i) => {
      if (!rows) return null;
      if (rows.length > STEP_INSTALL_CAP) notes.push(capNote(i));
      return new Map(rows.slice(0, STEP_INSTALL_CAP));
    });
  } else {
    if (exact.note) notes.push(exact.note);
    const { dataset } = analyticsConfig(env);
    const queries = funnel.steps.map((s, i) =>
      s.type === "event"
        ? runSql(env, stepSql(dataset, { appId: funnel.appId, name: s.name, filters: s.filters, fromMs, toMs: i === 0 ? entryEnd : endMs, breakdown: i === 0 ? args.breakdown : null, limit: STEP_INSTALL_CAP + 1, test: args.test }), opts).then(
            (rows) => {
              if (rows.length > STEP_INSTALL_CAP) notes.push(capNote(i));
              const r = toStepData(rows.slice(0, STEP_INSTALL_CAP));
              sampled = Math.max(sampled, r.sampled);
              return r.data;
            },
          )
        : null,
    );
    eventData = await Promise.all(queries);
  }
  const sources: StepSource[] = funnel.steps.map((s, i) => {
    if (s.type === "event") return eventData[i]!;
    return async (installs: string[]) => {
      if (installs.length > REVENUE_INSTALL_CAP) notes.push(`Step ${i + 1} (revenue) was checked for the first ${REVENUE_INSTALL_CAP.toLocaleString("en-US")} installs only.`);
      const rows = await revenueStepData(env, { appId: funnel.appId, installs: installs.slice(0, REVENUE_INSTALL_CAP), kind: s.kind, fromMs, toMs: endMs });
      return new Map(rows);
    };
  });
  const computed = await computeFunnel(sources, { windowMs, ordered: funnel.ordered });
  if (sampled > 1) notes.push(`Analytics Engine sampled this app's events (1 stored event stands for up to ${sampled}): user counts are lower than the real ones, conversion rates stay close.`);
  if (computed.inferred) notes.push(`${computed.inferred} install${computed.inferred === 1 ? "" : "s"} repeated a step before and after the previous one: the step time was inferred from its last occurrence.`);

  const groups = args.breakdown ? [...computed.groups.entries()].sort((a, b) => b[1][0].users - a[1][0].users) : [];
  const top = groups.slice(0, MAX_GROUPS).map(([value, s]) => ({ value, steps: reportSteps(funnel, s) }));
  if (groups.length > MAX_GROUPS) {
    const other = funnel.steps.map(() => ({ users: 0, deltas: [] as number[] }));
    for (const [, s] of groups.slice(MAX_GROUPS))
      s.forEach((x, k) => {
        other[k].users += x.users;
        other[k].deltas.push(...x.deltas);
      });
    top.push({ value: "(other)", steps: reportSteps(funnel, other) });
  }
  const report: FunnelReport = {
    funnel,
    from: args.from,
    to: args.to,
    breakdown: args.breakdown,
    steps: reportSteps(funnel, computed.steps),
    groups: top,
    approximate: notes.length > 0,
    source: exact.exact ? "exact" : "sampled",
    notes,
    includeTest: !!args.test?.includeTest,
    generatedAt: now(),
  };
  if (reportCache.size >= 200) reportCache.delete(reportCache.keys().next().value!);
  reportCache.set(key, { report, expires: Date.now() + REPORT_TTL_MS });
  return report;
}
