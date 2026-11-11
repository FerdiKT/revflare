// Read side: overview, charts, breakdowns, feed, customers, at-risk revenue, forecast, cohorts. Runs inside the
// database object. Everything is computed in USD and converted to the workspace's reporting currency at today's rate.

import { alertExperimentId, alertFunnelId } from "./alert-store";
import { COUNTRY_NAMES, flag } from "../../shared/countries";
import { OFFER_TYPE_LABELS, QUICK_ACTION_MS } from "../../shared/types";
import type {
  AdsAttribution,
  AtRisk,
  Breakdown,
  Chart,
  Cohorts,
  Customer,
  CustomerEvent,
  CustomerTiming,
  Forecast,
  GoalProgress,
  Interval,
  Kpi,
  Metric,
  MetricFormat,
  MrrMovement,
  Overview,
  Page,
  Point,
  Series,
  Subscription,
  Transaction,
} from "../../shared/types";
import { customerAttribution, toAdsAttribution, TX_ATTRIBUTION_COLUMNS, TX_ATTRIBUTION_JOINS, TX_INSTALL_JOINS, TX_SOURCE_SQL, type AttributionCols } from "./ads-names";
import { defineDbFunction, type Db } from "./db";
import { computeGoals, PAST_VERSION_KEY } from "./goals";
import { rebuildQueued } from "./rollup";
import { FxCache, addDays, dayOf, dayStart, keptShareSql, periodMonths, refundedShareSql } from "./money";
import { base64url, fromBase64url, now } from "./util";

/** Share of a transaction (alias t) kept after refunds / refunded (prorated refunds count in part). */
const KEPT = keptShareSql("t");
const REFUNDED = refundedShareSql("t");

const DAY = 86_400_000;

export interface Scope {
  workspaceId: string;
  appIds?: string[] | null;
  currency?: string;
}

export type DayRow = {
  day: string;
  gross_usd: number;
  proceeds_usd: number;
  refunds_usd: number;
  refunds: number;
  new_subscriptions: number;
  renewals: number;
  one_time_purchases: number;
  trials_started: number;
  trial_conversions: number;
  new_customers: number;
  new_payers: number;
  active_subscriptions: number;
  active_trials: number;
  mrr_usd: number;
  mrr_proceeds_usd: number;
  mrr_new: number;
  mrr_expansion: number;
  mrr_contraction: number;
  mrr_churn: number;
  mrr_reactivation: number;
  churned_subscriptions: number;
};

const SUM_COLUMNS: (keyof DayRow)[] = [
  "gross_usd",
  "proceeds_usd",
  "refunds_usd",
  "refunds",
  "new_subscriptions",
  "renewals",
  "one_time_purchases",
  "trials_started",
  "trial_conversions",
  "new_customers",
  "new_payers",
  "active_subscriptions",
  "active_trials",
  "mrr_usd",
  "mrr_proceeds_usd",
  "mrr_new",
  "mrr_expansion",
  "mrr_contraction",
  "mrr_churn",
  "mrr_reactivation",
  "churned_subscriptions",
];

export const METRIC_INFO: Record<Metric, { label: string; format: MetricFormat; kind: "flow" | "stock" | "rate"; money: boolean }> = {
  revenue: { label: "Revenue", format: "money", kind: "flow", money: true },
  proceeds: { label: "Proceeds", format: "money", kind: "flow", money: true },
  mrr: { label: "MRR", format: "money", kind: "stock", money: true },
  mrr_proceeds: { label: "MRR (net)", format: "money", kind: "stock", money: true },
  arr: { label: "ARR", format: "money", kind: "stock", money: true },
  active_subscriptions: { label: "Active subscriptions", format: "count", kind: "stock", money: false },
  active_trials: { label: "Active trials", format: "count", kind: "stock", money: false },
  new_subscriptions: { label: "New subscriptions", format: "count", kind: "flow", money: false },
  renewals: { label: "Renewals", format: "count", kind: "flow", money: false },
  one_time_purchases: { label: "One-time purchases", format: "count", kind: "flow", money: false },
  trials_started: { label: "Trials started", format: "count", kind: "flow", money: false },
  trial_conversions: { label: "Trial conversions", format: "count", kind: "flow", money: false },
  trial_conversion_rate: { label: "Trial conversion rate", format: "percent", kind: "rate", money: false },
  refunds: { label: "Refunds", format: "count", kind: "flow", money: false },
  refunds_amount: { label: "Refunded amount", format: "money", kind: "flow", money: true },
  refund_rate: { label: "Refund rate", format: "percent", kind: "rate", money: false },
  churn_rate: { label: "Churn rate", format: "percent", kind: "rate", money: false },
  churned_subscriptions: { label: "Churned subscriptions", format: "count", kind: "flow", money: false },
  new_customers: { label: "New customers", format: "count", kind: "flow", money: false },
  arppu: { label: "Revenue per subscriber", format: "money", kind: "rate", money: true },
};

function appClause(scope: Scope, column = "app_id"): { sql: string; params: string[] } {
  if (!scope.appIds?.length) return { sql: "", params: [] };
  return { sql: ` AND ${column} IN (${scope.appIds.map(() => "?").join(",")})`, params: scope.appIds };
}

export async function workspaceCurrency(db: Db, scope: Scope): Promise<{ currency: string; rate: number }> {
  await ensureFresh(db, scope.workspaceId);
  let currency = scope.currency;
  if (!currency) {
    const ws = await db.prepare("SELECT currency FROM workspaces WHERE id = ?").bind(scope.workspaceId).first<{ currency: string }>();
    currency = ws?.currency ?? "USD";
  }
  const rate = await new FxCache(db).perUsd(currency, dayOf(now()));
  return { currency: currency.toUpperCase(), rate };
}

/** Rebuilds the workspace's apps whose transactions changed since their last rollup, so reads are never stale. */
async function ensureFresh(db: Db, workspaceId: string) {
  const { results } = await db
    .prepare("SELECT q.app_id FROM rollup_queue q JOIN apps a ON a.id = q.app_id WHERE a.workspace_id = ? LIMIT 20")
    .bind(workspaceId)
    .all<{ app_id: string }>();
  for (const r of results) await rebuildQueued(db, r.app_id);
}

// Read cache: results are kept in memory (inside the database object) until the workspace's data version changes
// (rollups and settings bump it) or the UTC day changes. Polling apps and widgets then cost one row read.
const readCache = new Map<string, { version: string; value: unknown }>();
/** Slow-moving values cached for the UTC day (renewal forecast in the overview). */
const dayCache = new Map<string, unknown>();

/** Marks the workspace's cached reads stale (after changes that are not transactions: goals, currency, apps). */
export async function bumpDataVersion(db: Db, workspaceId: string) {
  // Past days may have changed too (refunds, currency, imports): the goals' cached bases are rebuilt.
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?), (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(`data_version:${workspaceId}`, String(now()), PAST_VERSION_KEY(workspaceId), String(now()))
    .run();
}

async function cachedRead<T>(db: Db, workspaceId: string, name: string, args: unknown, compute: () => Promise<T>): Promise<T> {
  await ensureFresh(db, workspaceId);
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(`data_version:${workspaceId}`).first<{ value: string }>();
  const version = `${row?.value ?? "0"}|${dayOf(now())}`;
  const key = `${name}:${JSON.stringify(args)}`;
  const hit = readCache.get(key);
  if (hit && hit.version === version) {
    readCache.delete(key);
    readCache.set(key, hit);
    return hit.value as T;
  }
  const value = await compute();
  readCache.set(key, { version, value });
  if (readCache.size > 300) readCache.delete(readCache.keys().next().value!);
  return value;
}

/** A database function whose results are cached per workspace data version. */
export function cachedFn<A extends Scope, R>(name: string, fn: (db: Db, args: A) => Promise<R>) {
  return defineDbFunction(name, (db, args: A) => cachedRead(db, args.workspaceId, name, args, () => fn(db, args)));
}

const EXTERNAL_COLUMNS = ["revenue", "proceeds", "mrr", "active_subscriptions", "active_trials", "new_customers", "new_subscriptions", "trials_started", "refunds", "churned_subscriptions"];

const emptyRow = (day: string): DayRow => Object.fromEntries([["day", day], ...SUM_COLUMNS.map((c) => [c, 0])]) as DayRow;

/**
 * The apps' rows summed per day: read as they are and added up here (a GROUP BY's temporary b-tree reads each row
 * twice). Rows of another workspace never count, whatever ids are passed (`+workspace_id`: a filter only, so the
 * (app_id, day) key drives the read, not idx_daily_ws). At most 97 ids (100 parameters).
 */
async function appDayRows(db: Db, workspaceId: string, appIds: string[], from: string, to: string): Promise<{ results: DayRow[] }> {
  const { results } = await db
    .prepare(`SELECT day, ${SUM_COLUMNS.join(", ")} FROM daily_metrics WHERE app_id IN (${appIds.map(() => "?").join(",")}) AND day >= ? AND day <= ? AND +workspace_id = ?`)
    .bind(...appIds, from, to, workspaceId)
    .all<DayRow>();
  const byDay = new Map<string, DayRow>();
  for (const r of results) {
    const cur = byDay.get(r.day);
    if (!cur) byDay.set(r.day, { ...r });
    else for (const c of SUM_COLUMNS) (cur[c] as number) += r[c] as number;
  }
  return { results: [...byDay.values()] };
}

/**
 * Daily totals of the scope for [from, to] (every day present, imported history merged in). `byApp`: read a selection
 * of apps through the (app_id, day) key, so only their rows are read (the ids must be apps of the workspace).
 */
