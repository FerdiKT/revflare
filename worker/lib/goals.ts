// Goals: targets for a metric over a period (week / month / quarter / year, rolling, or custom dates) on all apps, a
// selection of apps or all apps but some. Progress is read from daily_metrics / workspace_daily (never transactions):
// one query per distinct app set, and the days before today come from a per-day base cached inside the database object
// (invalidated when a past day changes, `data_past:<ws>`), so a recompute after a sale reads only today's rows.
// Reached goals with `notify` push once per period (checkGoalPushes, from the cron).

import { GOAL_METRICS, GOAL_PERIODS, GOAL_SCOPES, type GoalInput, type GoalMetric, type GoalPeriod, type GoalProgress, type GoalScope } from "../../shared/types";
import { backgroundAllowed, metered } from "./budget";
import { defineDbFunction, type Db } from "./db";
import { addDays, dayOf, dayStart } from "./money";
import { dailyRows, goalsList, type DayRow } from "./metrics";
import { formatMoney, pushToWorkspace, type SendBudget } from "./push";
import { now, parseJson } from "./util";

export const GOAL_NAME_MAX = 60;
/** Goals per workspace. */
export const GOALS_MAX = 100;
/** Longest custom period (days): bounds the rows a goal reads. */
export const CUSTOM_MAX_DAYS = 731;

export const GOAL_METRIC_INFO: Record<GoalMetric, { label: string; money: boolean; kind: "flow" | "stock"; value: (r: DayRow) => number }> = {
  revenue: { label: "Revenue", money: true, kind: "flow", value: (r) => r.gross_usd },
  proceeds: { label: "Proceeds", money: true, kind: "flow", value: (r) => r.proceeds_usd },
  mrr: { label: "MRR", money: true, kind: "stock", value: (r) => r.mrr_usd },
  new_subscriptions: { label: "New subscriptions", money: false, kind: "flow", value: (r) => r.new_subscriptions },
  trials_started: { label: "Trials started", money: false, kind: "flow", value: (r) => r.trials_started },
  active_subscriptions: { label: "Active subscriptions", money: false, kind: "stock", value: (r) => r.active_subscriptions },
  sales: { label: "Sales", money: false, kind: "flow", value: (r) => r.new_subscriptions + r.renewals + r.one_time_purchases },
};

export interface GoalRow {
  id: string;
  workspace_id: string;
  name: string | null;
  metric: GoalMetric;
  period: GoalPeriod;
  target_usd: number;
  app_id: string | null;
  scope: GoalScope;
  app_ids: string;
  start_day: string | null;
  end_day: string | null;
  archived: number;
  notify: number;
  sort_order: number;
  created_at: number;
  notified_period: string | null;
}

export const GOAL_COLUMNS = "id, workspace_id, name, metric, period, target_usd, app_id, scope, app_ids, start_day, end_day, archived, notify, sort_order, created_at, notified_period";

/** Scope and app list of a row (rows written before migration 0025 by an older object: app_id = one included app). */
export function rowScope(g: Pick<GoalRow, "scope" | "app_ids" | "app_id">): { scope: GoalScope; appIds: string[] } {
  const ids = parseJson<string[]>(g.app_ids, []).filter((x) => typeof x === "string");
  if (g.scope === "include" || g.scope === "exclude") return { scope: g.scope, appIds: ids };
  if (g.app_id) return { scope: "include", appIds: [g.app_id] };
  return { scope: "all", appIds: [] };
}

// Periods ------------------------------------------------------------------------------------------------------------

