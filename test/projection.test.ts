import { describe, expect, it } from "vitest";
import { actuals, cumulativeBand, DAY, runModel, STATE_WEIGHTS, type LiveSub, type PTx } from "../worker/lib/projection-model";

// A day at noon UTC: the projection's day 0 is this UTC day.
const T = Date.UTC(2026, 10, 22, 12);
const WEEK = 7 * DAY;

const tx = (app: string, otid: string, at: number, extra: Partial<PTx> = {}): PTx => ({
  app,
  otid,
  product: "com.example.weekly",
  type: "auto_renewable",
  kind: "renewal",
  offerType: null,
  offerDiscount: null,
  period: "P1W",
  at,
  expires: at + WEEK,
  gross: 10,
  proceeds: 7,
  priceMilli: 10_000,
  currency: "USD",
  refunded: 0,
  refundedAt: null,
  revokedAt: null,
  upgraded: false,
  ...extra,
  ...(extra.expires === undefined && extra.period === "P1Y" ? { expires: at + 365 * DAY } : {}),
});

/**
 * Weekly app: 1,000 past subscriptions paid three weeks, 800 of them a fourth time (its period ends inside the settle
 * margin, so it is neither measured nor active); 100 current subscriptions on their third paid week, renewing tomorrow.
 */
function weeklyApp(app = "app_w") {
  const txs: PTx[] = [];
  for (let i = 0; i < 1000; i++) {
    const t4 = T - DAY - WEEK; // the 4th period ends a day before T
    const t3 = t4 - WEEK;
    const at = (k: number) => t3 - (2 - k) * WEEK;
    for (let k = 0; k < 3; k++) txs.push(tx(app, `p${i}`, at(k) - (i % 20) * DAY, { kind: k ? "renewal" : "new" }));
    if (i < 800) txs.push(tx(app, `p${i}`, t4));
  }
  for (let i = 0; i < 100; i++) {
    const last = T + DAY - WEEK;
    for (let k = 0; k < 3; k++) txs.push(tx(app, `c${i}`, last - (2 - k) * WEEK, { kind: k ? "renewal" : "new" }));
  }
  return txs;
}

const base = { perUsd: () => 1, rate: 1, at: T, days: 30, draws: 200, seed: 1 };