export async function dailyRows(db: Db, scope: Scope, from: string, to: string, opts: { byApp?: boolean } = {}): Promise<{ rows: DayRow[]; importedUntil: string | null }> {
  const f = appClause(scope);
  // The whole workspace reads its precomputed totals (one row a day); a selection of apps sums their rows.
  const { results } = f.sql
    ? opts.byApp
      ? await appDayRows(db, scope.workspaceId, f.params, from, to)
      : await db
          .prepare(
            `SELECT day, ${SUM_COLUMNS.map((c) => `SUM(${c}) AS ${c}`).join(", ")} FROM daily_metrics
             WHERE workspace_id = ? AND day >= ? AND day <= ?${f.sql} GROUP BY day`,
          )
          .bind(scope.workspaceId, from, to, ...f.params)
          .all<DayRow>()
    : await db
        .prepare(`SELECT day, ${SUM_COLUMNS.join(", ")} FROM workspace_daily WHERE workspace_id = ? AND day >= ? AND day <= ?`)
        .bind(scope.workspaceId, from, to)
        .all<DayRow>();
  const byDay = new Map(results.map((r) => [r.day, r]));
  // Imported history (RevenueCat Charts) for the days before each app's own history is complete.
  let importedUntil: string | null = null;
  const fa = appClause(scope, "id");
  const { results: extApps } = await db
    .prepare(
      `SELECT id, external_until, COALESCE(history_backfilled_from, (SELECT MIN(day) FROM daily_metrics d WHERE d.app_id = apps.id), '9999') AS cutoff
       FROM apps WHERE workspace_id = ? AND external_until IS NOT NULL AND external_until >= ?${fa.sql}`,
    )
    .bind(scope.workspaceId, from, ...fa.params)
    .all<{ id: string; external_until: string; cutoff: string }>();
  const ext: { app_id: string; metric: string; day: string; value: number }[] = [];
  for (const a of extApps) {
    const until = [a.external_until, addDays(a.cutoff.slice(0, 10) === "9999" ? "9999-12-30" : a.cutoff, -1), to].sort()[0];
    if (until < from) continue;
    const { results } = await db
      .prepare(
        `SELECT metric, day, value FROM external_metrics WHERE app_id = ? AND source = 'revenuecat'
         AND metric IN (${EXTERNAL_COLUMNS.map(() => "?").join(",")}) AND day >= ? AND day <= ?`,
      )
      .bind(a.id, ...EXTERNAL_COLUMNS, from, until)
      .all<{ metric: string; day: string; value: number }>();
    for (const r of results) ext.push({ app_id: a.id, ...r });
  }
  if (ext.length) {
    // Replace the app's own (incomplete) values on those days with the imported ones.
    const appDays = new Map<string, Set<string>>();
    for (const e of ext) {
      if (!appDays.has(e.app_id)) appDays.set(e.app_id, new Set());
      appDays.get(e.app_id)!.add(e.day);
    }
    for (const [appId, days] of appDays) {
      const { results: own } = await db
        .prepare(`SELECT ${["day", ...SUM_COLUMNS].join(", ")} FROM daily_metrics WHERE app_id = ? AND day >= ? AND day <= ?`)
        .bind(appId, from, to)
        .all<DayRow>();
      for (const o of own) {
        if (!days.has(o.day)) continue;
        const r = byDay.get(o.day);
        if (r) for (const c of SUM_COLUMNS) (r[c] as number) -= o[c] as number;
      }
    }
    const map: Record<string, keyof DayRow> = {
      revenue: "gross_usd",
      proceeds: "proceeds_usd",
      mrr: "mrr_usd",
      active_subscriptions: "active_subscriptions",
      active_trials: "active_trials",
      new_customers: "new_customers",
      new_subscriptions: "new_subscriptions",
      trials_started: "trials_started",
      refunds: "refunds",
      churned_subscriptions: "churned_subscriptions",
    };
    for (const e of ext) {
      const col = map[e.metric];
      if (!col) continue;
      let r = byDay.get(e.day);
      if (!r) byDay.set(e.day, (r = emptyRow(e.day)));
      (r[col] as number) += e.value;
      if (!importedUntil || e.day > importedUntil) importedUntil = e.day;
    }
  }
  const rows: DayRow[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) rows.push(byDay.get(d) ?? emptyRow(d));
  return { rows, importedUntil };
}

function bucketOf(day: string, interval: Interval): string {
  if (interval === "day") return day;
  if (interval === "month") return day.slice(0, 7) + "-01";
  const d = new Date(dayStart(day));
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return addDays(day, -dow);
}

/** Metric value of a set of consecutive day rows (+ the state just before them, for churn). */
function metricValue(metric: Metric, rows: DayRow[], before: DayRow | null): number {
  if (!rows.length) return 0;
  const sum = (c: keyof DayRow) => rows.reduce((s, r) => s + (r[c] as number), 0);
  const last = rows[rows.length - 1];
  switch (metric) {
    case "revenue":
      return sum("gross_usd");
    case "proceeds":
      return sum("proceeds_usd");
    case "mrr":
      return last.mrr_usd;
    case "mrr_proceeds":
      return last.mrr_proceeds_usd;
    case "arr":
      return last.mrr_usd * 12;
    case "active_subscriptions":
      return last.active_subscriptions;
    case "active_trials":
      return last.active_trials;
    case "new_subscriptions":
      return sum("new_subscriptions");
    case "renewals":
      return sum("renewals");
    case "one_time_purchases":
      return sum("one_time_purchases");
    case "trials_started":
      return sum("trials_started");
    case "trial_conversions":
      return sum("trial_conversions");
    case "trial_conversion_rate": {
      const t = sum("trials_started");
      return t ? sum("trial_conversions") / t : 0;
    }
    case "refunds":
      return sum("refunds");
    case "refunds_amount":
      return sum("refunds_usd");
    case "refund_rate": {
      const sales = sum("new_subscriptions") + sum("renewals") + sum("one_time_purchases");
      return sales ? sum("refunds") / sales : 0;
    }
    case "churn_rate": {
      const base = (before ?? rows[0]).active_subscriptions;
      return base ? sum("churned_subscriptions") / base : 0;
    }
    case "churned_subscriptions":
      return sum("churned_subscriptions");
    case "new_customers":
      return sum("new_customers");
    case "arppu": {
      const subs = last.active_subscriptions;
      return subs ? sum("gross_usd") / subs : 0;
    }
  }
}

function bucketize(rows: DayRow[], interval: Interval): { date: string; rows: DayRow[] }[] {
  const out: { date: string; rows: DayRow[] }[] = [];
  for (const r of rows) {
    const b = bucketOf(r.day, interval);
    const cur = out[out.length - 1];
    if (cur && cur.date === b) cur.rows.push(r);
    else out.push({ date: b, rows: [r] });
  }
  return out;
}

const convert = (metric: Metric, v: number, rate: number) => (METRIC_INFO[metric].money ? v * rate : v);

export interface ChartArgs extends Scope {
  metric: Metric;
  from: string;
  to: string;
  interval?: Interval;
  groupBy?: "app" | "country" | "product" | null;
}

export async function chartLocal(db: Db, args: ChartArgs): Promise<Chart> {
  const info = METRIC_INFO[args.metric];
  if (!info) throw new Error(`Unknown metric ${args.metric}`);
  const interval = args.interval ?? "day";
  const { currency, rate } = await workspaceCurrency(db, args);
  const span = Math.round((dayStart(args.to) - dayStart(args.from)) / DAY) + 1;
  const prevFrom = addDays(args.from, -span);
  // One extra day before `from` gives the churn base of the first bucket.
  const { rows: all, importedUntil } = await dailyRows(db, args, addDays(prevFrom, -1), args.to);
  const prevRows = all.slice(1, span + 1);
  const rows = all.slice(span + 1);
  const buckets = bucketize(rows, interval);
  const points: Point[] = [];
  let prev: DayRow | null = all[span] ?? null;
  for (const b of buckets) {
    points.push({ date: b.date, value: convert(args.metric, metricValue(args.metric, b.rows, prev), rate) });
    prev = b.rows[b.rows.length - 1];
  }
  const chart: Chart = {
    metric: args.metric,
    format: info.format,
    currency,
    interval,
    from: args.from,
    to: args.to,
    points,
    total: convert(args.metric, metricValue(args.metric, rows, all[span] ?? null), rate),
    previousTotal: convert(args.metric, metricValue(args.metric, prevRows, all[0] ?? null), rate),
    importedUntil: importedUntil && importedUntil >= args.from ? importedUntil : null,
  };
  if (args.groupBy) chart.series = await groupedSeries(db, args, interval, rate);
  return chart;
}

async function groupedSeries(db: Db, args: ChartArgs, interval: Interval, rate: number): Promise<Series[]> {
  const metric = args.metric;
  const groups = new Map<string, { label: string; byDay: Map<string, DayRow> }>();
  if (args.groupBy === "app") {
    const f = appClause(args, "d.app_id");
    const { results } = await db
      .prepare(
        `SELECT d.*, a.name AS label FROM daily_metrics d JOIN apps a ON a.id = d.app_id
         WHERE d.workspace_id = ? AND d.day >= ? AND d.day <= ?${f.sql}`,
      )
      .bind(args.workspaceId, args.from, args.to, ...f.params)
      .all<DayRow & { app_id: string; label: string }>();
    for (const r of results) {
      if (!groups.has(r.app_id)) groups.set(r.app_id, { label: r.label, byDay: new Map() });
      groups.get(r.app_id)!.byDay.set(r.day, r);
    }
  } else {
    // Country / product: flow metrics straight from transactions.
    const col = args.groupBy === "country" ? "t.country" : "t.product_id";
    const f = appClause(args, "t.app_id");
    const { results } = await db
      .prepare(
        `SELECT ${col} AS k, strftime('%Y-%m-%d', t.purchased_at / 1000, 'unixepoch') AS day,
           SUM(t.gross_usd * ${KEPT}) AS gross_usd,
           SUM(t.proceeds_usd * ${KEPT}) AS proceeds_usd,
           SUM(t.kind IN ('new', 'conversion')) AS new_subscriptions, SUM(t.kind = 'renewal') AS renewals,
           SUM(t.kind = 'one_time') AS one_time_purchases, SUM(t.kind = 'trial') AS trials_started,
           SUM(t.kind = 'conversion') AS trial_conversions, SUM(t.refunded_at IS NOT NULL) AS refunds,
           SUM(t.gross_usd * ${REFUNDED}) AS refunds_usd,
           MAX(p.name) AS pname
         FROM transactions t LEFT JOIN products p ON p.app_id = t.app_id AND p.product_id = t.product_id
         WHERE t.workspace_id = ? AND t.environment = 'Production' AND t.purchased_at >= ? AND t.purchased_at < ?${f.sql}
         GROUP BY k, day`,
      )
      .bind(args.workspaceId, dayStart(args.from), dayStart(args.to) + DAY, ...f.params)
      .all<Partial<DayRow> & { k: string | null; day: string; pname: string | null }>();
    for (const r of results) {
      const key = r.k ?? "unknown";
      const label = args.groupBy === "country" ? (r.k ? `${flag(r.k)} ${COUNTRY_NAMES[r.k] ?? r.k}` : "Unknown") : (r.pname ?? key);
      if (!groups.has(key)) groups.set(key, { label, byDay: new Map() });
      groups.get(key)!.byDay.set(r.day, { ...emptyRow(r.day), ...r } as DayRow);
    }
  }
  const series: Series[] = [];
  for (const [key, g] of groups) {
    const rows: DayRow[] = [];
    for (let d = args.from; d <= args.to; d = addDays(d, 1)) rows.push(g.byDay.get(d) ?? emptyRow(d));
    const points = bucketize(rows, interval).map((b) => ({ date: b.date, value: convert(metric, metricValue(metric, b.rows, null), rate) }));
    series.push({ key, label: g.label, points, total: convert(metric, metricValue(metric, rows, null), rate) });
  }
  series.sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
  if (series.length <= 8) return series;
  const top = series.slice(0, 7);
  const rest = series.slice(7);
  const other: Series = {
    key: "other",
    label: `Other (${rest.length})`,
    points: top[0].points.map((p, i) => ({ date: p.date, value: rest.reduce((s, r) => s + (r.points[i]?.value ?? 0), 0) })),
    total: rest.reduce((s, r) => s + (r.total ?? 0), 0),
  };
  return [...top, other];
}

