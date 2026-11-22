// Revenue projection model (docs/projection.md). Pure: no database, so it is unit tested in node and replayed on the
// past for the backtest. worker/lib/projection.ts loads the inputs and serves the result.
//
// 1. Every auto-renewable subscription is rebuilt from its transactions as of a day T (only what was known by then).
//    The stage of its current transaction says what its next payment would be: a trial's conversion (`trial`), the
//    full price after a paid introductory offer (`intro`), or the 1st / 2nd / 3rd-and-later renewal (`r1`/`r2`/`r3`;
//    the number of paid periods so far).
// 2. Renewal rates are measured per app × billing period × stage from the periods that ended before T (did the same
//    subscription pay again?), as Beta posteriors shrunk towards the portfolio (all apps, same period and stage),
//    itself shrunk towards the stage over every period, then towards a fixed default: a segment with few renewals
//    (< 30) leans on the portfolio, with a wide interval, instead of showing a made-up precise rate.
// 3. Each subscription is walked forward over the horizon: payment j happens at its renewal date with the chained
//    probability of every payment before; its amount is the product's full price in the buyer's currency at today's
//    exchange rate, × (1 − the app's refund share), × the app's proceeds share (first year, then after a year of paid
//    service: Apple's 30 % → 15 %). The next payment of a subscription whose auto-renew is off, in billing retry or in
//    grace gets a fixed weight; the others' rate is raised so the segment's total still matches the measured rate.
// 4. New subscribers (the last 28 days' starts per app, product and start kind, walked the same way from their start)
//    and one-time purchases (the last 28 days' daily average) are separate lines: "existing" leaves them out.
// 5. Bands: the same walk for DRAWS seeded draws of every rate from its posterior (and of the new-start and one-time
//    counts, Gamma): the 5th / 95th percentiles per day, per week and of the cumulative totals. They only cover the
//    uncertainty of the measured rates and volumes: the backtest shows how far the model has been from reality.

import { beta, gamma, rng, seedOf } from "./experiment-stats";

export const DAY = 86_400_000;
export const STAGES = ["trial", "intro", "r1", "r2", "r3"] as const;
export type Stage = (typeof STAGES)[number];

/** Next payment weights of subscriptions that will most likely not renew on time (assumptions, not measured). */
export const STATE_WEIGHTS = { off: 0.05, retry: 0.25, grace: 0.6 } as const;
export type SubFlag = "on" | "off" | "retry" | "grace";
/** Segments with fewer observed renewals than this lean on the portfolio (shown as low data). */
export const LOW_DATA = 30;
/**
 * Pseudo-observations of the parent rate in a segment's prior: at most this many, and never more than the parent's own
 * evidence (a parent with no history cannot lend precision). The stage over every billing period is weak evidence for
 * one period: it counts as `stage` observations whatever its size.
 */
const PRIOR_WEIGHT = { app: 30, stage: 4 };
/** Fallback rates when even the whole portfolio has (almost) no history for a stage. */
export const DEFAULT_RATES: Record<Stage, number> = { trial: 0.3, intro: 0.5, r1: 0.55, r2: 0.7, r3: 0.8 };
export const DEFAULT_DRAWS = 300;
/** Periods that ended in the last days are not counted yet (billing retry, late notifications). */
const SETTLE_MS = 3 * DAY;
const SHORT_LOOKBACK = 90 * DAY;
const MONTH_LOOKBACK = 180 * DAY;
const LONG_LOOKBACK = 400 * DAY;
/** New subscribers and one-time purchases: the daily average of this window. */
export const FLOW_WINDOW = 28;
const TENURE_SPLIT = 365 * DAY;

/** One transaction (USD as stored; refunds as known now: `refundedAt` tells when). */
export interface PTx {
  app: string;
  otid: string;
  product: string;
  /** auto_renewable or anything else (one-time purchases, passes). */
  type: string;
  kind: string;
  offerType: number | null;
  offerDiscount: string | null;
  period: string | null;
  at: number;
  expires: number | null;
  gross: number;
  proceeds: number;
  /** Local price (milli-units) and currency. */
  priceMilli: number;
  currency: string | null;
  /** Share refunded (0..1) and when. */
  refunded: number;
  refundedAt: number | null;
  revokedAt: number | null;
  upgraded: boolean;
}

/** Live subscription state (subscriptions table): only for the projection from today, not the backtest. */
export interface LiveSub {
  status: string;
  autoRenew: boolean;
  expires: number | null;
  renewalPriceUsd: number | null;
}