export interface Bounds {
  start: string;
  end: string;
  label: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((dayStart(b) - dayStart(a)) / 86_400_000);

/** ISO week label of a Monday ("2026-W44"). */
export function isoWeekLabel(monday: string): string {
  const thursday = addDays(monday, 3);
  const year = Number(thursday.slice(0, 4));
  const week = Math.floor(daysBetween(`${year}-01-01`, thursday) / 7) + 1;
  return `${year}-W${pad(week)}`;
}

/** The period of a goal that contains `day` (custom: its dates). Weeks start on Monday; all days are UTC. */
export function periodBounds(period: GoalPeriod, day: string, custom?: { start: string | null; end: string | null }): Bounds {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  switch (period) {
    case "week": {
      const dow = (new Date(dayStart(day)).getUTCDay() + 6) % 7;
      const start = addDays(day, -dow);
      return { start, end: addDays(start, 6), label: isoWeekLabel(start) };
    }
    case "quarter": {
      const q = Math.floor((m - 1) / 3);
      return { start: `${y}-${pad(q * 3 + 1)}-01`, end: lastDayOf(y, q * 3 + 3), label: `${y}-Q${q + 1}` };
    }
    case "year":
      return { start: `${y}-01-01`, end: `${y}-12-31`, label: String(y) };
    case "custom": {
      const start = custom?.start ?? day;
      const end = custom?.end ?? start;
      return { start, end, label: `${start}..${end}` };
    }
    default:
      return { start: `${day.slice(0, 7)}-01`, end: lastDayOf(y, m), label: day.slice(0, 7) };
  }
}

/** The period before `cur` (rolling periods only). */
export function previousBounds(period: GoalPeriod, cur: Bounds): Bounds | null {
  return period === "custom" ? null : periodBounds(period, addDays(cur.start, -1));
}

export function currentBounds(g: Pick<GoalRow, "period" | "start_day" | "end_day">, today: string): Bounds {
  return periodBounds(g.period, today, { start: g.start_day, end: g.end_day });
}

// Progress (pure) ----------------------------------------------------------------------------------------------------

export interface GoalNumbers {
  status: GoalProgress["status"];
  daysTotal: number;
  daysElapsed: number;
  daysLeft: number;
  current: number;
  startValue: number | null;
  progress: number;
  projected: number;
  expected: number;
  delta: number;
  pace: GoalProgress["pace"];
  requiredPerDay: number | null;
  reachedAt: string | null;
}

/**
 * Progress of a goal over `b` as of `today`, from a daily series (`value(day)`: the day's flow, or the end-of-day level
 * for a stock metric). Same units as `target`.
 */
export function goalNumbers(kind: "flow" | "stock", target: number, b: Bounds, today: string, value: (day: string) => number): GoalNumbers {
  const daysTotal = daysBetween(b.start, b.end) + 1;
  const status: GoalNumbers["status"] = today < b.start ? "upcoming" : today > b.end ? "ended" : "active";
  const daysElapsed = status === "upcoming" ? 0 : status === "ended" ? daysTotal : daysBetween(b.start, today) + 1;
  const daysLeft = status === "upcoming" ? daysTotal : status === "ended" ? 0 : daysBetween(today, b.end);
  const last = today < b.end ? today : b.end;
  let current = 0;
  let reachedAt: string | null = null;
  let startValue: number | null = null;
  if (kind === "flow") {
    for (let d = b.start; d <= last; d = addDays(d, 1)) {
      current += value(d);
      if (!reachedAt && target > 0 && current >= target - 1e-9) reachedAt = d;
    }
  } else {
    startValue = value(addDays(b.start, -1));
    current = value(last);
    for (let d = b.start; d <= last; d = addDays(d, 1)) {
      if (target > 0 && value(d) >= target - 1e-9) {
        reachedAt = d;
        break;
      }
    }
  }
  const share = daysElapsed / daysTotal;
  const projected = kind === "stock" ? current : status === "active" ? (current / Math.max(1, daysElapsed)) * daysTotal : current;
  const base = kind === "stock" ? (startValue ?? 0) : 0;
  const expected = base + (target - base) * share;
  const reached = current >= target - 1e-9;
  const pace: GoalNumbers["pace"] =
    status === "upcoming"
      ? "upcoming"
      : reached
        ? "reached"
        : status === "ended"
          ? "missed"
          : (kind === "flow" ? projected >= target : current >= expected)
            ? "on_track"
            : "behind";
  // Remaining days, today included (today's sales still count).
  const remainingDays = status === "upcoming" ? daysTotal : daysLeft + 1;
  const requiredPerDay = status === "ended" ? null : reached ? 0 : (target - current) / Math.max(1, remainingDays);
  return { status, daysTotal, daysElapsed, daysLeft, current, startValue, progress: target ? current / target : 0, projected, expected, delta: current - expected, pace, requiredPerDay, reachedAt };
}

// Reading ------------------------------------------------------------------------------------------------------------

/** Rows of the days before today, per workspace, app set and range: rebuilt when a past day changes or the UTC day does. */
const baseCache = new Map<string, Map<string, DayRow>>();

/** Marks the workspace's past days changed (rollups that rewrite days before today, imports, refunds, settings). */
export const PAST_VERSION_KEY = (workspaceId: string) => `data_past:${workspaceId}`;

const IDS_PER_QUERY = 90;

async function loadRows(db: Db, workspaceId: string, appIds: string[] | null, from: string, to: string): Promise<Map<string, DayRow>> {
  const out = new Map<string, DayRow>();
  if (from > to) return out;
  // Durable Object SQLite binds at most 100 parameters: large app sets are read in chunks and summed.
  const chunks = appIds === null ? [null] : Array.from({ length: Math.ceil(appIds.length / IDS_PER_QUERY) }, (_, i) => appIds.slice(i * IDS_PER_QUERY, (i + 1) * IDS_PER_QUERY));
  for (const chunk of chunks) {
    if (chunk && !chunk.length) continue;
    const { rows } = await dailyRows(db, { workspaceId, appIds: chunk }, from, to, { byApp: true });
    for (const r of rows) {
      const cur = out.get(r.day);
      if (!cur) out.set(r.day, { ...r });
      else for (const k of Object.keys(r) as (keyof DayRow)[]) if (k !== "day") (cur[k] as number) += r[k] as number;
    }
  }
  return out;
}

/** Daily rows of an app set over [from, to] (to ≤ today): the cached base for past days, today's rows read fresh. */
async function setRows(db: Db, workspaceId: string, setKey: string, appIds: string[] | null, from: string, to: string, today: string, pastVersion: string) {
  const yesterday = addDays(today, -1);
  const baseTo = to < yesterday ? to : yesterday;
  const key = `${workspaceId}|${setKey}|${from}|${baseTo}|${today}|${pastVersion}`;
  let base = baseCache.get(key);
  if (!base) {
    for (const k of baseCache.keys()) if (k.startsWith(`${workspaceId}|${setKey}|`)) baseCache.delete(k);
    base = await loadRows(db, workspaceId, appIds, from, baseTo);
    baseCache.set(key, base);
    if (baseCache.size > 100) baseCache.delete(baseCache.keys().next().value!);
  }
  if (to < today) return base;
  const rows = new Map(base);
  for (const [d, r] of await loadRows(db, workspaceId, appIds, today, today)) rows.set(d, r);
  return rows;
}

/** Forgets the cached bases (tests). */
export function resetGoalCache() {
  baseCache.clear();
}

function scopeLabel(scope: GoalScope, appIds: string[], names: Map<string, string>): string {
  if (scope === "all") return "All apps";
  const known = appIds.filter((id) => names.has(id));
  if (scope === "include") return !known.length ? "No apps" : known.length === 1 ? names.get(known[0])! : `${known.length} apps`;
  if (!known.length) return "All apps";
  return known.length === 1 ? `All apps except ${names.get(known[0])}` : `All apps except ${known.length}`;
}

/**
 * Progress of the workspace's goals (in the workspace currency at `rate`), independent of any app filter. One query
 * per distinct app set (and per 90 apps of it).
 */
export async function computeGoals(db: Db, workspaceId: string, rate: number, opts: { archived?: boolean } = {}): Promise<GoalProgress[]> {
  const { results: goals } = await db
    .prepare(`SELECT ${GOAL_COLUMNS} FROM goals WHERE workspace_id = ?${opts.archived ? "" : " AND archived = 0"} ORDER BY sort_order, created_at`)
    .bind(workspaceId)
    .all<GoalRow>();
  if (!goals.length) return [];
  const today = dayOf(now());
  const { results: apps } = await db.prepare("SELECT id, name FROM apps WHERE workspace_id = ?").bind(workspaceId).all<{ id: string; name: string }>();
  const names = new Map(apps.map((a) => [a.id, a.name]));
  const past = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(PAST_VERSION_KEY(workspaceId)).first<{ value: string }>();
  const pastVersion = past?.value ?? "0";

  type Plan = { g: GoalRow; scope: GoalScope; ids: string[]; setKey: string; set: string[] | null; cur: Bounds; prev: Bounds | null; from: string; to: string };
  const plans: Plan[] = goals.map((g) => {
    const { scope, appIds } = rowScope(g);
    const ids = appIds.filter((id) => names.has(id));
    // exclude resolves now, so apps added later count.
    const set = scope === "all" || (scope === "exclude" && !ids.length) ? null : scope === "include" ? [...ids].sort() : apps.map((a) => a.id).filter((id) => !ids.includes(id)).sort();
    const cur = currentBounds(g, today);
    const prev = previousBounds(g.period, cur);
    const to = cur.end < today ? cur.end : today;
    let from = addDays((prev ?? cur).start, -1);
    if (from > to) from = to;
    return { g, scope, ids, set, setKey: set === null ? "*" : set.join(","), cur, prev, from, to };
  });
  const sets = new Map<string, { set: string[] | null; from: string; to: string }>();
  for (const p of plans) {
    const s = sets.get(p.setKey);
    if (!s) sets.set(p.setKey, { set: p.set, from: p.from, to: p.to });
    else {
      if (p.from < s.from) s.from = p.from;
      if (p.to > s.to) s.to = p.to;
    }
  }
  const rowsBySet = new Map<string, Map<string, DayRow>>();
  for (const [k, s] of sets) rowsBySet.set(k, s.set && !s.set.length ? new Map() : await setRows(db, workspaceId, k, s.set, s.from, s.to, today, pastVersion));

  return plans.map(({ g, scope, ids, setKey, cur, prev }) => {
    const info = GOAL_METRIC_INFO[g.metric] ?? GOAL_METRIC_INFO.revenue;
    const rows = rowsBySet.get(setKey)!;
    const value = (d: string) => {
      const r = rows.get(d);
      return r ? info.value(r) : 0;
    };
    const n = goalNumbers(info.kind, g.target_usd, cur, today, value);
    let previous: GoalProgress["previous"] = null;
    if (prev) {
      const p = goalNumbers(info.kind, g.target_usd, prev, today, value);
      previous = { periodStart: prev.start, periodEnd: prev.end, periodLabel: prev.label, value: p.current, reached: p.current >= g.target_usd - 1e-9 };
    }
    const k = info.money ? rate : 1;
    const money = (v: number) => v * k;
    return {
      id: g.id,
      name: g.name,
      label: g.name || `${info.label} · ${scopeLabel(scope, ids, names)}`,
      metric: g.metric,
      format: info.money ? "money" : "count",
      kind: info.kind,
      period: g.period,
      startDate: g.period === "custom" ? g.start_day : null,
      endDate: g.period === "custom" ? g.end_day : null,
      target: money(g.target_usd),
      scope,
      appIds: ids,
      appId: scope === "include" && ids.length === 1 ? ids[0] : null,
      archived: !!g.archived,
      notify: !!g.notify,
      sortOrder: g.sort_order,
      createdAt: g.created_at,
      periodStart: cur.start,
      periodEnd: cur.end,
      periodLabel: cur.label,
      status: n.status,
      daysTotal: n.daysTotal,
      daysElapsed: n.daysElapsed,
      daysLeft: n.daysLeft,
      current: money(n.current),
      startValue: n.startValue === null ? null : money(n.startValue),
      progress: n.progress,
      projected: money(n.projected),
      expected: money(n.expected),
      delta: money(n.delta),
      pace: n.pace,
      requiredPerDay: n.requiredPerDay === null ? null : money(n.requiredPerDay),
      reachedAt: n.reachedAt,
      previous: previous && { ...previous, value: money(previous.value) },
    };
  });
}

// Validation ---------------------------------------------------------------------------------------------------------

const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && dayOf(Date.parse(s)) === s;

export interface GoalValues {
  name: string | null;
  metric: GoalMetric;
  target: number;
  period: GoalPeriod;
  startDate: string | null;
  endDate: string | null;
  scope: GoalScope;
  appIds: string[];
  archived: boolean;
  notify: boolean;
}

/**
 * Merges a create / update body over `base` (an existing goal, or the defaults) and validates it. App ids are checked
 * against the workspace by the caller (`unknownApps`). Targets stay in the workspace currency here.
 */
export function parseGoalInput(body: GoalInput & Record<string, unknown>, base: GoalValues | null): { value: GoalValues } | { error: string } {
  const v: GoalValues = base
    ? { ...base, appIds: [...base.appIds] }
    : { name: null, metric: "revenue", target: 0, period: "month", startDate: null, endDate: null, scope: "all", appIds: [], archived: false, notify: false };
  if ("name" in body) {
    if (body.name !== null && body.name !== undefined && typeof body.name !== "string") return { error: "name must be a string" };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length > GOAL_NAME_MAX) return { error: `name is limited to ${GOAL_NAME_MAX} characters` };
    v.name = name || null;
  }
  if (body.metric !== undefined) {
    if (!GOAL_METRICS.includes(body.metric as GoalMetric)) return { error: `metric must be one of ${GOAL_METRICS.join(", ")}` };
    v.metric = body.metric as GoalMetric;
  } else if (!base) return { error: `metric is required (${GOAL_METRICS.join(", ")})` };
  if (body.target !== undefined) {
    const t = Number(body.target);
    if (!Number.isFinite(t) || !(t > 0) || t > 1e12) return { error: "target must be a positive number" };
    v.target = t;
  } else if (!base) return { error: "a positive target is required" };
  if (body.period !== undefined) {
    if (!GOAL_PERIODS.includes(body.period as GoalPeriod)) return { error: `period must be one of ${GOAL_PERIODS.join(", ")}` };
    v.period = body.period as GoalPeriod;
  }
  if (body.startDate !== undefined) v.startDate = body.startDate;
  if (body.endDate !== undefined) v.endDate = body.endDate;
  if (v.period === "custom") {
    if (!isDay(v.startDate) || !isDay(v.endDate)) return { error: "a custom period needs startDate and endDate (YYYY-MM-DD)" };
    if (v.endDate < v.startDate) return { error: "endDate must not be before startDate" };
    if (daysBetween(v.startDate, v.endDate) + 1 > CUSTOM_MAX_DAYS) return { error: `a custom period is limited to ${CUSTOM_MAX_DAYS} days` };
  } else {
    v.startDate = null;
    v.endDate = null;
  }
  if (body.scope !== undefined) {
    if (!GOAL_SCOPES.includes(body.scope as GoalScope)) return { error: `scope must be one of ${GOAL_SCOPES.join(", ")}` };
    v.scope = body.scope as GoalScope;
    if (v.scope === "all") v.appIds = [];
  } else if ("appId" in body) {
    // Older clients: one app or all apps.
    if (typeof body.appId === "string" && body.appId) {
      v.scope = "include";
      v.appIds = [body.appId];
    } else {
      v.scope = "all";
      v.appIds = [];
    }
  }
  if (body.appIds !== undefined) {
    if (!Array.isArray(body.appIds) || body.appIds.some((x) => typeof x !== "string" || !x)) return { error: "appIds must be a list of app ids" };
    v.appIds = [...new Set(body.appIds as string[])];
  }
  // An existing goal whose apps were all deleted stays editable (rename, archive...) until its apps are changed.
  const appsGiven = !base || body.scope !== undefined || body.appIds !== undefined || "appId" in body;
  if (v.scope === "all") v.appIds = [];
  else if (!v.appIds.length && appsGiven) return { error: v.scope === "include" ? "pick at least one app" : "pick at least one app to exclude" };
  if (v.appIds.length > 200) return { error: "too many apps" };
  if (body.archived !== undefined) {
    if (typeof body.archived !== "boolean") return { error: "archived must be true or false" };
    v.archived = body.archived;
  }
  if (body.notify !== undefined) {
    if (typeof body.notify !== "boolean") return { error: "notify must be true or false" };
    v.notify = body.notify;
  }
  return { value: v };
}

