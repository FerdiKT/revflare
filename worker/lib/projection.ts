// Revenue projection (docs/projection.md): loads the workspace's transactions and live subscription states inside the
// database object, runs the model (worker/lib/projection-model.ts) from today and, for the backtest, from 30 and 60
// days ago, and serves the result. Computed at most once per UTC day and scope (memory of the database object): the
// projection moves slowly and its cost is a read of the workspace's transactions of the last ~2 years.

import {
  PROJECTION_HORIZONS,
  type Projection,
  type ProjectionBacktest,
  type ProjectionBand,
  type ProjectionHorizon,
  type ProjectionPoint,
  type ProjectionSummary,
  type ProjectionTotals,
} from "../../shared/types";
import { defineDbFunction, type Db } from "./db";
import { workspaceCurrency, type Scope } from "./metrics";
import { addDays, dayOf, FxCache } from "./money";
import { actuals, bandOf, cumulativeBand, DAY, runModel, STATE_WEIGHTS, type LiveSub, type ModelOutput, type PTx, type SeriesOut } from "./projection-model";
import { getSetting, setSetting } from "./settings";
import { now, parseJson } from "./util";

export const PROJECTION_DAYS = 365;
/** Backtests: the model as of this many days ago, against what happened since. */
export const BACKTEST_DAYS = [30, 60];
/** Transactions read: two years (annual renewal history) plus the backtest's offset. */
const HISTORY_MS = 800 * DAY;
const MAX_ROWS = 500_000;
const BACKTEST_DRAWS = 100;

const cache = new Map<string, Projection>();

interface TxRow {
  app_id: string;
  original_transaction_id: string;
  product_id: string;
  product_type: string | null;
  kind: string;
  offer_type: number | null;
  offer_discount_type: string | null;
  period: string | null;
  purchased_at: number;
  expires_at: number | null;
  gross_usd: number;
  proceeds_usd: number;
  price_milli: number;
  currency: string | null;
  refunded_at: number | null;
  refund_milli: number | null;
  revoked_at: number | null;
  is_upgraded: number;
}

async function load(db: Db, workspaceId: string, at: number) {
  const { results } = await db
    .prepare(
      `SELECT app_id, original_transaction_id, product_id, product_type, kind, offer_type, offer_discount_type, period, purchased_at, expires_at,
         gross_usd, proceeds_usd, price_milli, currency, refunded_at, refund_milli, revoked_at, is_upgraded
       FROM transactions WHERE workspace_id = ? AND purchased_at >= ? AND environment = 'Production' LIMIT ?`,
    )
    .bind(workspaceId, at - HISTORY_MS, MAX_ROWS + 1)
    .all<TxRow>();
  const txs: PTx[] = results.slice(0, MAX_ROWS).map((r) => ({
    app: r.app_id,
    otid: r.original_transaction_id,
    product: r.product_id,
    type: r.product_type ?? "auto_renewable",
    kind: r.kind,
    offerType: r.offer_type,
    offerDiscount: r.offer_discount_type,
    period: r.period,
    at: r.purchased_at,
    expires: r.expires_at,
    gross: r.gross_usd,
    proceeds: r.proceeds_usd,
    priceMilli: r.price_milli,
    currency: r.currency,
    refunded: r.refunded_at === null ? 0 : r.refund_milli == null ? 1 : Math.min(1, Math.max(0, r.refund_milli / 100_000)),
    refundedAt: r.refunded_at,
    revokedAt: r.revoked_at,
    upgraded: !!r.is_upgraded,
  }));
  const { results: subs } = await db
    .prepare(
      `SELECT app_id, original_transaction_id, status, auto_renew, expires_at, renewal_price_usd FROM subscriptions
       WHERE workspace_id = ? AND environment = 'Production' AND (expires_at IS NULL OR expires_at >= ?)`,
    )
    .bind(workspaceId, at - 61 * DAY)
    .all<{ app_id: string; original_transaction_id: string; status: string; auto_renew: number; expires_at: number | null; renewal_price_usd: number | null }>();
  const live = new Map<string, LiveSub>();
  for (const s of subs) live.set(`${s.app_id}\u0000${s.original_transaction_id}`, { status: s.status, autoRenew: !!s.auto_renew, expires: s.expires_at, renewalPriceUsd: s.renewal_price_usd });
  const { results: apps } = await db.prepare("SELECT id, name FROM apps WHERE workspace_id = ?").bind(workspaceId).all<{ id: string; name: string }>();
  return { txs, live, truncated: results.length > MAX_ROWS, names: new Map(apps.map((a) => [a.id, a.name])) };
}

const sumRange = (arrs: Float64Array[], from: number, to: number) => {
  let v = 0;
  for (const a of arrs) for (let i = from; i < to; i++) v += a[i];
  return v;
};