export const chart = cachedFn("chart", chartLocal);

export const mrrMovement = cachedFn("mrrMovement", async (db, args: Scope & { from: string; to: string; interval?: Interval }): Promise<MrrMovement> => {
  const { currency, rate } = await workspaceCurrency(db, args);
  const interval = args.interval ?? "month";
  const { rows } = await dailyRows(db, args, args.from, args.to);
  return {
    currency,
    interval,
    points: bucketize(rows, interval).map((b) => {
      const s = (c: keyof DayRow) => b.rows.reduce((t, r) => t + (r[c] as number), 0) * rate;
      const p = { new: s("mrr_new"), expansion: s("mrr_expansion"), contraction: s("mrr_contraction"), churn: s("mrr_churn"), reactivation: s("mrr_reactivation") };
      return { date: b.date, ...p, net: p.new + p.expansion + p.reactivation - p.contraction - p.churn, mrr: b.rows[b.rows.length - 1].mrr_usd * rate };
    }),
  };
});

export const breakdown = cachedFn(
  "breakdown",
  async (db, args: Scope & { metric: Metric; by: "app" | "country" | "product"; from: string; to: string; limit?: number }): Promise<Breakdown> => {
    const { currency, rate } = await workspaceCurrency(db, args);
    const stock = ["mrr", "active_subscriptions", "active_trials", "arr"].includes(args.metric);
    let rows: { key: string; label: string; value: number; iconUrl?: string | null; appId?: string }[] = [];
    if (stock) {
      const col = args.by === "app" ? "s.app_id" : args.by === "country" ? "s.country" : "s.product_id";
      const valueSql =
        args.metric === "active_trials"
          ? "SUM(s.status = 'trial')"
          : args.metric === "active_subscriptions"
            ? "SUM(s.status IN ('active', 'grace'))"
            : `SUM(s.mrr_usd)${args.metric === "arr" ? " * 12" : ""}`;
      const f = appClause(args, "s.app_id");
      const { results } = await db
        .prepare(
          `SELECT ${col} AS k, ${valueSql} AS v, MAX(a.name) AS app_name, MAX(a.icon_url) AS icon, MAX(p.name) AS pname, MAX(s.app_id) AS app_id
           FROM subscriptions s JOIN apps a ON a.id = s.app_id LEFT JOIN products p ON p.app_id = s.app_id AND p.product_id = s.product_id
           WHERE s.workspace_id = ? AND s.environment = 'Production' AND s.status IN ('active', 'grace', 'trial')${f.sql} GROUP BY k`,
        )
        .bind(args.workspaceId, ...f.params)
        .all<{ k: string | null; v: number; app_name: string; icon: string | null; pname: string | null; app_id: string }>();
      rows = results.map((r) => ({
        key: r.k ?? "unknown",
        label: args.by === "app" ? r.app_name : args.by === "country" ? (r.k ? `${flag(r.k)} ${COUNTRY_NAMES[r.k] ?? r.k}` : "Unknown") : (r.pname ?? r.k ?? "Unknown"),
        value: convert(args.metric, r.v, rate),
        ...(args.by === "app" ? { iconUrl: r.icon, appId: r.app_id } : {}),
      }));
    } else {
      const c = await chartLocal(db, { ...args, interval: "month", groupBy: args.by });
      const icons = new Map<string, string | null>();
      if (args.by === "app") {
        const { results } = await db.prepare("SELECT id, icon_url FROM apps WHERE workspace_id = ?").bind(args.workspaceId).all<{ id: string; icon_url: string | null }>();
        for (const a of results) icons.set(a.id, a.icon_url);
      }
      rows = (c.series ?? []).map((s) => ({ key: s.key, label: s.label, value: s.total ?? 0, ...(args.by === "app" && s.key !== "other" ? { iconUrl: icons.get(s.key) ?? null, appId: s.key } : {}) }));
    }
    rows = rows.filter((r) => r.value).sort((a, b) => b.value - a.value);
    const total = rows.reduce((s, r) => s + r.value, 0);
    return {
      metric: args.metric,
      by: args.by,
      currency,
      from: args.from,
      to: args.to,
      rows: rows.slice(0, args.limit ?? 50).map((r) => ({ ...r, share: total ? r.value / total : 0 })),
    };
  },
);

// Feed ---------------------------------------------------------------------------------------------------------------

const txSelect = (extra = "") => `SELECT t.id, t.app_id, a.name AS app_name, a.icon_url, t.customer_id, t.transaction_id, t.original_transaction_id, t.product_id,
  p.name AS product_name, t.kind, t.purchased_at, t.expires_at, t.gross_usd, t.proceeds_usd, t.price_milli, t.quantity, t.currency, t.country,
  t.environment, t.refunded_at, t.refund_milli, t.offer_discount_type, t.offer_type, t.offer_id, t.source, t.store, ${TX_ATTRIBUTION_COLUMNS}${extra}
  FROM transactions t JOIN apps a ON a.id = t.app_id LEFT JOIN products p ON p.app_id = t.app_id AND p.product_id = t.product_id
  ${TX_ATTRIBUTION_JOINS}`;
const TX_SELECT = txSelect();

/** Auto-renew turned off: App Store DID_CHANGE_RENEWAL_STATUS / AUTO_RENEW_DISABLED, Google Play SUBSCRIPTION_CANCELED (events alias `e`; the exact predicate of idx_events_cancel). */
const CANCEL_EVENT_SQL = `((e.type = 'DID_CHANGE_RENEWAL_STATUS' AND e.subtype = 'AUTO_RENEW_DISABLED') OR e.type = 'SUBSCRIPTION_CANCELED')`;

/**
 * Feed timing columns, read for the page's rows only (each a primary-key / per-subscription probe, evaluated only when
 * it can matter): the install time of the row's install; whether the row is the customer's first purchase / trial
 * (customers.first_seen_at is the earliest purchase time); for subscription rows, the first time auto-renew was turned
 * off within this row's period (one seek in idx_events_cancel_original, which holds cancellations only).
 */
const TX_TIMING_COLUMNS = `,
  COALESCE(at.installed_at, at.created_at) AS at_installed_at,
  CASE WHEN at.install_id IS NOT NULL AND t.customer_id IS NOT NULL AND t.kind IN ('trial', 'new', 'one_time')
    THEN t.purchased_at <= (SELECT first_seen_at FROM customers WHERE id = t.customer_id) END AS first_purchase,
  CASE WHEN t.kind != 'one_time'
    THEN (SELECT MIN(e.signed_at) FROM events e WHERE e.app_id = t.app_id AND e.original_transaction_id = t.original_transaction_id AND ${CANCEL_EVENT_SQL}
      AND e.signed_at >= t.purchased_at AND e.signed_at < COALESCE(t.expires_at, ${Number.MAX_SAFE_INTEGER})) END AS cancel_at`;

type TimingCols = { at_installed_at: number | null; first_purchase: number | null; cancel_at: number | null };

/** Whether a duration (ms) is "quick" (QUICK_ACTION_MS, inclusive). */
export const isQuick = (ms: number | null | undefined) => typeof ms === "number" && ms >= 0 && ms <= QUICK_ACTION_MS;

/** Adds sinceInstallMs / cancelledAfterMs / quick to a feed row from its timing columns. */
function withTiming(tx: Transaction, r: TimingCols): Transaction {
  const sinceInstall = r.first_purchase && r.at_installed_at !== null && tx.purchasedAt >= r.at_installed_at ? tx.purchasedAt - r.at_installed_at : null;
  const cancelledAfter = r.cancel_at !== null && r.cancel_at !== undefined ? r.cancel_at - tx.purchasedAt : null;
  tx.sinceInstallMs = sinceInstall;
  tx.cancelledAfterMs = cancelledAfter;
  tx.quick = isQuick(sinceInstall) || isQuick(cancelledAfter);
  return tx;
}

type TxRow = AttributionCols & {
  id: string;
  app_id: string;
  app_name: string;
  icon_url: string | null;
  customer_id: string | null;
  transaction_id: string;
  original_transaction_id: string;
  product_id: string;
  product_name: string | null;
  kind: Transaction["kind"];
  purchased_at: number;
  expires_at: number | null;
  gross_usd: number;
  proceeds_usd: number;
  price_milli: number;
  quantity: number;
  currency: string | null;
  country: string | null;
  environment: string;
  refunded_at: number | null;
  refund_milli: number | null;
  offer_discount_type: string | null;
  offer_type: number | null;
  offer_id: string | null;
  source: string;
  store: string;
};

/** "free trial" (introductory), "win-back", "promotional (pay as you go)", "offer code"... */
export function offerLabel(type: number | null, discount: string | null): string | null {
  const d = discount ? discount.toLowerCase().replace(/_/g, " ") : null;
  if (type && type >= 2 && type <= 4) {
    const t = OFFER_TYPE_LABELS[type].toLowerCase();
    return d ? `${t} (${d})` : t;
  }
  return d ?? (type ? "offer" : null);
}