/** Ids of `appIds` that are not apps of the workspace. */
export async function unknownApps(db: Db, workspaceId: string, appIds: string[]): Promise<string[]> {
  const known = new Set<string>();
  for (let i = 0; i < appIds.length; i += IDS_PER_QUERY) {
    const chunk = appIds.slice(i, i + IDS_PER_QUERY);
    const { results } = await db
      .prepare(`SELECT id FROM apps WHERE workspace_id = ? AND id IN (${chunk.map(() => "?").join(",")})`)
      .bind(workspaceId, ...chunk)
      .all<{ id: string }>();
    for (const r of results) known.add(r.id);
  }
  return appIds.filter((id) => !known.has(id));
}

/**
 * The stored values of a goal row, with the target in the workspace currency. `known`: the workspace's apps (ids of
 * deleted apps are dropped).
 */
export function rowValues(g: GoalRow, rate: number, known?: Set<string>): GoalValues {
  const { scope, appIds: stored } = rowScope(g);
  const appIds = known ? stored.filter((id) => known.has(id)) : stored;
  const money = (GOAL_METRIC_INFO[g.metric] ?? GOAL_METRIC_INFO.revenue).money;
  return {
    name: g.name,
    metric: g.metric,
    target: money ? g.target_usd * rate : g.target_usd,
    period: g.period,
    startDate: g.start_day,
    endDate: g.end_day,
    scope,
    appIds,
    archived: !!g.archived,
    notify: !!g.notify,
  };
}