/** Daily or weekly points with bands (percentiles of the bucket sums across draws). */
function points(out: ModelOutput, size: number): ProjectionPoint[] {
  const res: ProjectionPoint[] = [];
  const from = dayOf(out.start);
  const total = (s: SeriesOut) => [s.renewals, s.newSubs, s.oneTime];
  for (let i = 0; i < out.days; i += size) {
    const j = Math.min(out.days, i + size);
    const e = out.expected;
    const band = (pick: (s: SeriesOut) => Float64Array[]) => bandOf(sumRange(pick(e), i, j), out.draws.map((d) => sumRange(pick(d), i, j)));
    const level = (pick: (s: SeriesOut) => Float64Array) => bandOf(pick(e)[j - 1], out.draws.map((d) => pick(d)[j - 1]));
    res.push({
      date: addDays(from, i),
      renewals: band((s) => [s.renewals]),
      newSubscribers: sumRange([e.newSubs], i, j),
      oneTime: sumRange([e.oneTime], i, j),
      total: band(total),
      renewalsGross: sumRange([e.renewalsGross], i, j),
      totalGross: sumRange([e.renewalsGross, e.newSubsGross, e.oneTimeGross], i, j),
      mrr: level((s) => s.mrr),
      mrrWithNew: level((s) => s.mrrWithNew),
    });
  }
  return res;
}

function totalsOf(out: ModelOutput, n: number): ProjectionTotals {
  const e = out.expected;
  const last = Math.min(n, out.days) - 1;
  return {
    existing: cumulativeBand(out, n, (s) => [s.renewals]),
    withNew: cumulativeBand(out, n, (s) => [s.renewals, s.newSubs, s.oneTime]),
    existingGross: sumRange([e.renewalsGross], 0, n),
    withNewGross: sumRange([e.renewalsGross, e.newSubsGross, e.oneTimeGross], 0, n),
    components: { renewals: sumRange([e.renewals], 0, n), newSubscribers: sumRange([e.newSubs], 0, n), oneTime: sumRange([e.oneTime], 0, n) },
    mrr: bandOf(e.mrr[last], out.draws.map((d) => d.mrr[last])),
    mrrWithNew: bandOf(e.mrrWithNew[last], out.draws.map((d) => d.mrrWithNew[last])),
  };
}

const errorOf = (predicted: number, actual: number) => (actual > 0 ? (predicted - actual) / actual : null);
const inBand = (b: ProjectionBand, v: number) => v >= b.low && v <= b.high;

function backtest(txs: PTx[], perUsd: (c: string | null) => number, rate: number, apps: Set<string> | null, today: number, days: number): ProjectionBacktest | null {
  const at = today - days * DAY;
  // No history before the start: nothing to learn from.
  if (!txs.some((t) => t.at < at - 30 * DAY && (!apps || apps.has(t.app)))) return null;
  const out = runModel({ txs, perUsd, rate, at, days, apps, draws: BACKTEST_DRAWS, seed: days });
  const act = actuals(txs, at, today, out.activeKeys, apps, rate);
  const existing = cumulativeBand(out, days, (s) => [s.renewals]);
  const withNew = cumulativeBand(out, days, (s) => [s.renewals, s.newSubs, s.oneTime]);
  return {
    asOf: dayOf(at),
    days,
    existing: { predicted: existing, actual: act.existing, error: errorOf(existing.expected, act.existing), inBand: inBand(existing, act.existing) },
    withNew: { predicted: withNew, actual: act.all, error: errorOf(withNew.expected, act.all), inBand: inBand(withNew, act.all) },
  };
}