function toTransaction(r: TxRow, rate: number): Transaction {
  const offer = offerLabel(r.offer_type, r.offer_discount_type);
  return {
    id: r.id,
    appId: r.app_id,
    appName: r.app_name,
    appIconUrl: r.icon_url,
    customerId: r.customer_id,
    transactionId: r.transaction_id,
    originalTransactionId: r.original_transaction_id,
    productId: r.product_id,
    productName: r.product_name,
    kind: r.kind,
    purchasedAt: r.purchased_at,
    expiresAt: r.expires_at,
    price: r.gross_usd * rate,
    storeCurrency: r.currency,
    storePrice: (r.price_milli / 1000) * Math.max(1, r.quantity),
    proceeds: r.proceeds_usd * rate,
    country: r.country,
    environment: r.environment,
    refundedAt: r.refunded_at,
    refundPercentage: r.refunded_at ? (r.refund_milli ?? 100_000) / 1000 : null,
    offer,
    offerType: r.offer_type,
    offerId: r.offer_id,
    source: r.source,
    store: r.store,
    attribution: toAdsAttribution(r),
  };
}

/** Rows looked at per feed request with a source filter (the page holds the matches among them). */
export const SOURCE_SCAN = 500;

export const transactions = defineDbFunction(
  "transactions",
  async (
    db,
    args: Scope & {
      limit?: number;
      cursor?: string | null;
      kinds?: string[];
      country?: string | null;
      environment?: "Production" | "Sandbox" | "all";
      q?: string | null;
      refunded?: boolean;
      productId?: string | null;
      /** Upcoming: renewals Apple already announced whose period starts later (oldest first). */
      upcoming?: boolean;
      /** Minutes east of UTC for the day groups (`days`), e.g. 180 for Istanbul. */
      tzOffset?: number;
      /** Acquisition of the purchase's install (AdsAttribution.source). */
      source?: AdsAttribution["source"] | null;
      /** Quick rows only: bought within QUICK_ACTION_MS of the install, or cancelled within QUICK_ACTION_MS of the purchase. */
      quick?: boolean;
      /** The cancellations stream (auto-renew turned off) instead of the transactions. */
      cancellations?: boolean;
    },
  ): Promise<Page<Transaction> & { currency: string; days: FeedDay[] }> => {
    if (args.cancellations) return cancellationsFeed(db, args);
    const { rate, currency } = await workspaceCurrency(db, args);
    const where = ["t.workspace_id = ?"];
    const params: unknown[] = [args.workspaceId];
    const f = appClause(args, "t.app_id");
    if (f.sql) {
      where.push(f.sql.replace(/^ AND /, ""));
      params.push(...f.params);
    }
    const env = args.environment ?? "Production";
    if (env !== "all") {
      where.push("t.environment = ?");
      params.push(env);
    }
    if (args.kinds?.length) {
      where.push(`t.kind IN (${args.kinds.map(() => "?").join(",")})`);
      params.push(...args.kinds);
    }
    if (args.country) {
      where.push("t.country = ?");
      params.push(args.country.toUpperCase());
    }
    if (args.productId) {
      where.push("t.product_id = ?");
      params.push(args.productId);
    }
    if (args.refunded) where.push("t.refunded_at IS NOT NULL");
    if (args.q) {
      where.push("(t.transaction_id = ? OR t.original_transaction_id = ? OR t.customer_id = ?)");
      params.push(args.q, args.q, args.q);
    }
    // Renewals arrive before their period starts: they are "upcoming" until then and never in the day totals.
    const t = now();
    const filterSql = where.join(" AND ");
    const filterParams = [...params];
    where.push(args.upcoming ? "t.purchased_at > ?" : "t.purchased_at <= ?");
    params.push(t);
    const desc = !args.upcoming;
    if (args.cursor) {
      const [at, id] = new TextDecoder().decode(fromBase64url(args.cursor)).split("|");
      where.push(desc ? "(t.purchased_at < ? OR (t.purchased_at = ? AND t.id < ?))" : "(t.purchased_at > ? OR (t.purchased_at = ? AND t.id > ?))");
      params.push(Number(at), Number(at), id);
    }
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const order = desc ? "t.purchased_at DESC, t.id DESC" : "t.purchased_at ASC, t.id ASC";
    // Source filter: the acquisition is joined per row (install_links and attributions by primary key), so the walk
    // down idx_tx_ws_time is bounded: at most SOURCE_SCAN rows per request. When they hold fewer than a page of
    // matches, the page is short (possibly empty) and the cursor continues after the last row looked at.
    // The quick filter works the same way over the timing columns (computed per row, never stored).
    const source = args.source ?? null;
    const scan = !!source || !!args.quick;
    const { results: scanned } = await db
      .prepare(`${txSelect(TX_TIMING_COLUMNS)} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`)
      .bind(...params, scan ? Math.max(SOURCE_SCAN, limit + 1) : limit + 1)
      .all<TxRow & TimingCols>();
    const timed = scanned.map((r) => ({ r, tx: withTiming(toTransaction(r, rate), r) }));
    const results = timed.filter(({ r, tx }) => (!source || toAdsAttribution(r).source === source) && (!args.quick || tx.quick));
    const page = results.slice(0, limit);
    const items = await withAutoRenew(db, page.map((x) => x.tx));
    const last = results.length > limit ? results[limit - 1].r : scan && scanned.length >= SOURCE_SCAN ? scanned[scanned.length - 1] : null;

    // Totals of every (local) day the page touches, over the whole day, with the same filters.
    const off = Math.max(-840, Math.min(840, Math.round(args.tzOffset ?? 0))) * 60_000;
    // Quick rows: no whole-day totals (that would compute the timing of every row of those days).
    let days: FeedDay[] = [];
    if (!args.upcoming && !args.quick && page.length) {
      const localDay = (ms: number) => new Date(ms + off).toISOString().slice(0, 10);
      const from = dayStart(localDay(page[page.length - 1].tx.purchasedAt)) - off;
      const to = Math.min(dayStart(localDay(page[0].tx.purchasedAt)) - off + DAY, t + 1);
      const { results: sums } = await db
        .prepare(
          `SELECT strftime('%Y-%m-%d', (t.purchased_at + ?) / 1000, 'unixepoch') AS day,
             SUM(t.gross_usd * ${KEPT}) AS revenue,
             SUM(t.proceeds_usd * ${KEPT}) AS proceeds,
             SUM(t.kind != 'trial') AS sales, COUNT(*) AS n
           FROM transactions t${source ? ` ${TX_INSTALL_JOINS}` : ""} WHERE ${filterSql}${source ? ` AND (${TX_SOURCE_SQL}) = ?` : ""} AND t.purchased_at >= ? AND t.purchased_at < ? GROUP BY day ORDER BY day DESC`,
        )
        .bind(off, ...filterParams, ...(source ? [source] : []), from, to)
        .all<{ day: string; revenue: number; proceeds: number; sales: number; n: number }>();
      days = sums.map((d) => ({ date: d.day, revenue: d.revenue * rate, proceeds: d.proceeds * rate, sales: d.sales, count: d.n }));
    }
    return { items, nextCursor: last ? base64url(`${last.purchased_at}|${last.id}`) : null, currency, days };
  },
);

type FeedArgs = Scope & {
  limit?: number;
  cursor?: string | null;
  country?: string | null;
  environment?: "Production" | "Sandbox" | "all";
  q?: string | null;
  productId?: string | null;
  upcoming?: boolean;
  tzOffset?: number;
  source?: AdsAttribution["source"] | null;
  quick?: boolean;
};

type CancelRow = AttributionCols & {
  id: string;
  app_id: string;
  app_name: string;
  icon_url: string | null;
  customer_id: string | null;
  transaction_id: string | null;
  original_transaction_id: string;
  product_id: string | null;
  product_name: string | null;
  signed_at: number;
  expires_at: number | null;
  country: string | null;
  environment: string;
  source: string;
  store: string;
  /** "<kind>:<purchased_at>" of the subscription's latest transaction at or before the cancellation. */
  purchase: string | null;
};

/**
 * Cancellations stream (`cancellations=true`): auto-renew turned off, newest first, as feed rows of kind "cancellation"
 * (purchasedAt = when it was turned off, no amount). Walks idx_events_cancel (cancellation events only) by workspace and
 * time; each row then probes its subscription (customer, expiry), install link and latest transaction of the
 * subscription (idx_tx_original) for sincePurchaseMs. Source / quick filters look at SOURCE_SCAN rows at most, like
 * the transactions feed.
 */