/** Same app set (order and duplicates do not matter). */
export function sameAppSet(a: string[], b: string[]): boolean {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((id, i) => id === y[i]);
}

/**
 * Whether a target sent back by a client is the stored one: clients show the target converted at today's rate (and
 * may round it to cents), so a difference within that rounding is no change.
 */
export function sameTarget(sent: number, stored: number): boolean {
  const diff = Math.abs(sent - stored);
  return diff < 0.005 || diff < Math.abs(stored) * 1e-6;
}

// Reached pushes -----------------------------------------------------------------------------------------------------

/** Workspaces checked per run. */
const PUSH_WORKSPACES_PER_RUN = 10;
/** APNs requests per run (one per device and goal): the cron tick shares the subrequest limit. */
const PUSH_REQUESTS_PER_RUN = 20;
/** Where the last run stopped: the next one starts after it, so every workspace is checked in turn. */
const PUSH_CURSOR_KEY = "goal_push_cursor";
/** A goal reached in the last check gap of a period (its last minutes) still notifies during the next period's first hour. */
const LATE_WINDOW_MS = 3_600_000;

type PushRow = Pick<GoalRow, "id" | "workspace_id" | "period" | "start_day" | "end_day" | "notified_period" | "created_at">;

/**
 * Pushes "goal reached" for goals with `notify` reached in their current period, once per period (goals
 * .notified_period = the period's first day). During the first hour of a UTC day, a goal whose period ended yesterday
 * (the previous period of a rolling goal, or a custom one) and was reached but not notified is pushed too: it was
 * reached after the last check of that period. Reads the notify goals (index), then the workspace's cached goal list
 * (one settings row when nothing changed). Metered as background work; at most 10 workspaces a run, taken in turn
 * after the previous run's last one; at most 20 pushes a run.
 */