async function compute(db: Db, args: Scope): Promise<Projection> {
  const t = now();
  const today = Math.floor(t / DAY) * DAY;
  const { currency, rate } = await workspaceCurrency(db, args);
  const { txs, live, truncated, names } = await load(db, args.workspaceId, t);
  const fx = new FxCache(db);
  const perUsdMap = new Map<string, number>();
  for (const c of new Set(txs.map((x) => (x.currency ?? "USD").toUpperCase()))) perUsdMap.set(c, await fx.perUsd(c, dayOf(t)));
  const perUsd = (c: string | null) => perUsdMap.get((c ?? "USD").toUpperCase()) ?? 1;
  const apps = args.appIds?.length ? new Set(args.appIds) : null;

  const out = runModel({ txs, live, perUsd, rate, at: t, days: PROJECTION_DAYS, apps });
  const totals = Object.fromEntries(Object.entries(PROJECTION_HORIZONS).map(([k, n]) => [k, totalsOf(out, n)])) as Record<ProjectionHorizon, ProjectionTotals>;
  const backtests = BACKTEST_DAYS.map((d) => backtest(txs, perUsd, rate, apps, today, d)).filter((b): b is ProjectionBacktest => !!b);
  const mae = (pick: (b: ProjectionBacktest) => number | null) => {
    const v = backtests.map(pick).filter((x): x is number => x !== null);
    return v.length ? v.reduce((s, x) => s + Math.abs(x), 0) / v.length : null;
  };

  const notes: string[] = [];
  if (truncated) notes.push(`Only the first ${MAX_ROWS.toLocaleString("en-US")} transactions of the last two years were read: the projection is partial.`);
  const lowSegments = out.segments.filter((s) => s.lowData);
  if (lowSegments.length) notes.push(`${lowSegments.length} segment${lowSegments.length === 1 ? " has" : "s have"} fewer than 30 observed renewals: their rates lean on the portfolio average (wider bands).`);
  if (out.inputs.skipped) notes.push(`${out.inputs.skipped} active subscription${out.inputs.skipped === 1 ? "" : "s"} without a known price or billing period left out.`);
  notes.push("Bands cover the uncertainty of the measured rates and volumes only (not seasonality, price changes or launches): the backtest shows the model's real error.");

  // The overview line: next 30 days with new subscribers, and its value as computed yesterday (one write a day).
  const next30 = totals.d30.withNew.expected;
  const scopeKey = apps ? [...apps].sort().join(",") : "all";
  const histKey = `projection30:${args.workspaceId}:${currency}:${scopeKey}`;
  const hist = parseJson<Record<string, number>>(await getSetting(db, histKey), {});
  const day = dayOf(t);
  const previous = hist[addDays(day, -1)] ?? null;
  if (hist[day] === undefined) {
    hist[day] = next30;
    const keep = Object.keys(hist).sort().slice(-14);
    await setSetting(db, histKey, JSON.stringify(Object.fromEntries(keep.map((k) => [k, hist[k]]))));
  }

  const name = (id: string) => names.get(id) ?? null;
  const appList = [...out.apps.entries()]
    .map(([appId, a]) => ({
      appId,
      name: names.get(appId) ?? appId,
      mrrNow: a.mrrNow,
      totals: Object.fromEntries(
        Object.entries(PROJECTION_HORIZONS).map(([k, n]) => {
          const i = Math.min(n, out.days) - 1;
          return [k, { existing: bandOf(a.existing[i], a.drawsExisting.map((d) => d[i])), withNew: bandOf(a.withNew[i], a.drawsWithNew.map((d) => d[i])) }];
        }),
      ) as Projection["apps"][number]["totals"],
    }))
    .sort((x, y) => y.totals.d365.withNew.expected - x.totals.d365.withNew.expected);

  const scoped = (id: string) => !apps || apps.has(id);
  return {
    currency,
    from: day,
    days: PROJECTION_DAYS,
    generatedAt: t,
    summary: { next30, next30Previous: previous, next30Change: previous === null ? null : next30 - previous, mrrNow: out.inputs.mrrNow },
    totals,
    daily: points(out, 1),
    weekly: points(out, 7),
    apps: appList,
    segments: out.segments.map((s) => ({ appId: s.app, appName: name(s.app), period: s.period, stage: s.stage, observed: s.observed, renewed: s.renewed, observedRate: s.observedRate, rate: s.rate, low: s.low, high: s.high, lowData: s.lowData, source: s.source })),
    upcoming: {
      count: out.upcoming.length,
      price: out.upcoming.reduce((s, u) => s + u.price, 0),
      expectedProceeds: out.upcoming.reduce((s, u) => s + u.expectedProceeds, 0),
      items: out.upcoming.slice(0, 100).map((u) => ({ appId: u.app, appName: name(u.app), productId: u.product, period: u.period, date: u.date, price: u.price, expectedProceeds: u.expectedProceeds, probability: u.probability, status: u.status, stage: u.stage })),
    },
    backtest: backtests,
    backtestError: { withNew: mae((b) => b.withNew.error), existing: mae((b) => b.existing.error) },
    inputs: {
      activeSubscriptions: out.inputs.active,
      trials: out.inputs.trials,
      autoRenewOff: out.inputs.off,
      billingRetry: out.inputs.retry,
      grace: out.inputs.grace,
      skipped: out.inputs.skipped,
      newStartsPerDay: out.inputs.newStartsPerDay,
      oneTimePerDay: out.inputs.oneTimePerDay,
    },
    assumptions: {
      proceedsShare: [...out.proceedsShare].filter(([id]) => scoped(id)).map(([appId, p]) => ({ appId, firstYear: p.firstYear, afterYear: p.afterYear, afterYearAssumed: p.afterYearAssumed })),
      refundShare: [...out.refundShare].filter(([id]) => scoped(id)).map(([appId, r]) => ({ appId, share: r.share })),
      weights: { autoRenewOff: STATE_WEIGHTS.off, billingRetry: STATE_WEIGHTS.retry, grace: STATE_WEIGHTS.grace },
    },
    notes,
  };
}

/** The projection of a scope (all apps or `appIds`), computed at most once per UTC day. */
export const projection = defineDbFunction("projection", async (db, args: Scope): Promise<Projection> => {
  const k = `${args.workspaceId}:${args.currency ?? ""}:${args.appIds?.length ? [...args.appIds].sort().join(",") : "all"}:${dayOf(now())}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const p = await compute(db, args);
  cache.set(k, p);
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  return p;
});

export function summaryOf(p: Projection): ProjectionSummary {
  return { ...p.summary, currency: p.currency, generatedAt: p.generatedAt, next30Band: p.totals.d30.withNew, backtestError: p.backtestError };
}