async function cancellationsFeed(db: Db, args: FeedArgs): Promise<Page<Transaction> & { currency: string; days: FeedDay[] }> {
  const { currency } = await workspaceCurrency(db, args);
  if (args.upcoming) return { items: [], nextCursor: null, currency, days: [] };
  const where = ["e.workspace_id = ?", CANCEL_EVENT_SQL];
  const params: unknown[] = [args.workspaceId];
  const f = appClause(args, "e.app_id");
  if (f.sql) {
    where.push(f.sql.replace(/^ AND /, ""));
    params.push(...f.params);
  }
  const env = args.environment ?? "Production";
  if (env !== "all") {
    where.push("e.environment = ?");
    params.push(env);
  }
  if (args.country) {
    where.push("e.country = ?");
    params.push(args.country.toUpperCase());
  }
  if (args.productId) {
    where.push("e.product_id = ?");
    params.push(args.productId);
  }
  if (args.q) {
    where.push("(e.transaction_id = ? OR e.original_transaction_id = ?)");
    params.push(args.q, args.q);
  }
  const t = now();
  const filterSql = where.join(" AND ");
  const filterParams = [...params];
  where.push("e.signed_at <= ?");
  params.push(t);
  if (args.cursor) {
    const [at, id] = new TextDecoder().decode(fromBase64url(args.cursor)).split("|");
    where.push("(e.signed_at < ? OR (e.signed_at = ? AND e.id < ?))");
    params.push(Number(at), Number(at), id);
  }
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const source = args.source ?? null;
  const scan = !!source || !!args.quick;
  const { results: scanned } = await db
    .prepare(
      `SELECT t.id, t.app_id, a.name AS app_name, a.icon_url, s.customer_id, t.transaction_id, t.original_transaction_id, COALESCE(t.product_id, s.product_id) AS product_id,
         p.name AS product_name, t.signed_at, s.expires_at, COALESCE(t.country, s.country) AS country, t.environment, t.source,
         CASE a.platform WHEN 'android' THEN 'play_store' WHEN 'web' THEN 'polar' ELSE 'app_store' END AS store,
         (SELECT x.kind || ':' || x.purchased_at FROM transactions x WHERE x.app_id = t.app_id AND x.original_transaction_id = t.original_transaction_id AND x.purchased_at <= t.signed_at
           ORDER BY x.purchased_at DESC LIMIT 1) AS purchase,
         ${TX_ATTRIBUTION_COLUMNS}
       FROM (
         SELECT e.id, e.workspace_id, e.app_id, e.transaction_id, e.original_transaction_id, e.product_id, e.signed_at, e.country, e.environment, e.source,
           (SELECT x.app_account_token FROM transactions x WHERE x.app_id = e.app_id AND x.original_transaction_id = e.original_transaction_id AND x.app_account_token IS NOT NULL LIMIT 1) AS app_account_token
         FROM events e WHERE ${where.join(" AND ")} ORDER BY e.signed_at DESC, e.id DESC LIMIT ?
       ) t JOIN apps a ON a.id = t.app_id
       LEFT JOIN subscriptions s ON s.app_id = t.app_id AND s.original_transaction_id = t.original_transaction_id
       LEFT JOIN products p ON p.app_id = t.app_id AND p.product_id = COALESCE(t.product_id, s.product_id)
       ${TX_ATTRIBUTION_JOINS}
       ORDER BY t.signed_at DESC, t.id DESC`,
    )
    .bind(...params, scan ? Math.max(SOURCE_SCAN, limit + 1) : limit + 1)
    .all<CancelRow>();
  const rows = scanned.map((r) => {
    const [kind, at] = r.purchase ? [r.purchase.slice(0, r.purchase.lastIndexOf(":")), Number(r.purchase.slice(r.purchase.lastIndexOf(":") + 1))] : [null, null];
    const sincePurchase = at !== null && Number.isFinite(at) ? r.signed_at - at : null;
    const tx: Transaction = {
      id: r.id,
      appId: r.app_id,
      appName: r.app_name,
      appIconUrl: r.icon_url,
      customerId: r.customer_id,
      transactionId: r.transaction_id ?? "",
      originalTransactionId: r.original_transaction_id,
      productId: r.product_id ?? "",
      productName: r.product_name,
      kind: "cancellation",
      purchasedAt: r.signed_at,
      expiresAt: r.expires_at,
      price: 0,
      storeCurrency: null,
      storePrice: 0,
      proceeds: 0,
      country: r.country,
      environment: r.environment,
      refundedAt: null,
      offer: null,
      source: r.source,
      store: r.store,
      attribution: toAdsAttribution(r),
      autoRenew: false,
      sincePurchaseMs: sincePurchase,
      purchaseKind: (kind as Transaction["kind"] | null) ?? null,
      quick: isQuick(sincePurchase),
    };
    return { r, tx };
  });
  const results = rows.filter(({ tx }) => (!source || tx.attribution?.source === source) && (!args.quick || tx.quick));
  const page = results.slice(0, limit);
  const last = results.length > limit ? results[limit - 1].r : scan && scanned.length >= SOURCE_SCAN ? scanned[scanned.length - 1] : null;
  // Day counts over idx_events_cancel (no amounts); none for the source / quick filters (per-row work over whole days).
  const off = Math.max(-840, Math.min(840, Math.round(args.tzOffset ?? 0))) * 60_000;
  let days: FeedDay[] = [];
  if (!scan && page.length) {
    const localDay = (ms: number) => new Date(ms + off).toISOString().slice(0, 10);
    const from = dayStart(localDay(page[page.length - 1].tx.purchasedAt)) - off;
    const to = Math.min(dayStart(localDay(page[0].tx.purchasedAt)) - off + DAY, t + 1);
    const { results: sums } = await db
      .prepare(
        `SELECT strftime('%Y-%m-%d', (e.signed_at + ?) / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM events e
         WHERE ${filterSql} AND e.signed_at >= ? AND e.signed_at < ? GROUP BY day ORDER BY day DESC`,
      )
      .bind(off, ...filterParams, from, to)
      .all<{ day: string; n: number }>();
    days = sums.map((d) => ({ date: d.day, revenue: 0, proceeds: 0, sales: 0, count: d.n }));
  }
  return { items: page.map((x) => x.tx), nextCursor: last ? base64url(`${last.signed_at}|${last.id}`) : null, currency, days };
}

/** Statement chunk under the 100-parameter limit (one extra for the app id). */
const ID_CHUNK = 90;

/** Feed: current auto-renew state of each subscription row's subscription (unique index on app_id + original id). */
async function withAutoRenew(db: Db, items: Transaction[]): Promise<Transaction[]> {
  const byApp = new Map<string, Set<string>>();
  for (const t of items) {
    if (t.kind === "one_time") continue;
    const ids = byApp.get(t.appId) ?? new Set<string>();
    ids.add(t.originalTransactionId);
    byApp.set(t.appId, ids);
  }
  const state = new Map<string, boolean>();
  for (const [appId, set] of byApp) {
    const ids = [...set];
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      const { results } = await db
        .prepare(`SELECT original_transaction_id AS otid, auto_renew FROM subscriptions WHERE app_id = ? AND original_transaction_id IN (${chunk.map(() => "?").join(",")})`)
        .bind(appId, ...chunk)
        .all<{ otid: string; auto_renew: number }>();
      for (const r of results) state.set(`${appId}|${r.otid}`, !!r.auto_renew);
    }
  }
  for (const t of items) {
    const v = state.get(`${t.appId}|${t.originalTransactionId}`);
    if (v !== undefined && t.kind !== "one_time") t.autoRenew = v;
  }
  return items;
}