export const checkGoalPushes = defineDbFunction("checkGoalPushes", async (db, args: { at?: number }, env) => {
  if (!(await backgroundAllowed(db, env))) return { budget: true, sent: 0 };
  return metered(db, async () => {
    const { results } = await db
      .prepare("SELECT id, workspace_id, period, start_day, end_day, notified_period, created_at FROM goals WHERE notify = 1 AND archived = 0 LIMIT 1000")
      .all<PushRow>();
    const at = args.at ?? now();
    const today = dayOf(at);
    const yesterday = addDays(today, -1);
    const todayStart = dayStart(today);
    const late = at - todayStart < LATE_WINDOW_MS;
    const pending = new Map<string, Map<string, PushRow>>();
    for (const g of results) {
      const b = currentBounds(g, today);
      const active = today >= b.start && today <= b.end && g.notified_period !== b.start;
      // Rolling goals in their first day are pending through `active` (the new period is not notified yet).
      const endedLate = late && g.period === "custom" && b.end === yesterday && g.notified_period !== b.start && g.created_at < todayStart;
      if (!active && !endedLate) continue;
      if (!pending.has(g.workspace_id)) pending.set(g.workspace_id, new Map());
      pending.get(g.workspace_id)!.set(g.id, g);
    }
    // Rotate: the workspaces after the previous run's last one first, then from the start.
    const order = [...pending.keys()].sort();
    let batch = order;
    if (order.length > PUSH_WORKSPACES_PER_RUN) {
      const cursor = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(PUSH_CURSOR_KEY).first<{ value: string }>();
      const start = cursor ? order.findIndex((id) => id > cursor.value) : 0;
      const from = start < 0 ? 0 : start;
      batch = [...order.slice(from), ...order.slice(0, from)].slice(0, PUSH_WORKSPACES_PER_RUN);
    }
    let left = PUSH_REQUESTS_PER_RUN;
    const budget: SendBudget = {
      take(n = 1) {
        if (n > left) return false;
        left -= n;
        return true;
      },
    };
    let sent = 0;
    let checked = 0;
    let last: string | null = null;
    run: for (const workspaceId of batch) {
      if (left <= 0) break;
      checked++;
      last = workspaceId;
      const rows = pending.get(workspaceId)!;
      const { currency, items } = await goalsList(env, { workspaceId });
      for (const g of items) {
        const row = rows.get(g.id);
        if (!row) continue;
        const reached: { periodStart: string; value: number }[] = [];
        // The period that ended yesterday, reached in its last minutes (checked first: the current one can follow).
        if (late && row.created_at < todayStart && row.notified_period !== g.periodStart) {
          if (g.period === "custom") {
            if (g.status === "ended" && g.periodEnd === yesterday && g.pace === "reached") reached.push({ periodStart: g.periodStart, value: g.current });
          } else if (g.previous?.reached && g.previous.periodEnd === yesterday && row.notified_period !== g.previous.periodStart) {
            reached.push({ periodStart: g.previous.periodStart, value: g.previous.value });
          }
        }
        if (g.status === "active" && g.pace === "reached") reached.push({ periodStart: g.periodStart, value: g.current });
        for (const r of reached) {
          // Out of pushes: the rest waits for the next run (not marked).
          if (left <= 0) break run;
          const mark = await db
            .prepare("UPDATE goals SET notified_period = ? WHERE id = ? AND (notified_period IS NULL OR notified_period != ?)")
            .bind(r.periodStart, g.id, r.periodStart)
            .run();
          if (!mark.meta.changes) continue;
          const fmt = (v: number) => (g.format === "money" ? formatMoney(v, currency) : String(Math.round(v)));
          await pushToWorkspace(
            env,
            db,
            workspaceId,
            {
              kind: "goal",
              appId: null,
              titleKey: g.name ? "PUSH_TITLE_GOAL" : `PUSH_TITLE_GOAL_${g.metric.toUpperCase()}`,
              titleArgs: g.name ? [g.name] : [],
              bodyKey: "PUSH_BODY_GOAL_REACHED",
              bodyArgs: [fmt(r.value), fmt(g.target)],
              threadId: "goals",
              data: { goalId: g.id },
            },
            budget,
          );
          sent++;
        }
      }
    }
    if (order.length > PUSH_WORKSPACES_PER_RUN && last) {
      await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(PUSH_CURSOR_KEY, last).run();
    }
    return { pending: pending.size, checked, sent };
  });
});