describe("projection model", () => {
  it("chains the measured renewal rate over each subscription's renewals", () => {
    const out = runModel({ ...base, txs: weeklyApp() });
    const r3 = out.segments.find((s) => s.app === "app_w" && s.stage === "r3")!;
    expect(r3.observed).toBe(1000);
    expect(r3.renewed).toBe(800);
    expect(r3.lowData).toBe(false);
    expect(r3.source).toBe("app");
    expect(r3.rate).toBeGreaterThan(0.78);
    expect(r3.rate).toBeLessThan(0.81);
    expect(out.inputs.active).toBe(100);
    // Renewals on days 1, 8, 15, 22, 29: 100 × $10 × 70 % proceeds × (r + r² + ... + r⁵).
    const r = r3.rate;
    const want = 700 * (r + r ** 2 + r ** 3 + r ** 4 + r ** 5);
    const got = cumulativeBand(out, 30, (s) => [s.renewals]);
    expect(got.expected).toBeCloseTo(want, 6);
    expect(out.expected.renewals[1]).toBeCloseTo(700 * r, 6);
    expect(out.expected.renewalsGross[1]).toBeCloseTo(1000 * r, 6);
    // The band comes from the rate's posterior: around the expected value, narrow with 1,000 observations.
    expect(got.low).toBeLessThan(got.expected);
    expect(got.high).toBeGreaterThan(got.expected);
    expect((got.high - got.low) / got.expected).toBeLessThan(0.25);
    // MRR: $10 a week ≈ $43.48 a month per subscription, today all 100, then decaying with the renewals.
    expect(out.expected.mrr[0]).toBeCloseTo(100 * ((10 * 30.436875) / 7), 6);
    expect(out.expected.mrr[2]).toBeCloseTo(100 * r * ((10 * 30.436875) / 7), 6);
    // Same data, same seed: same answer.
    expect(cumulativeBand(runModel({ ...base, txs: weeklyApp() }), 30, (s) => [s.renewals])).toEqual(got);
  });

  it("leans on the portfolio and the defaults when a segment has little history, with a wide interval", () => {
    // A second app with one annual subscriber and no annual renewal history anywhere.
    const txs = [...weeklyApp(), tx("app_y", "y1", T - 100 * DAY, { product: "com.example.annual", period: "P1Y", kind: "new", gross: 50, proceeds: 35, priceMilli: 50_000 })];
    const out = runModel({ ...base, txs, days: 365 });
    const annual = out.segments.find((s) => s.app === "app_y" && s.period === "P1Y" && s.stage === "r1")!;
    expect(annual).toMatchObject({ observed: 0, lowData: true, source: "default", observedRate: null });
    // With no history at all, the default rate comes with a wide interval (4 pseudo-observations), not a precise one.
    const alone = runModel({ ...base, txs: [txs.at(-1)!], days: 365 }).segments.find((s) => s.stage === "r1")!;
    expect(alone.rate).toBeCloseTo(0.55, 6);
    expect(alone.high - alone.low).toBeGreaterThan(0.6);
    // The annual renewal is listed in the upcoming long renewals only within 90 days: not this one (265 days away).
    expect(out.upcoming).toHaveLength(0);
    const soon = runModel({ ...base, txs: [...txs.slice(0, -1), tx("app_y", "y1", T - 300 * DAY, { product: "com.example.annual", period: "P1Y", kind: "new", gross: 50, proceeds: 35, priceMilli: 50_000 })], days: 365 });
    expect(soon.upcoming).toHaveLength(1);
    expect(soon.upcoming[0]).toMatchObject({ app: "app_y", product: "com.example.annual", price: 50, status: "on", stage: "r1" });
    // Its year-two payment after the renewal uses the after-a-year proceeds share (Apple 30 % → 15 %).
    expect(soon.proceedsShare.get("app_y")!.afterYearAssumed).toBe(true);
  });

  it("weights subscriptions with auto-renew off and keeps the segment's total at the measured rate", () => {
    const txs = weeklyApp();
    const live = new Map<string, LiveSub>();
    for (let i = 0; i < 100; i++) live.set(`app_w\u0000c${i}`, { status: "active", autoRenew: i >= 10, expires: T + DAY, renewalPriceUsd: 10 });
    const out = runModel({ ...base, txs, live, days: 2 });
    const r = out.segments.find((s) => s.stage === "r3")!.rate;
    expect(out.inputs.off).toBe(10);
    // Day 1: 10 × off weight + 90 × raised rate = 100 × r (calibrated), in proceeds.
    expect(out.expected.renewals[1]).toBeCloseTo(700 * r, 6);
    const raised = (100 * r - 10 * STATE_WEIGHTS.off) / 90;
    expect(raised).toBeGreaterThan(r);
    // Expired / revoked subscriptions are left out.
    live.set("app_w\u0000c0", { status: "expired", autoRenew: false, expires: T + DAY, renewalPriceUsd: 10 });
    expect(runModel({ ...base, txs, live, days: 2 }).inputs.active).toBe(99);
  });

  it("applies refunds, new subscribers, one-time purchases and today's exchange rate", () => {
    const txs: PTx[] = weeklyApp().map((t) => ({ ...t, currency: "EUR", priceMilli: 10_000 }));
    // 10 % of the last 180 days' gross refunded.
    let refunded = 0;
    for (const t of txs) if (t.at > T - 170 * DAY && refunded < 0.1 * txs.filter((x) => x.at > T - 170 * DAY).length) {
      t.refunded = 1;
      t.refundedAt = t.at + DAY;
      refunded++;
    }
    // 24 new subscribers paid at once in the last 28 days (none renewing on day 1 or 8: they are existing subscribers
    // too), and 56 one-time purchases of $5.
    for (let i = 0; i < 28; i++) if (i % 7 !== 6) txs.push(tx("app_w", `n${i}`, T - (i + 0.5) * DAY, { kind: "new", currency: "EUR" }));
    for (let i = 0; i < 56; i++) txs.push(tx("app_w", `o${i}`, T - (i / 2 + 0.25) * DAY, { type: "non_consumable", product: "com.example.lifetime", period: null, expires: null, gross: 5, proceeds: 3.5 }));
    // A euro is worth 1.25 USD today (0.8 EUR per USD): €10 = $12.50.
    const out = runModel({ ...base, txs, perUsd: (c) => (c === "EUR" ? 0.8 : 1), days: 30 });
    const share = out.refundShare.get("app_w")!.share;
    expect(share).toBeGreaterThan(0.05);
    const r = out.segments.find((s) => s.stage === "r3")!.rate;
    expect(out.expected.renewals[1]).toBeCloseTo(100 * 12.5 * (1 - share) * out.proceedsShare.get("app_w")!.firstYear * r, 6);
    // One-time: 56 × $3.50 / 28 days = $7 a day (less refunds: none).
    expect(out.expected.oneTime[3]).toBeCloseTo(7, 6);
    // The 100 current subscribers started 20 days ago: new starts of the window too.
    expect(out.inputs.newStartsPerDay).toBeCloseTo(124 / 28, 6);
    // New subscribers: 124/28 starts a day, each paying at once (day 0 of its life), then renewing.
    expect(out.expected.newSubs[0]).toBeCloseTo((124 / 28) * 12.5 * (1 - share) * out.proceedsShare.get("app_w")!.firstYear, 6);
    expect(out.expected.newSubs[10]).toBeGreaterThan(out.expected.newSubs[0]);
    expect(out.expected.mrrWithNew[20]).toBeGreaterThan(out.expected.mrr[20]);
  });

  it("measures actuals for the backtest: all proceeds, and those of subscriptions active at the start", () => {
    const txs = weeklyApp();
    const out = runModel({ ...base, txs, days: 30 });
    const later = [...txs, tx("app_w", "c1", T + DAY), tx("app_w", "new1", T + 2 * DAY, { kind: "new" }), tx("app_w", "c2", T + 3 * DAY, { refunded: 1, refundedAt: T + 4 * DAY })];
    expect(actuals(later, T, T + 10 * DAY, out.activeKeys, null, 1)).toEqual({ all: 14, existing: 7 });
  });
});