export interface ModelInput {
  txs: PTx[];
  /** `${app}\u0000${otid}` → live state (omit for a backtest: every subscription then counts as renewing). */
  live?: Map<string, LiveSub> | null;
  /** Local currency units per USD today. */
  perUsd: (currency: string | null) => number;
  /** Workspace currency units per USD today. */
  rate: number;
  /** The projection starts on this day (UTC midnight of T's day = day 0). */
  at: number;
  days: number;
  /** Apps in the scope (null: every app). Rates are always measured over the whole portfolio. */
  apps?: Set<string> | null;
  draws?: number;
  seed?: number;
}

export interface Band {
  expected: number;
  low: number;
  high: number;
}

export interface SegmentOut {
  app: string;
  period: string;
  stage: Stage;
  observed: number;
  renewed: number;
  observedRate: number | null;
  rate: number;
  low: number;
  high: number;
  lowData: boolean;
  source: "app" | "portfolio" | "default";
}

export interface UpcomingOut {
  app: string;
  product: string;
  period: string;
  date: number;
  /** Full price (workspace currency, before refunds and commission). */
  price: number;
  expectedProceeds: number;
  probability: number;
  status: SubFlag;
  stage: Stage;
}

export interface SeriesOut {
  /** Proceeds per day: existing subscribers' payments, new subscribers, one-time purchases. */
  renewals: Float64Array;
  renewalsGross: Float64Array;
  newSubs: Float64Array;
  newSubsGross: Float64Array;
  oneTime: Float64Array;
  oneTimeGross: Float64Array;
  /** MRR (gross, workspace currency) at the end of each day: existing subscriptions, and with new subscribers. */
  mrr: Float64Array;
  mrrWithNew: Float64Array;
}

export interface ModelOutput {
  days: number;
  start: number;
  expected: SeriesOut;
  /** Per draw (bands). */
  draws: SeriesOut[];
  /** Per app: cumulative proceeds per day index, expected and per draw (existing / with new). */
  apps: Map<string, { existing: Float64Array; withNew: Float64Array; drawsExisting: Float64Array[]; drawsWithNew: Float64Array[]; mrrNow: number }>;
  segments: SegmentOut[];
  upcoming: UpcomingOut[];
  proceedsShare: Map<string, { firstYear: number; afterYear: number; afterYearAssumed: boolean; sample: number }>;
  refundShare: Map<string, { share: number; sample: number }>;
  inputs: { active: number; trials: number; off: number; retry: number; grace: number; skipped: number; newStartsPerDay: number; oneTimePerDay: number; mrrNow: number };
  /** Subscriptions active at T (keys), for the backtest's actuals. */
  activeKeys: Set<string>;
}

// --- Helpers --------------------------------------------------------------------------------------------------------