/** Customer history: Apple notifications of the customer's original transaction ids, newest first. */
async function customerEvents(db: Db, appId: string, otids: string[], sandbox: boolean, limit = 100): Promise<(CustomerEvent & { otid: string })[]> {
  const out: (CustomerEvent & { otid: string })[] = [];
  for (let i = 0; i < otids.length; i += ID_CHUNK) {
    const chunk = otids.slice(i, i + ID_CHUNK);
    const { results } = await db
      .prepare(
        `SELECT type, subtype, signed_at, product_id, environment, transaction_id, original_transaction_id FROM events
         WHERE app_id = ? AND original_transaction_id IN (${chunk.map(() => "?").join(",")})${sandbox ? "" : " AND environment = 'Production'"}
         ORDER BY signed_at DESC LIMIT ?`,
      )
      .bind(appId, ...chunk, limit)
      .all<{ type: string; subtype: string | null; signed_at: number; product_id: string | null; environment: string; transaction_id: string | null; original_transaction_id: string }>();
    for (const r of results) out.push({ type: r.type, subtype: r.subtype, at: r.signed_at, productId: r.product_id, environment: r.environment, transactionId: r.transaction_id, otid: r.original_transaction_id });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

/** Feed day header: totals of one day (refunded sales excluded from revenue). */
export interface FeedDay {
  date: string;
  revenue: number;
  proceeds: number;
  sales: number;
  count: number;
}

const SUB_SELECT = `SELECT s.id, s.app_id, a.name AS app_name, s.customer_id, s.original_transaction_id, s.product_id, p.name AS product_name,
  s.status, s.auto_renew, s.started_at, s.expires_at, s.period, s.mrr_usd, s.country, s.renewal_price_usd, s.cancel_reason
  FROM subscriptions s JOIN apps a ON a.id = s.app_id LEFT JOIN products p ON p.app_id = s.app_id AND p.product_id = s.product_id`;

type SubRow = {
  id: string;
  app_id: string;
  app_name: string;
  customer_id: string | null;
  original_transaction_id: string;
  product_id: string;
  product_name: string | null;
  status: Subscription["status"];
  auto_renew: number;
  started_at: number;
  expires_at: number | null;
  period: string | null;
  mrr_usd: number;
  country: string | null;
  renewal_price_usd: number | null;
  cancel_reason: string | null;
};

/** MRR of a subscription; billing retry has none of its own, value it at what it was paying. */
const subMrr = (r: SubRow) =>
  r.mrr_usd || (r.status === "billing_retry" && r.renewal_price_usd ? r.renewal_price_usd / (periodMonths(r.period) ?? 1) : 0);

const toSubscription = (r: SubRow, rate: number): Subscription => ({
  id: r.id,
  appId: r.app_id,
  appName: r.app_name,
  customerId: r.customer_id,
  originalTransactionId: r.original_transaction_id,
  productId: r.product_id,
  productName: r.product_name,
  status: r.status,
  autoRenew: !!r.auto_renew,
  startedAt: r.started_at,
  expiresAt: r.expires_at,
  period: r.period,
  mrr: subMrr(r) * rate,
  country: r.country,
  ...(r.cancel_reason ? { cancelReason: r.cancel_reason } : {}),
});

/** Installs (RevflareKit) linked to a customer, at most this many (newest activity checked for a few). */
const CUSTOMER_INSTALLS = 20;
const CUSTOMER_ACTIVITY_PROBES = 5;

/**
 * A customer's RevflareKit installs: install_links of their subscriptions / purchases (primary key) and their
 * appAccountToken (= install id), then the attribution rows (primary key) for the install time, and the latest key
 * event of the most recent ones (idx_app_events_install, one row each) for the app's last activity.
 */
async function customerInstalls(db: Db, appId: string, otids: string[], token: string | null): Promise<{ installId: string; installedAt: number; fromDevice: boolean; lastActiveAt: number }[]> {
  const ids = new Set<string>();
  if (token) ids.add(token.toLowerCase());
  for (let i = 0; i < otids.length && ids.size < CUSTOMER_INSTALLS; i += ID_CHUNK) {
    const chunk = otids.slice(i, i + ID_CHUNK);
    const { results } = await db
      .prepare(`SELECT DISTINCT install_id FROM install_links WHERE app_id = ? AND original_transaction_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(appId, ...chunk)
      .all<{ install_id: string }>();
    for (const r of results) ids.add(r.install_id);
  }
  const list = [...ids].slice(0, CUSTOMER_INSTALLS);
  if (!list.length) return [];
  const { results: rows } = await db
    .prepare(`SELECT install_id, installed_at, created_at, updated_at FROM attributions WHERE app_id = ? AND install_id IN (${list.map(() => "?").join(",")})`)
    .bind(appId, ...list)
    .all<{ install_id: string; installed_at: number | null; created_at: number; updated_at: number }>();
  const out = rows.map((r) => ({
    installId: r.install_id,
    installedAt: r.installed_at ?? r.created_at,
    fromDevice: r.installed_at !== null,
    lastActiveAt: Math.max(r.created_at, r.updated_at),
  }));
  for (const r of [...out].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, CUSTOMER_ACTIVITY_PROBES)) {
    const ev = await db.prepare("SELECT ts FROM app_events WHERE app_id = ? AND install_id = ? ORDER BY ts DESC LIMIT 1").bind(appId, r.installId).first<{ ts: number }>();
    if (ev && ev.ts > r.lastActiveAt) r.lastActiveAt = ev.ts;
  }
  return out;
}

export const customer = defineDbFunction("customer", async (db, args: Scope & { id: string }): Promise<Customer | null> => {
  const { rate } = await workspaceCurrency(db, args);
  const c = await db
    .prepare(
      `SELECT c.*, a.name AS app_name FROM customers c JOIN apps a ON a.id = c.app_id WHERE c.id = ? AND c.workspace_id = ?`,
    )
    .bind(args.id, args.workspaceId)
    .first<{
      id: string;
      app_id: string;
      app_name: string;
      country: string | null;
      first_seen_at: number;
      first_paid_at: number | null;
      last_seen_at: number;
      total_usd: number;
      total_proceeds_usd: number;
      app_account_token: string | null;
      rc_app_user_id: string | null;
      refund_data_consent: number | null;
      sandbox: number;
    }>();
  if (!c) return null;
  const { results: subs } = await db.prepare(`${SUB_SELECT} WHERE s.customer_id = ? ORDER BY s.started_at DESC`).bind(c.id).all<SubRow>();
  const { results: txs } = await db.prepare(`${TX_SELECT} WHERE t.customer_id = ? ORDER BY t.purchased_at DESC LIMIT 500`).bind(c.id).all<TxRow>();
  const otids = [...new Set([...subs.map((s) => s.original_transaction_id), ...txs.map((t) => t.original_transaction_id)])];
  const raw = await customerEvents(db, c.app_id, otids, !!c.sandbox);
  const events: CustomerEvent[] = raw.map(({ otid: _, ...e }) => e);
  // Every time auto-renew was turned off (the subscriptions' events, idx_events_original), oldest first.
  const cancels: { otid: string; at: number }[] = [];
  for (let i = 0; i < otids.length; i += ID_CHUNK) {
    const chunk = otids.slice(i, i + ID_CHUNK);
    const { results } = await db
      .prepare(`SELECT e.original_transaction_id AS otid, e.signed_at AS at FROM events e WHERE e.app_id = ? AND e.original_transaction_id IN (${chunk.map(() => "?").join(",")}) AND ${CANCEL_EVENT_SQL}`)
      .bind(c.app_id, ...chunk)
      .all<{ otid: string; at: number }>();
    cancels.push(...results);
  }
  cancels.sort((a, b) => a.at - b.at);
  // Purchase / trial start → cancellation: from the subscription's latest transaction at or before it.
  const sinceLastPurchase = (otid: string, at: number) => {
    let best: number | null = null;
    for (const t of txs) if (t.original_transaction_id === otid && t.purchased_at <= at && (best === null || t.purchased_at > best)) best = t.purchased_at;
    return best === null ? null : at - best;
  };
  const subscriptions: Subscription[] = [];
  for (const s of subs) {
    const sub = toSubscription(s, rate);
    sub.autoRenewOffAt = null;
    sub.cancelledAfterMs = null;
    if (!s.auto_renew) {
      const off = cancels.filter((e) => e.otid === s.original_transaction_id).pop();
      if (off) {
        sub.autoRenewOffAt = off.at;
        sub.cancelledAfterMs = sinceLastPurchase(off.otid, off.at);
      }
    }
    subscriptions.push(sub);
  }
  const transactions = txs.map((t) => toTransaction(t, rate));
  const installs = await customerInstalls(db, c.app_id, otids, c.app_account_token);
  const t = now();
  const installedAt = installs.length ? Math.min(...installs.map((i) => i.installedAt)) : null;
  const firstInstall = installs.find((i) => i.installedAt === installedAt) ?? null;

  // Timing: install → first purchase / trial, purchase → cancellation (the fastest), purchase → refund (the fastest).
  const ordered = [...txs].sort((a, b) => a.purchased_at - b.purchased_at);
  const first = ordered[0] ?? null;
  const installToPurchase = first && installedAt !== null && first.purchased_at >= installedAt ? first.purchased_at - installedAt : null;
  let cancel: { ms: number; at: number } | null = null;
  for (const e of cancels) {
    const ms = sinceLastPurchase(e.otid, e.at);
    if (ms !== null && (!cancel || ms < cancel.ms)) cancel = { ms, at: e.at };
  }
  let refund: { ms: number; at: number } | null = null;
  for (const x of txs) {
    if (x.refunded_at === null || x.refunded_at < x.purchased_at) continue;
    const ms = x.refunded_at - x.purchased_at;
    if (!refund || ms < refund.ms) refund = { ms, at: x.refunded_at };
  }
  const timing: CustomerTiming = {
    firstPurchaseAt: first?.purchased_at ?? null,
    firstPurchaseKind: first?.kind ?? null,
    installToPurchaseMs: installToPurchase,
    purchaseToCancelMs: cancel?.ms ?? null,
    cancelledAt: cancel?.at ?? null,
    purchaseToRefundMs: refund?.ms ?? null,
    refundedAt: refund?.at ?? null,
    quickPurchase: isQuick(installToPurchase),
    quickCancel: isQuick(cancel?.ms),
  };
  if (first) {
    const tx = transactions.find((x) => x.id === first.id);
    if (tx) tx.sinceInstallMs = installToPurchase;
  }

  // First / last seen: the install and the app's activity (RevflareKit) with the store's transactions and notifications.
  const firstTx = first?.purchased_at ?? c.first_seen_at;
  const firstSeenAt = installedAt !== null && installedAt < firstTx ? installedAt : Math.min(firstTx, c.first_seen_at);
  const seen: { at: number; source: "app" | "purchase" | "notification" }[] = [];
  const pastTx = txs.filter((x) => x.purchased_at <= t).reduce((m, x) => Math.max(m, x.purchased_at), 0);
  if (pastTx) seen.push({ at: pastTx, source: "purchase" });
  if (raw.length) seen.push({ at: Math.min(raw[0].at, t), source: "notification" });
  for (const i of installs) if (i.lastActiveAt) seen.push({ at: Math.min(i.lastActiveAt, t), source: "app" });
  const last = seen.reduce<(typeof seen)[number] | null>((m, x) => (!m || x.at > m.at ? x : m), null);
  return {
    id: c.id,
    appId: c.app_id,
    appName: c.app_name,
    country: c.country,
    firstSeenAt,
    firstSeenSource: installedAt !== null && installedAt <= firstTx ? "install" : "purchase",
    firstPaidAt: c.first_paid_at,
    lastSeenAt: last?.at ?? Math.min(c.last_seen_at, t),
    lastSeenSource: last?.source ?? "purchase",
    installedAt,
    installedAtSource: firstInstall ? (firstInstall.fromDevice ? "device" : "first_report") : null,
    timing,
    totalSpent: c.total_usd * rate,
    totalProceeds: c.total_proceeds_usd * rate,
    appAccountToken: c.app_account_token,
    rcAppUserId: c.rc_app_user_id,
    refundDataConsent: c.refund_data_consent !== 0,
    subscriptions,
    transactions,
    attribution: await customerAttribution(db, c.id),
    events,
  };
});

export async function atRiskLocal(db: Db, args: Scope & { limit?: number }): Promise<AtRisk> {
  const { currency, rate } = await workspaceCurrency(db, args);
  const f = appClause(args, "s.app_id");
  const base = `s.workspace_id = ? AND s.environment = 'Production'${f.sql}`;
  const { results: groups } = await db
    .prepare(
      `SELECT CASE WHEN s.status IN ('billing_retry', 'grace') THEN s.status ELSE 'cancelled' END AS reason,
         COUNT(*) AS n, SUM(CASE WHEN s.mrr_usd > 0 THEN s.mrr_usd ELSE COALESCE(s.renewal_price_usd, 0) / 1 END) AS mrr
       FROM subscriptions s WHERE ${base} AND (s.status IN ('billing_retry', 'grace') OR (s.status = 'active' AND s.auto_renew = 0))
       GROUP BY reason`,
    )
    .bind(args.workspaceId, ...f.params)
    .all<{ reason: "billing_retry" | "grace" | "cancelled"; n: number; mrr: number }>();
  // Billing retry has no MRR of its own (it is not paying): value it at what it was paying.
  const { results: retryValue } = await db
    .prepare(
      `SELECT s.status, SUM(COALESCE(s.renewal_price_usd, 0) / COALESCE(CASE s.period WHEN 'P1W' THEN 0.23 WHEN 'P1M' THEN 1 WHEN 'P2M' THEN 2 WHEN 'P3M' THEN 3 WHEN 'P6M' THEN 6 WHEN 'P1Y' THEN 12 END, 1)) AS mrr
       FROM subscriptions s WHERE ${base} AND s.status = 'billing_retry' GROUP BY s.status`,
    )
    .bind(args.workspaceId, ...f.params)
    .all<{ status: string; mrr: number }>();
  const labels = { billing_retry: "Billing issue (retrying)", grace: "Grace period", cancelled: "Auto-renew turned off" };
  const out = groups.map((g) => ({
    reason: g.reason,
    label: labels[g.reason],
    subscriptions: g.n,
    mrr: (g.reason === "billing_retry" ? (retryValue[0]?.mrr ?? 0) : g.mrr) * rate,
  }));
  const { results: items } = await db
    .prepare(
      `${SUB_SELECT} WHERE ${base.replace(/s\.workspace_id/, "s.workspace_id")} AND (s.status IN ('billing_retry', 'grace') OR (s.status = 'active' AND s.auto_renew = 0))
       ORDER BY s.expires_at LIMIT ?`,
    )
    .bind(args.workspaceId, ...f.params, args.limit ?? 100)
    .all<SubRow>();
  return { currency, mrr: out.reduce((s, g) => s + g.mrr, 0), groups: out, items: items.map((s) => toSubscription(s, rate)) };
}

export const atRisk = cachedFn("atRisk", atRiskLocal);

/** Observed renewal rate per period and trial conversion rate over the last 90 days (Production). */
async function renewalRates(db: Db, scope: Scope): Promise<{ rates: Record<string, number>; trial: number }> {
  const t = now();
  const f = appClause(scope, "t.app_id");
  // Periods that ended in the window, and whether the same subscription paid again afterwards.
  const { results } = await db
    .prepare(
      `WITH due AS (
         SELECT t.app_id, t.original_transaction_id AS otid, t.purchased_at, t.kind, t.period FROM transactions t
         WHERE t.workspace_id = ? AND t.environment = 'Production' AND t.product_type = 'auto_renewable'
           AND t.expires_at >= ? AND t.expires_at < ? AND t.refunded_at IS NULL AND t.is_upgraded = 0${f.sql}
       ), last AS (
         SELECT n.app_id, n.original_transaction_id AS otid, MAX(n.purchased_at) AS last_at FROM transactions n
         WHERE n.workspace_id = ? AND n.kind != 'trial' AND n.original_transaction_id IN (SELECT otid FROM due)
         GROUP BY n.app_id, n.original_transaction_id
       )
       SELECT CASE WHEN due.kind = 'trial' THEN 'trial' ELSE COALESCE(due.period, 'unknown') END AS p, COUNT(*) AS due,
         SUM(COALESCE(last.last_at > due.purchased_at, 0)) AS renewed
       FROM due LEFT JOIN last ON last.app_id = due.app_id AND last.otid = due.otid GROUP BY p`,
    )
    .bind(scope.workspaceId, t - 93 * DAY, t - 3 * DAY, ...f.params, scope.workspaceId)
    .all<{ p: string; due: number; renewed: number }>();
  const rates: Record<string, number> = {};
  let trial = 0.3;
  for (const r of results) {
    if (r.due < 5) continue;
    if (r.p === "trial") trial = r.renewed / r.due;
    else rates[r.p] = r.renewed / r.due;
  }
  return { rates, trial };
}

export async function forecastLocal(db: Db, args: Scope & { days?: number }): Promise<Forecast> {
  const { currency, rate } = await workspaceCurrency(db, args);
  const days = Math.min(Math.max(args.days ?? 30, 1), 90);
  const t = now();
  const { rates, trial } = await renewalRates(db, args);
  const f = appClause(args, "s.app_id");
  const { results } = await db
    .prepare(
      `SELECT s.status, s.period, s.expires_at, s.renewal_price_usd, s.mrr_usd FROM subscriptions s
       WHERE s.workspace_id = ? AND s.environment = 'Production' AND s.auto_renew = 1 AND s.status IN ('active', 'trial', 'grace')
         AND s.expires_at >= ? AND s.expires_at < ?${f.sql}`,
    )
    .bind(args.workspaceId, t, t + days * DAY, ...f.params)
    .all<{ status: string; period: string | null; expires_at: number; renewal_price_usd: number | null; mrr_usd: number }>();
  const fallback = Object.values(rates).length ? Object.values(rates).reduce((a, b) => a + b, 0) / Object.values(rates).length : 0.8;
  const byDay = new Map<string, { due: number; expected: number }>();
  let expected = 0;
  for (const s of results) {
    const price = s.renewal_price_usd ?? (s.mrr_usd && s.period ? s.mrr_usd * (periodMonths(s.period) ?? 1) : 0);
    if (!price) continue;
    const p = s.status === "trial" ? trial : (rates[s.period ?? ""] ?? fallback);
    const d = dayOf(s.expires_at);
    const cur = byDay.get(d) ?? { due: 0, expected: 0 };
    cur.due += price * rate;
    cur.expected += price * p * rate;
    byDay.set(d, cur);
    expected += price * p * rate;
  }
  const points = [];
  for (let i = 0; i < days; i++) {
    const d = dayOf(t + i * DAY);
    const v = byDay.get(d) ?? { due: 0, expected: 0 };
    points.push({ date: d, ...v });
  }
  return { currency, days, expected, renewalRates: { ...rates, trial }, points };
}

export const forecast = cachedFn("forecast", forecastLocal);

export const cohorts = cachedFn("cohorts", async (db, args: Scope & { months?: number }): Promise<Cohorts> => {
  const { currency, rate } = await workspaceCurrency(db, args);
  const months = Math.min(Math.max(args.months ?? 12, 1), 36);
  const start = new Date(now());
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCMonth(start.getUTCMonth() - (months - 1));
  const f = appClause(args, "c.app_id");
  const monthIndex = (col: string) => `(CAST(strftime('%Y', ${col} / 1000, 'unixepoch') AS INTEGER) * 12 + CAST(strftime('%m', ${col} / 1000, 'unixepoch') AS INTEGER))`;
  const { results: sizes } = await db
    .prepare(
      `SELECT strftime('%Y-%m', c.first_paid_at / 1000, 'unixepoch') AS cohort, COUNT(*) AS n FROM customers c
       WHERE c.workspace_id = ? AND c.first_paid_at >= ?${f.sql} GROUP BY cohort`,
    )
    .bind(args.workspaceId, start.getTime(), ...f.params)
    .all<{ cohort: string; n: number }>();
  const { results } = await db
    .prepare(
      `SELECT strftime('%Y-%m', c.first_paid_at / 1000, 'unixepoch') AS cohort, ${monthIndex("t.purchased_at")} - ${monthIndex("c.first_paid_at")} AS k,
         COUNT(DISTINCT t.customer_id) AS retained, SUM(t.gross_usd * ${KEPT}) AS revenue
       FROM customers c JOIN transactions t ON t.customer_id = c.id
       WHERE c.workspace_id = ? AND c.first_paid_at >= ? AND t.environment = 'Production' AND t.kind != 'trial' AND (t.refunded_at IS NULL OR t.refund_milli IS NOT NULL) AND t.gross_usd > 0${f.sql}
       GROUP BY cohort, k`,
    )
    .bind(args.workspaceId, start.getTime(), ...f.params)
    .all<{ cohort: string; k: number; retained: number; revenue: number }>();
  const rows = sizes
    .sort((a, b) => (a.cohort < b.cohort ? -1 : 1))
    .map((s) => {
      const age = (new Date(now()).getUTCFullYear() * 12 + new Date(now()).getUTCMonth()) - (Number(s.cohort.slice(0, 4)) * 12 + Number(s.cohort.slice(5, 7)) - 1);
      const revenue = Array.from({ length: age + 1 }, () => 0);
      const retained = Array.from({ length: age + 1 }, () => 0);
      for (const r of results) {
        if (r.cohort !== s.cohort || r.k < 0 || r.k > age) continue;
        revenue[r.k] = r.revenue * rate;
        retained[r.k] = r.retained;
      }
      let cum = 0;
      const ltv = revenue.map((v) => (cum += v) / s.n);
      return { cohort: s.cohort, customers: s.n, revenue, ltv, retained };
    });
  return { currency, rows };
});

// Overview -----------------------------------------------------------------------------------------------------------

/** Today's and yesterday's flow numbers over the local days of `offMs` (ms east of UTC), from the transactions. */
async function localDays(db: Db, scope: Scope, offMs: number, rate: number) {
  const t = now();
  const today = new Date(t + offMs).toISOString().slice(0, 10);
  const start = dayStart(today) - offMs;
  const f = appClause(scope, "t.app_id");
  const where = `t.workspace_id = ? AND t.environment = 'Production'${f.sql}`;
  // td: the sale is today's (1) or yesterday's (0); trials never count as sales or revenue.
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN td = 1 AND paid THEN gross ELSE 0 END) AS revenue, SUM(CASE WHEN td = 1 AND paid THEN net ELSE 0 END) AS proceeds,
         SUM(td = 1 AND kind != 'trial') AS sales, SUM(td = 1 AND kind IN ('new', 'conversion')) AS new_subscriptions, SUM(td = 1 AND kind = 'trial') AS trials,
         SUM(CASE WHEN td = 0 AND paid THEN gross ELSE 0 END) AS y_revenue, SUM(CASE WHEN td = 0 AND paid THEN net ELSE 0 END) AS y_proceeds,
         SUM(td = 0 AND kind != 'trial') AS y_sales
       FROM (SELECT t.purchased_at >= ? AS td, t.kind, t.kind != 'trial' AS paid, t.gross_usd * ${KEPT} AS gross, t.proceeds_usd * ${KEPT} AS net
             FROM transactions t WHERE ${where} AND t.purchased_at >= ? AND t.purchased_at <= ?)`,
    )
    .bind(start, scope.workspaceId, ...f.params, start - DAY, t)
    .first<Record<string, number | null>>();
  const refunds = await db
    .prepare(`SELECT COUNT(*) AS n FROM transactions t WHERE ${where} AND t.refunded_at >= ? AND t.refunded_at <= ?`)
    .bind(scope.workspaceId, ...f.params, start, t)
    .first<{ n: number }>();
  const v = (k: string) => row?.[k] ?? 0;
  return {
    today: {
      date: today,
      revenue: v("revenue") * rate,
      proceeds: v("proceeds") * rate,
      sales: v("sales"),
      newSubscriptions: v("new_subscriptions"),
      trialsStarted: v("trials"),
      refunds: refunds?.n ?? 0,
    },
    yesterday: { revenue: v("y_revenue") * rate, proceeds: v("y_proceeds") * rate, sales: v("y_sales") },
  };
}

export const overview = cachedFn("overview", async (db, args: Scope & { tzOffset?: number }): Promise<Overview> => {
  const { currency, rate } = await workspaceCurrency(db, args);
  const today = dayOf(now());
  const from = addDays(today, -63); // 28 + 28 days and a week of margin
  const { rows } = await dailyRows(db, args, from, today);
  const last = (n: number, offset = 0) => rows.slice(rows.length - n - offset, rows.length - offset);
  const cur28 = last(28);
  const prev28 = last(28, 28);
  const kpi = (id: string, metric: Metric, label: string, value: number, previous: number | null, spark: number[]): Kpi => ({
    id,
    metric,
    label,
    format: METRIC_INFO[metric].format,
    value,
    previous,
    change: previous ? (value - previous) / Math.abs(previous) : null,
    spark,
  });
  const m = (metric: Metric, r: DayRow[], before: DayRow | null = null) => convert(metric, metricValue(metric, r, before), rate);
  // Rates as 7-day rolling values for the last 28 days (sparklines).
  const rolling = (metric: Metric) =>
    Array.from({ length: 28 }, (_, i) => {
      const end = rows.length - 27 + i;
      return metricValue(metric, rows.slice(end - 7, end), rows[end - 8] ?? null);
    });
  const todayRow = rows[rows.length - 1];
  const yRow = rows[rows.length - 2];
  // Today / yesterday of the caller's time zone (the daily rows are UTC days).
  const local = args.tzOffset != null && Number.isFinite(args.tzOffset) ? await localDays(db, args, Math.max(-840, Math.min(840, Math.round(args.tzOffset))) * 60_000, rate) : null;
  const mrrNow = todayRow.mrr_usd * rate;
  const mrr30 = rows[rows.length - 31]?.mrr_usd * rate;
  const kpis: Kpi[] = [
    kpi("mrr", "mrr", "MRR", mrrNow, mrr30 ?? null, cur28.map((r) => r.mrr_usd * rate)),
    kpi("revenue_28d", "revenue", "Revenue (28 days)", m("revenue", cur28), m("revenue", prev28), cur28.map((r) => r.gross_usd * rate)),
    kpi("proceeds_28d", "proceeds", "Proceeds (28 days)", m("proceeds", cur28), m("proceeds", prev28), cur28.map((r) => r.proceeds_usd * rate)),
    kpi("active_subscriptions", "active_subscriptions", "Active subscriptions", todayRow.active_subscriptions, rows[rows.length - 29]?.active_subscriptions ?? null, cur28.map((r) => r.active_subscriptions)),
    kpi("active_trials", "active_trials", "Active trials", todayRow.active_trials, rows[rows.length - 29]?.active_trials ?? null, cur28.map((r) => r.active_trials)),
    kpi("new_customers_28d", "new_customers", "New customers (28 days)", m("new_customers", cur28), m("new_customers", prev28), cur28.map((r) => r.new_customers)),
    kpi("trial_conversion_28d", "trial_conversion_rate", "Trial conversion (28 days)", m("trial_conversion_rate", cur28), m("trial_conversion_rate", prev28), rolling("trial_conversion_rate")),
    kpi("churn_rate_28d", "churn_rate", "Churn (28 days)", m("churn_rate", cur28, rows[rows.length - 29] ?? null), m("churn_rate", prev28, rows[rows.length - 57] ?? null), rolling("churn_rate")),
  ];
  const sum = (c: keyof DayRow) => cur28.reduce((s, r) => s + (r[c] as number), 0) * rate;
  const movement = { new: sum("mrr_new"), expansion: sum("mrr_expansion"), contraction: sum("mrr_contraction"), churn: sum("mrr_churn"), reactivation: sum("mrr_reactivation") };

  // Records: best day and month (all time, Production, own data).
  const f = appClause(args);
  // Whole workspace: the workspace_daily totals (indexed by amount); a selection of apps: their own rows.
  const best = args.appIds?.length
    ? await db
        .prepare(`SELECT day, SUM(gross_usd) AS v FROM daily_metrics WHERE workspace_id = ? AND day < ?${f.sql} GROUP BY day ORDER BY v DESC LIMIT 1`)
        .bind(args.workspaceId, today, ...f.params)
        .first<{ day: string; v: number }>()
    : await db.prepare("SELECT day, gross_usd AS v FROM workspace_daily WHERE workspace_id = ? AND day < ? ORDER BY gross_usd DESC LIMIT 1").bind(args.workspaceId, today).first<{ day: string; v: number }>();
  const bestMonth = args.appIds?.length
    ? await db
        .prepare(`SELECT substr(day, 1, 7) AS month, SUM(gross_usd) AS v FROM daily_metrics WHERE workspace_id = ?${f.sql} GROUP BY month ORDER BY v DESC LIMIT 1`)
        .bind(args.workspaceId, ...f.params)
        .first<{ month: string; v: number }>()
    : await db
        .prepare("SELECT substr(day, 1, 7) AS month, SUM(gross_usd) AS v FROM workspace_daily WHERE workspace_id = ? GROUP BY month ORDER BY v DESC LIMIT 1")
        .bind(args.workspaceId)
        .first<{ month: string; v: number }>();

  // Top apps by 28-day revenue.
  const { results: apps } = await db
    .prepare(
      `SELECT a.id, a.name, a.icon_url, a.platform,
         SUM(CASE WHEN d.day > ? THEN d.gross_usd ELSE 0 END) AS rev, SUM(CASE WHEN d.day <= ? THEN d.gross_usd ELSE 0 END) AS prev,
         SUM(CASE WHEN d.day = ? THEN d.mrr_usd ELSE 0 END) AS mrr
       FROM daily_metrics d JOIN apps a ON a.id = d.app_id WHERE d.workspace_id = ? AND d.day > ?${appClause(args, "d.app_id").sql}
       GROUP BY a.id ORDER BY rev DESC LIMIT 6`,
    )
    .bind(addDays(today, -28), addDays(today, -28), today, args.workspaceId, addDays(today, -56), ...f.params)
    .all<{ id: string; name: string; icon_url: string | null; platform: string; rev: number; prev: number; mrr: number }>();

  const risk = await atRiskLocal(db, { ...args, currency, limit: 0 });
  // Renewal forecast changes slowly: computed once a day per scope.
  const fcKey = `forecast30:${JSON.stringify(args)}:${dayOf(now())}`;
  let fc = dayCache.get(fcKey) as Forecast | undefined;
  if (!fc) {
    fc = await forecastLocal(db, { ...args, currency, days: 30 });
    dayCache.set(fcKey, fc);
    if (dayCache.size > 100) dayCache.delete(dayCache.keys().next().value!);
  }
  const { results: alerts } = await db
    .prepare(
      `SELECT id, app_id, key, kind, severity, title, body, created_at, resolved_at FROM alerts WHERE workspace_id = ? AND resolved_at IS NULL AND created_at > ?
       ORDER BY created_at DESC LIMIT 5`,
    )
    .bind(args.workspaceId, now() - 7 * DAY)
    .all<{ id: string; app_id: string | null; key: string; kind: string; severity: "info" | "warning" | "critical"; title: string; body: string; created_at: number; resolved_at: number | null }>();

  return {
    currency,
    asOf: now(),
    ...(local ?? {
      today: {
        date: today,
        revenue: todayRow.gross_usd * rate,
        proceeds: todayRow.proceeds_usd * rate,
        sales: todayRow.new_subscriptions + todayRow.renewals + todayRow.one_time_purchases,
        newSubscriptions: todayRow.new_subscriptions,
        trialsStarted: todayRow.trials_started,
        refunds: todayRow.refunds,
      },
      yesterday: { revenue: (yRow?.gross_usd ?? 0) * rate, proceeds: (yRow?.proceeds_usd ?? 0) * rate, sales: (yRow?.new_subscriptions ?? 0) + (yRow?.renewals ?? 0) + (yRow?.one_time_purchases ?? 0) },
    }),
    kpis,
    mrrMovement: { ...movement, net: movement.new + movement.expansion + movement.reactivation - movement.contraction - movement.churn },
    atRisk: { mrr: risk.mrr, subscriptions: risk.groups.reduce((s, g) => s + g.subscriptions, 0) },
    forecast30: fc.expected,
    // Goals cover their own apps and periods, whatever the overview's app filter.
    goals: await computeGoals(db, args.workspaceId, rate),
    records: {
      bestDay: best ? { date: best.day, revenue: best.v * rate } : null,
      todayIsRecord: !!best && (local ? local.today.revenue / rate : todayRow.gross_usd) > Math.max(best.v, 0),
      bestMonth: bestMonth ? { date: bestMonth.month, revenue: bestMonth.v * rate } : null,
    },
    topApps: apps.map((a) => ({ appId: a.id, name: a.name, iconUrl: a.icon_url, revenue28d: a.rev * rate, mrr: a.mrr * rate, change: a.prev ? (a.rev - a.prev) / a.prev : null, platform: a.platform })),
    alerts: alerts.map((a) => ({ id: a.id, appId: a.app_id, kind: a.kind, funnelId: alertFunnelId(a.kind, a.key), experimentId: alertExperimentId(a.kind, a.key), severity: a.severity, title: a.title, body: a.body, createdAt: a.created_at, resolvedAt: a.resolved_at })),
  };
});

/** Every goal of the workspace (archived ones too) with its progress (GET /goals). */
export const goalsList = cachedFn("goals", async (db, args: Scope): Promise<{ currency: string; items: GoalProgress[] }> => {
  const { currency, rate } = await workspaceCurrency(db, { workspaceId: args.workspaceId, currency: args.currency });
  return { currency, items: await computeGoals(db, args.workspaceId, rate, { archived: true }) };
});

/** Per-app numbers for the apps list (MRR today, 28-day revenue, actives). */
export const appStats = cachedFn("appStats", async (db, args: Scope) => {
  const { currency, rate } = await workspaceCurrency(db, args);
  const today = dayOf(now());
  const { results } = await db
    .prepare(
      `SELECT app_id, SUM(CASE WHEN day > ? THEN gross_usd ELSE 0 END) AS rev,
         MAX(CASE WHEN day = ? THEN mrr_usd END) AS mrr, MAX(CASE WHEN day = ? THEN active_subscriptions END) AS subs,
         MAX(CASE WHEN day = ? THEN active_trials END) AS trials
       FROM daily_metrics WHERE workspace_id = ? AND day > ? GROUP BY app_id`,
    )
    .bind(addDays(today, -28), today, today, today, args.workspaceId, addDays(today, -29))
    .all<{ app_id: string; rev: number; mrr: number | null; subs: number | null; trials: number | null }>();
  const out: Record<string, { mrr: number; revenue28d: number; activeSubscriptions: number; activeTrials: number }> = {};
  for (const r of results) out[r.app_id] = { mrr: (r.mrr ?? 0) * rate, revenue28d: r.rev * rate, activeSubscriptions: r.subs ?? 0, activeTrials: r.trials ?? 0 };
  return { currency, stats: out };
});