export function periodDays(period: string | null | undefined): number | null {
  const m = /^P(\d+)([DWMY])$/.exec(period ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "D" ? n : m[2] === "W" ? n * 7 : m[2] === "M" ? n * 30.436875 : n * 365.25;
}

const lookback = (period: string) => {
  const d = periodDays(period) ?? 30;
  return d <= 7 ? SHORT_LOOKBACK : d <= 31 ? MONTH_LOOKBACK : LONG_LOOKBACK;
};

export const dayIndex = (start: number, t: number) => Math.floor((t - start) / DAY);
const isTrial = (t: PTx) => t.offerDiscount === "FREE_TRIAL" || (t.kind === "trial" && t.gross === 0);
const isIntro = (t: PTx) => !isTrial(t) && t.offerType === 1;
const stageOf = (t: PTx, paidOrder: number): Stage => (isTrial(t) ? "trial" : isIntro(t) ? "intro" : paidOrder <= 1 ? "r1" : paidOrder === 2 ? "r2" : "r3");
const afterPayment = (paidOrder: number): Stage => (paidOrder <= 1 ? "r1" : paidOrder === 2 ? "r2" : "r3");
const key = (app: string, otid: string) => `${app}\u0000${otid}`;

function percentile(sorted: Float64Array, q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** 5th / 95th percentiles of values across draws. */
export function bandOf(expected: number, values: ArrayLike<number>): Band {
  const s = Float64Array.from(values as ArrayLike<number>).sort();
  return { expected, low: Math.min(expected, percentile(s, 0.05)), high: Math.max(expected, percentile(s, 0.95)) };
}

// --- Measurement ----------------------------------------------------------------------------------------------------

interface Group {
  app: string;
  otid: string;
  txs: PTx[];
}

function groupsOf(txs: PTx[]): Group[] {
  const map = new Map<string, Group>();
  for (const t of txs) {
    if (t.type !== "auto_renewable") continue;
    const k = key(t.app, t.otid);
    let g = map.get(k);
    if (!g) map.set(k, (g = { app: t.app, otid: t.otid, txs: [] }));
    g.txs.push(t);
  }
  for (const g of map.values()) g.txs.sort((a, b) => a.at - b.at);
  return [...map.values()];
}

/** Billing period of each product (the most common period of its paid transactions), and full prices per currency. */
function productInfo(txs: PTx[], at: number) {
  const periods = new Map<string, Map<string, number>>();
  const prices = new Map<string, { at: number; milli: number; usd: number }>();
  const usd = new Map<string, { at: number; usd: number }>();
  for (const t of txs) {
    if (t.at > at || t.type !== "auto_renewable" || isTrial(t) || t.gross <= 0) continue;
    if (t.period) {
      const m = periods.get(t.product) ?? new Map<string, number>();
      m.set(t.period, (m.get(t.period) ?? 0) + 1);
      periods.set(t.product, m);
    }
    if (t.offerType) continue;
    const k = `${t.product}\u0000${t.currency ?? "USD"}`;
    const p = prices.get(k);
    if (!p || t.at > p.at) prices.set(k, { at: t.at, milli: t.priceMilli, usd: t.gross });
    const u = usd.get(t.product);
    if (!u || t.at > u.at) usd.set(t.product, { at: t.at, usd: t.gross });
  }
  const period = new Map<string, string>();
  for (const [p, m] of periods) period.set(p, [...m].sort((a, b) => b[1] - a[1])[0][0]);
  return { period, prices, usd };
}

interface Obs {
  n: number;
  x: number;
}

interface RateSeg {
  idx: number;
  app: string;
  period: string;
  stage: Stage;
  obs: Obs;
  a: number;
  b: number;
  mean: number;
  source: SegmentOut["source"];
}

/** Renewal observations as of `at`: periods that ended in the lookback (before the settle margin) and whether the subscription paid again by `at`. */
function observe(groups: Group[], period: Map<string, string>, at: number) {
  const obs = new Map<string, Obs>();
  const add = (k: string, renewed: boolean) => {
    const o = obs.get(k) ?? { n: 0, x: 0 };
    o.n++;
    if (renewed) o.x++;
    obs.set(k, o);
  };
  for (const g of groups) {
    let paid = 0;
    const known = g.txs.filter((t) => t.at <= at);
    for (let i = 0; i < known.length; i++) {
      const t = known[i];
      if (!isTrial(t)) paid++;
      if (t.expires === null || t.upgraded || (t.refundedAt !== null && t.refundedAt <= at) || (t.revokedAt !== null && t.revokedAt <= at)) continue;
      const p = isTrial(t) ? period.get(t.product) : (t.period ?? period.get(t.product));
      if (!p) continue;
      if (t.expires >= at - SETTLE_MS || t.expires < at - lookback(p)) continue;
      const renewed = known.slice(i + 1).some((n) => !isTrial(n) && n.at > t.at);
      const stage = stageOf(t, paid);
      add(`${g.app}\u0000${p}\u0000${stage}`, renewed);
    }
  }
  return obs;
}

/** Hierarchical Beta posteriors: app × period × stage → portfolio period × stage → stage → default. */
function buildRates(obs: Map<string, Obs>) {
  const pool = new Map<string, Obs>();
  const byStage = new Map<Stage, Obs>();
  for (const [k, o] of obs) {
    const [, period, stage] = k.split("\u0000") as [string, string, Stage];
    const p = pool.get(`${period}\u0000${stage}`) ?? { n: 0, x: 0 };
    p.n += o.n;
    p.x += o.x;
    pool.set(`${period}\u0000${stage}`, p);
    const s = byStage.get(stage) ?? { n: 0, x: 0 };
    s.n += o.n;
    s.x += o.x;
    byStage.set(stage, s);
  }
  const stageMean = (stage: Stage) => {
    const o = byStage.get(stage) ?? { n: 0, x: 0 };
    const K = PRIOR_WEIGHT.stage;
    return (DEFAULT_RATES[stage] * K + o.x) / (K + o.n);
  };
  /** Portfolio period × stage: its mean and its evidence (observations + the stage prior's weight). */
  const poolOf = (period: string, stage: Stage) => {
    const o = pool.get(`${period}\u0000${stage}`) ?? { n: 0, x: 0 };
    const K = PRIOR_WEIGHT.stage;
    return { mean: (stageMean(stage) * K + o.x) / (K + o.n), evidence: K + o.n };
  };
  const segs = new Map<string, RateSeg>();
  const list: RateSeg[] = [];
  const get = (app: string, period: string, stage: Stage): RateSeg => {
    const k = `${app}\u0000${period}\u0000${stage}`;
    let s = segs.get(k);
    if (s) return s;
    const o = obs.get(k) ?? { n: 0, x: 0 };
    const portfolio = pool.get(`${period}\u0000${stage}`) ?? { n: 0, x: 0 };
    const parent = poolOf(period, stage);
    const m = parent.mean;
    const K = Math.min(PRIOR_WEIGHT.app, parent.evidence);
    const a = m * K + o.x;
    const b = (1 - m) * K + (o.n - o.x);
    const source: SegmentOut["source"] = o.n >= LOW_DATA ? "app" : portfolio.n >= LOW_DATA ? "portfolio" : "default";
    s = { idx: list.length, app, period, stage, obs: o, a, b, mean: a / (a + b), source };
    segs.set(k, s);
    list.push(s);
    return s;
  };
  return { get, list };
}

/** Proceeds share per app (first year / after a year of paid service) and refund share, from the last 180 days' paid transactions (an app without any: all of its history). */
function appShares(groups: Group[], txs: PTx[], at: number) {
  const recent = appSharesFrom(groups, txs, at, at - 180 * DAY);
  const all = appSharesFrom(groups, txs, at, -Infinity);
  for (const [app, v] of all.proceedsShare) if (!recent.proceedsShare.has(app)) recent.proceedsShare.set(app, v);
  for (const [app, v] of all.refundShare) if (!recent.refundShare.has(app)) recent.refundShare.set(app, v);
  return recent;
}

function appSharesFrom(groups: Group[], txs: PTx[], at: number, from: number) {
  const tenure = new Map<string, { g1: number; p1: number; n1: number; g2: number; p2: number; n2: number }>();
  const refunds = new Map<string, { gross: number; refunded: number; n: number }>();
  for (const g of groups) {
    let first: number | null = null;
    for (const t of g.txs) {
      if (t.at > at || isTrial(t) || t.gross <= 0) continue;
      first ??= t.at;
      if (t.at < from) continue;
      const s = tenure.get(g.app) ?? { g1: 0, p1: 0, n1: 0, g2: 0, p2: 0, n2: 0 };
      if (t.at - first < TENURE_SPLIT) {
        s.g1 += t.gross;
        s.p1 += t.proceeds;
        s.n1++;
      } else {
        s.g2 += t.gross;
        s.p2 += t.proceeds;
        s.n2++;
      }
      tenure.set(g.app, s);
    }
  }
  for (const t of txs) {
    if (t.at > at || t.at < from || isTrial(t) || t.gross <= 0) continue;
    const r = refunds.get(t.app) ?? { gross: 0, refunded: 0, n: 0 };
    r.gross += t.gross;
    r.n++;
    if (t.refundedAt !== null && t.refundedAt <= at) r.refunded += t.gross * t.refunded;
    refunds.set(t.app, r);
  }
  const proceedsShare = new Map<string, { firstYear: number; afterYear: number; afterYearAssumed: boolean; sample: number }>();
  for (const [app, s] of tenure) {
    const all = s.g1 + s.g2 > 0 ? (s.p1 + s.p2) / (s.g1 + s.g2) : 0.7;
    const firstYear = s.n1 >= 10 && s.g1 > 0 ? s.p1 / s.g1 : all;
    // Apple: 30 % commission in the first year of paid service, 15 % after (VAT comes off both). An app already at
    // 15 % (Small Business Program, Google Play subscriptions) keeps its share.
    const assumed = firstYear <= 0.76 ? Math.min(0.95, (firstYear * 0.85) / 0.7) : firstYear;
    const measured = s.n2 >= LOW_DATA && s.g2 > 0;
    proceedsShare.set(app, { firstYear, afterYear: measured ? s.p2 / s.g2 : assumed, afterYearAssumed: !measured, sample: s.n1 + s.n2 });
  }
  const refundShare = new Map<string, { share: number; sample: number }>();
  for (const [app, r] of refunds) refundShare.set(app, { share: r.gross > 0 ? Math.min(0.9, r.refunded / r.gross) : 0, sample: r.n });
  return { proceedsShare, refundShare };
}

// --- Walk -------------------------------------------------------------------------------------------------------------

interface Walker {
  app: string;
  product: string;
  period: string;
  periodMs: number;
  /** Rate segment index per stage. */
  seg: Record<Stage, number>;
  stage: Stage;
  paid: number;
  firstPaid: number | null;
  next: number;
  /** USD full price of a payment, and the current period's monthly price (0 in a trial). */
  price: number;
  currentMonthly: number;
  flag: SubFlag;
}

interface Template {
  app: string;
  w: Walker;
  /** Starts in the flow window and the payment at the start (paid at once / intro; 0 for a trial). */
  starts: number;
  startPrice: number;
  /** Trial (or intro period) length. */
  firstLength: number;
}

/**
 * Walks one subscription over the horizon with the rates `r` (by segment index): adds the expected proceeds of each
 * payment to `rev` (and gross to `gross`) at its day, and the expected MRR to the difference array `mrr`.
 */
function walk(
  w: Walker,
  r: Float64Array,
  firstP: number,
  start: number,
  days: number,
  shares: { share1: number; share2: number; refund: number; fx: number },
  rev: Float64Array,
  gross: Float64Array | null,
  mrr: Float64Array,
  offset = 0,
): void {
  let alive = 1;
  let stage = w.stage;
  let paid = w.paid;
  let firstPaid = w.firstPaid;
  let t = w.next;
  const monthly = (w.price * 30.436875) / (w.periodMs / DAY);
  // Current period: its monthly price until the next payment date.
  if (w.currentMonthly > 0) {
    const s = Math.max(0, offset);
    const e = Math.min(days, dayIndex(start, t));
    if (e > s) {
      mrr[s] += w.currentMonthly * shares.fx;
      mrr[e] -= w.currentMonthly * shares.fx;
    }
  }
  let first = true;
  for (let j = 0; j < 2000; j++) {
    const d = dayIndex(start, t);
    if (d >= days) return;
    const p = first ? firstP : r[w.seg[stage]];
    first = false;
    alive *= p;
    if (alive < 1e-5) return;
    paid++;
    firstPaid ??= t;
    const share = t - firstPaid < TENURE_SPLIT ? shares.share1 : shares.share2;
    const amount = w.price * (1 - shares.refund) * shares.fx;
    if (d >= 0) {
      rev[d] += alive * amount * share;
      if (gross) gross[d] += alive * amount;
    }
    const nextT = t + w.periodMs;
    const s = Math.max(0, d);
    const e = Math.min(days, dayIndex(start, nextT));
    if (e > s) {
      mrr[s] += alive * monthly * shares.fx;
      mrr[e] -= alive * monthly * shares.fx;
    }
    stage = afterPayment(paid);
    t = nextT;
  }
}

function newSeries(days: number): SeriesOut {
  const f = () => new Float64Array(days + 1);
  return { renewals: f(), renewalsGross: f(), newSubs: f(), newSubsGross: f(), oneTime: f(), oneTimeGross: f(), mrr: f(), mrrWithNew: f() };
}


// --- Model -------------------------------------------------------------------------------------------------------------

export function runModel(input: ModelInput): ModelOutput {
  const days = input.days;
  const T = input.at;
  const start = Math.floor(T / DAY) * DAY;
  const draws = input.draws ?? DEFAULT_DRAWS;
  const inScope = (app: string) => !input.apps || input.apps.has(app);
  const known = input.txs.filter((t) => t.at <= T);
  const groups = groupsOf(known);
  const info = productInfo(known, T);
  const rates = buildRates(observe(groups, info.period, T));
  const { proceedsShare, refundShare } = appShares(groups, known, T);
  const sharesOf = (app: string) => {
    const ps = proceedsShare.get(app);
    return { share1: ps?.firstYear ?? 0.7, share2: ps?.afterYear ?? 0.85, refund: refundShare.get(app)?.share ?? 0, fx: input.rate };
  };
  /** USD price today of a product's full price for this buyer's currency (else its last USD price). */
  const priceOf = (product: string, currency: string | null, fallback: number): number => {
    const p = info.prices.get(`${product}\u0000${currency ?? "USD"}`);
    if (p && p.milli > 0) return p.milli / 1000 / input.perUsd(currency);
    return info.usd.get(product)?.usd ?? fallback;
  };
  const segsFor = (app: string, period: string): Record<Stage, number> =>
    Object.fromEntries(STAGES.map((s) => [s, rates.get(app, period, s).idx])) as Record<Stage, number>;

  // Existing subscriptions at T.
  const walkers: Walker[] = [];
  const activeKeys = new Set<string>();
  const inputs = { active: 0, trials: 0, off: 0, retry: 0, grace: 0, skipped: 0, newStartsPerDay: 0, oneTimePerDay: 0, mrrNow: 0 };
  for (const g of groups) {
    if (!inScope(g.app)) continue;
    const txs = g.txs;
    let last: PTx | null = null;
    let paid = 0;
    let firstPaid: number | null = null;
    let lastFull: PTx | null = null;
    for (const t of txs) {
      if (!isTrial(t)) {
        paid++;
        firstPaid ??= t.at;
        if (!t.offerType && t.gross > 0) lastFull = t;
      }
      last = t;
    }
    if (!last || last.expires === null) continue;
    const live = input.live?.get(key(g.app, g.otid));
    let flag: SubFlag = "on";
    let next = last.expires;
    if (input.live) {
      if (live && ["expired", "revoked", "refunded"].includes(live.status)) continue;
      if (live?.status === "billing_retry") flag = "retry";
      else if (live?.status === "grace") flag = "grace";
      else if (live && !live.autoRenew) flag = "off";
      if (flag === "retry" || flag === "grace") {
        if (last.expires < T - 60 * DAY) continue;
        next = Math.max(next, T + DAY);
      }
    }
    if ((last.refundedAt !== null && last.refundedAt <= T) || (last.revokedAt !== null && last.revokedAt <= T)) continue;
    if (flag === "on" || flag === "off") {
      if (last.expires <= T) continue;
    }
    const period = isTrial(last) ? info.period.get(last.product) : (last.period ?? info.period.get(last.product));
    const periodMs = (periodDays(period) ?? 0) * DAY;
    const fallbackUsd = live?.renewalPriceUsd ?? lastFull?.gross ?? 0;
    const price = priceOf(last.product, last.currency ?? lastFull?.currency ?? null, fallbackUsd);
    if (!period || !periodMs || !(price > 0)) {
      inputs.skipped++;
      continue;
    }
    activeKeys.add(key(g.app, g.otid));
    const stage = stageOf(last, paid);
    const currentUsd = isTrial(last) ? 0 : last.gross > 0 ? last.gross : price;
    const lastPeriodMs = (periodDays(last.period ?? period) ?? periodMs / DAY) * DAY;
    const w: Walker = {
      app: g.app,
      product: last.product,
      period,
      periodMs,
      seg: segsFor(g.app, period),
      stage,
      paid,
      firstPaid,
      next,
      price,
      currentMonthly: currentUsd > 0 ? (currentUsd * 30.436875) / (lastPeriodMs / DAY) : 0,
      flag,
    };
    walkers.push(w);
    inputs.active++;
    if (stage === "trial") inputs.trials++;
    if (flag !== "on") inputs[flag]++;
    inputs.mrrNow += w.currentMonthly * input.rate;
  }

  // New subscribers: starts in the last FLOW_WINDOW days per app, product, start stage and currency.
  const templates = new Map<string, Template>();
  const flowFrom = T - FLOW_WINDOW * DAY;
  for (const g of groups) {
    if (!inScope(g.app)) continue;
    const first = g.txs[0];
    if (!first || first.at < flowFrom || first.at > T) continue;
    const period = isTrial(first) ? info.period.get(first.product) : (first.period ?? info.period.get(first.product));
    const periodMs = (periodDays(period) ?? 0) * DAY;
    const price = priceOf(first.product, first.currency, first.gross);
    if (!period || !periodMs || !(price > 0)) continue;
    const startStage = stageOf(first, isTrial(first) ? 0 : 1);
    const k = `${g.app}\u0000${first.product}\u0000${startStage}\u0000${first.currency ?? "USD"}`;
    let tpl = templates.get(k);
    const firstLength = Math.max(DAY / 24, (first.expires ?? first.at + periodMs) - first.at);
    if (!tpl) {
      const w: Walker = {
        app: g.app,
        product: first.product,
        period,
        periodMs,
        seg: segsFor(g.app, period),
        stage: startStage,
        paid: isTrial(first) ? 0 : 1,
        firstPaid: null,
        next: 0,
        price,
        currentMonthly: 0,
        flag: "on",
      };
      templates.set(k, (tpl = { app: g.app, w, starts: 0, startPrice: 0, firstLength: 0 }));
    }
    tpl.firstLength = (tpl.firstLength * tpl.starts + firstLength) / (tpl.starts + 1);
    // The start's own payment: today's full price (an intro offer: what it cost then).
    const startPrice = isTrial(first) ? 0 : isIntro(first) ? first.gross : price;
    tpl.startPrice = (tpl.startPrice * tpl.starts + startPrice) / (tpl.starts + 1);
    tpl.starts++;
  }
  for (const tpl of templates.values()) inputs.newStartsPerDay += tpl.starts / FLOW_WINDOW;

  // One-time purchases: daily average of the window per app.
  const oneTime = new Map<string, { gross: number; proceeds: number; n: number }>();
  for (const t of known) {
    if (t.type === "auto_renewable" || t.at < flowFrom || !inScope(t.app) || t.gross <= 0) continue;
    const o = oneTime.get(t.app) ?? { gross: 0, proceeds: 0, n: 0 };
    const kept = t.refundedAt !== null && t.refundedAt <= T ? 1 - t.refunded : 1;
    o.gross += t.gross * kept;
    o.proceeds += t.proceeds * kept;
    o.n++;
    oneTime.set(t.app, o);
  }
  for (const o of oneTime.values()) inputs.oneTimePerDay += (o.proceeds * input.rate) / FLOW_WINDOW;

  // Calibration of the next payment: off / retry / grace get their weights, the others' rate is raised so the
  // segment's expected next payments still sum to the measured rate × subscriptions.
  const segCount = new Map<number, { n: number; on: number; fixed: number }>();
  for (const w of walkers) {
    const idx = w.seg[w.stage];
    const c = segCount.get(idx) ?? { n: 0, on: 0, fixed: 0 };
    c.n++;
    if (w.flag === "on") c.on++;
    else c.fixed += STATE_WEIGHTS[w.flag];
    segCount.set(idx, c);
  }
  const firstP = (w: Walker, r: Float64Array) => {
    if (w.flag !== "on") return STATE_WEIGHTS[w.flag];
    const idx = w.seg[w.stage];
    const c = segCount.get(idx)!;
    if (!input.live || c.on === c.n) return r[idx];
    return Math.min(0.95, Math.max(r[idx], (r[idx] * c.n - c.fixed) / c.on));
  };

  const apps = new Map<string, { existing: Float64Array; withNew: Float64Array; drawsExisting: Float64Array[]; drawsWithNew: Float64Array[]; mrrNow: number }>();
  const appEntry = (app: string) => {
    let a = apps.get(app);
    if (!a) apps.set(app, (a = { existing: new Float64Array(days + 1), withNew: new Float64Array(days + 1), drawsExisting: [], drawsWithNew: [], mrrNow: 0 }));
    return a;
  };
  for (const w of walkers) appEntry(w.app).mrrNow += w.currentMonthly * input.rate;
  for (const tpl of templates.values()) appEntry(tpl.app);
  for (const app of oneTime.keys()) appEntry(app);

  /** One full pass with rates `r`, flow multipliers `flowScale(templateIndex)` and one-time multipliers. */
  const pass = (r: Float64Array, flowScale: (i: number) => number, oneScale: (app: string) => number, drawIndex: number | null): SeriesOut => {
    const out = newSeries(days);
    const perApp = new Map<string, { e: Float64Array; n: Float64Array }>();
    const appArr = (app: string) => {
      let a = perApp.get(app);
      if (!a) perApp.set(app, (a = { e: new Float64Array(days + 1), n: new Float64Array(days + 1) }));
      return a;
    };
    for (const w of walkers) walk(w, r, firstP(w, r), start, days, sharesOf(w.app), appArr(w.app).e, out.renewalsGross, out.mrr);
    for (const a of perApp.values()) for (let i = 0; i < days; i++) out.renewals[i] += a.e[i];
    // New subscribers: one start walked from day 0, then spread as `starts / FLOW_WINDOW` a day (cumulative sum).
    let ti = 0;
    for (const tpl of templates.values()) {
      const scale = (flowScale(ti++) * tpl.starts) / FLOW_WINDOW;
      if (!(scale > 0)) continue;
      const sh = sharesOf(tpl.app);
      const f = new Float64Array(days + 1);
      const fg = new Float64Array(days + 1);
      const m = new Float64Array(days + 1);
      // The start's own payment (paid at once or intro) on its day.
      if (tpl.startPrice > 0) {
        f[0] += tpl.startPrice * (1 - sh.refund) * sh.fx * sh.share1;
        fg[0] += tpl.startPrice * (1 - sh.refund) * sh.fx;
      }
      const w: Walker = { ...tpl.w, next: start + tpl.firstLength, firstPaid: tpl.startPrice > 0 ? start : null, currentMonthly: tpl.startPrice > 0 ? (tpl.startPrice * 30.436875 * DAY) / tpl.firstLength : 0 };
      walk(w, r, r[w.seg[w.stage]], start, days, sh, f, fg, m);
      for (let i = 1; i <= days; i++) m[i] += m[i - 1];
      // Starts every day: revenue on day d = scale × Σ_{o ≤ d} f(o) (same for the MRR level).
      let cf = 0;
      let cg = 0;
      let cm = 0;
      const a = appArr(tpl.app);
      for (let d = 0; d < days; d++) {
        cf += f[d];
        cg += fg[d];
        cm += m[d];
        out.newSubs[d] += scale * cf;
        out.newSubsGross[d] += scale * cg;
        out.mrrWithNew[d] += scale * cm;
        a.n[d] += scale * cf;
      }
    }
    for (const [app, o] of oneTime) {
      const k = oneScale(app);
      const a = appArr(app);
      for (let d = 0; d < days; d++) {
        const v = (o.proceeds * input.rate * k) / FLOW_WINDOW;
        out.oneTime[d] += v;
        out.oneTimeGross[d] += (o.gross * input.rate * k) / FLOW_WINDOW;
        a.n[d] += v;
      }
    }
    // MRR: the existing curve from its difference array; with new subscribers on top (already a level).
    for (let i = 1; i <= days; i++) out.mrr[i] += out.mrr[i - 1];
    for (let i = 0; i <= days; i++) out.mrrWithNew[i] += out.mrr[i];
    // Per app cumulative sums.
    for (const [app, a] of perApp) {
      const entry = appEntry(app);
      const ce = new Float64Array(days + 1);
      const cn = new Float64Array(days + 1);
      let se = 0;
      let sn = 0;
      for (let d = 0; d < days; d++) {
        se += a.e[d];
        sn += a.e[d] + a.n[d];
        ce[d] = se;
        cn[d] = sn;
      }
      if (drawIndex === null) {
        entry.existing = ce;
        entry.withNew = cn;
      } else {
        entry.drawsExisting[drawIndex] = ce;
        entry.drawsWithNew[drawIndex] = cn;
      }
    }
    return out;
  };

  // Segments are created lazily while building walkers and templates: the list is complete now.
  const expected = pass(Float64Array.from(rates.list.map((s) => s.mean)), () => 1, () => 1, null);
  const rand = rng(input.seed ?? seedOf(`projection:${start}`));
  const tplCounts = [...templates.values()].map((t) => t.starts);
  const drawsOut: SeriesOut[] = [];
  for (let d = 0; d < draws; d++) {
    const r = Float64Array.from(rates.list.map((s) => beta(Math.max(s.a, 1e-3), Math.max(s.b, 1e-3), rand)));
    const flow = tplCounts.map((c) => (c > 0 ? gamma(c + 0.5, rand) / (c + 0.5) : 0));
    const one = new Map([...oneTime].map(([app, o]) => [app, gamma(o.n + 0.5, rand) / (o.n + 0.5)]));
    drawsOut.push(pass(r, (i) => flow[i], (app) => one.get(app) ?? 1, d));
  }

  // Segments in the scope (with history or subscriptions), and the 95 % interval of their rate.
  const segments: SegmentOut[] = rates.list
    .filter((s) => inScope(s.app) && (s.obs.n > 0 || walkers.some((w) => w.seg[w.stage] === s.idx)))
    .map((s) => {
      const r2 = rng(seedOf(`seg:${s.app}:${s.period}:${s.stage}`));
      const xs = new Float64Array(2000);
      for (let i = 0; i < xs.length; i++) xs[i] = beta(Math.max(s.a, 1e-3), Math.max(s.b, 1e-3), r2);
      xs.sort();
      return {
        app: s.app,
        period: s.period,
        stage: s.stage,
        observed: s.obs.n,
        renewed: s.obs.x,
        observedRate: s.obs.n ? s.obs.x / s.obs.n : null,
        rate: s.mean,
        low: percentile(xs, 0.025),
        high: percentile(xs, 0.975),
        lowData: s.obs.n < LOW_DATA,
        source: s.source,
      };
    });

  // Upcoming long renewals (6 months and longer): next payment in the horizon's first 90 days.
  const upcoming: UpcomingOut[] = [];
  const meanRates = Float64Array.from(rates.list.map((s) => s.mean));
  for (const w of walkers) {
    if (w.periodMs < 180 * DAY || w.next - start >= 90 * DAY) continue;
    const p = firstP(w, meanRates);
    const sh = sharesOf(w.app);
    const share = w.firstPaid !== null && w.next - w.firstPaid >= TENURE_SPLIT ? sh.share2 : sh.share1;
    upcoming.push({
      app: w.app,
      product: w.product,
      period: w.period,
      date: w.next,
      price: w.price * input.rate,
      expectedProceeds: p * w.price * (1 - sh.refund) * share * input.rate,
      probability: p,
      status: w.flag,
      stage: w.stage,
    });
  }
  upcoming.sort((a, b) => a.date - b.date);

  return { days, start, expected, draws: drawsOut, apps, segments, upcoming, proceedsShare, refundShare, inputs, activeKeys };
}

/** Cumulative band of a daily series over the first `n` days (expected, and percentiles across draws). */
export function cumulativeBand(out: ModelOutput, n: number, pick: (s: SeriesOut) => Float64Array[]): Band {
  const sum = (s: SeriesOut) => {
    let v = 0;
    for (const a of pick(s)) for (let i = 0; i < Math.min(n, out.days); i++) v += a[i];
    return v;
  };
  return bandOf(sum(out.expected), out.draws.map(sum));
}

/** Actual proceeds (refunds as known now) in [from, to): all, and from subscriptions active at `from` (existing). */
export function actuals(txs: PTx[], from: number, to: number, activeKeys: Set<string>, apps: Set<string> | null, rate: number) {
  let all = 0;
  let existing = 0;
  for (const t of txs) {
    if (t.at < from || t.at >= to || t.gross <= 0 || (apps && !apps.has(t.app))) continue;
    const v = t.proceeds * (1 - (t.refundedAt !== null ? t.refunded : 0)) * rate;
    all += v;
    if (t.type === "auto_renewable" && activeKeys.has(key(t.app, t.otid))) existing += v;
  }
  return { all, existing };
}
