import { describe, expect, it } from "vitest";
import { classify, computeDays } from "../worker/lib/rollup";
import { monthly, periodFromDuration } from "../worker/lib/money";

const DAY = 86_400_000;
const T0 = Date.parse("2026-01-01T12:00:00Z");

let n = 0;
function tx(o: Partial<Parameters<typeof classify>[0][number]> & { otid: string; at: number; days?: number; usd?: number; trial?: boolean }) {
  const id = `t${++n}`;
  return {
    id,
    product_id: "monthly",
    customer_id: `c-${o.otid}`,
    original_transaction_id: o.otid,
    product_type: o.product_type ?? "auto_renewable",
    kind: o.trial ? "trial" : "new",
    offer_type: o.trial ? 1 : null,
    offer_discount_type: o.trial ? "FREE_TRIAL" : null,
    purchased_at: o.at,
    expires_at: o.expires_at !== undefined ? o.expires_at : o.at + (o.days ?? 30) * DAY,
    period: o.period ?? (o.trial ? "P1W" : "P1M"),
    gross_usd: o.trial ? 0 : (o.usd ?? 10),
    proceeds_usd: o.trial ? 0 : (o.usd ?? 10) * 0.85,
    refunded_at: o.refunded_at ?? null,
    revoked_at: null,
  };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe("periods", () => {
  it("maps billing intervals to standard periods", () => {
    expect(periodFromDuration(7 * DAY)).toBe("P1W");
    expect(periodFromDuration(31 * DAY)).toBe("P1M");
    expect(periodFromDuration(28 * DAY)).toBe("P1M");
    expect(periodFromDuration(365 * DAY)).toBe("P1Y");
    expect(periodFromDuration(5 * 60_000, "Sandbox")).toBe("P1M");
    expect(periodFromDuration(60 * 60_000, "Sandbox")).toBe("P1Y");
    expect(monthly(120, "P1Y")).toBe(10);
    expect(monthly(10, "P1W")).toBeCloseTo((10 * 365.25) / 7 / 12);
  });
});

describe("rollup", () => {
  it("classifies trial, conversion, renewals and one-time purchases", () => {
    const a = [tx({ otid: "a", at: T0, trial: true, days: 7 }), tx({ otid: "a", at: T0 + 7 * DAY }), tx({ otid: "a", at: T0 + 37 * DAY })];
    const b = [tx({ otid: "b", at: T0 })];
    const life = tx({ otid: "l", at: T0, product_type: "non_consumable", expires_at: null });
    const kinds = classify([...a, ...b, life]);
    expect(a.map((t) => kinds.get(t.id))).toEqual(["trial", "conversion", "renewal"]);
    expect(kinds.get(b[0].id)).toBe("new");
    expect(kinds.get(life.id)).toBe("one_time");
  });

  it("computes MRR, actives and MRR movement day by day", () => {
    // a: trial 7 days then monthly for two periods, then churns.
    // b: monthly from day 0, upgrades to $20 at day 30 (expansion), stays.
    // c: monthly at day 0, lapses at day 30, comes back at day 45 (reactivation).
    // d: monthly at day 3, refunded on day 10 (the period ends at the refund).
    const txs = [
      tx({ otid: "a", at: T0, trial: true, days: 7 }),
      tx({ otid: "a", at: T0 + 7 * DAY }),
      tx({ otid: "a", at: T0 + 37 * DAY }),
      tx({ otid: "b", at: T0 }),
      tx({ otid: "b", at: T0 + 30 * DAY, usd: 20 }),
      tx({ otid: "c", at: T0 }),
      tx({ otid: "c", at: T0 + 45 * DAY }),
      tx({ otid: "d", at: T0 + 3 * DAY, refunded_at: T0 + 10 * DAY }),
    ];
    const kinds = classify(txs);
    const days = computeDays(txs, kinds, day(T0), day(T0 + 80 * DAY));
    const at = (d: number) => days.find((r) => r.day === day(T0 + d * DAY))!;

    expect(at(0)).toMatchObject({ active_trials: 1, active_subscriptions: 2, mrr_usd: 20, mrr_new: 20, trials_started: 1, new_subscriptions: 2, gross_usd: 20 });
    expect(at(3)).toMatchObject({ active_subscriptions: 3, mrr_usd: 30 });
    // Refund on day 10: d leaves (churn), its revenue is gone from day 3 and counted as a refund on day 10.
    expect(at(3).gross_usd).toBe(0);
    expect(at(10)).toMatchObject({ active_subscriptions: 3, mrr_usd: 30, refunds: 1, refunds_usd: 10, churned_subscriptions: 1, mrr_churn: 10 });
    // Day 7: the trial converts.
    expect(at(7)).toMatchObject({ active_trials: 0, active_subscriptions: 4, trial_conversions: 1, mrr_new: 10 });
    // Day 30: b expands to 20, c lapses.
    expect(at(30)).toMatchObject({ mrr_expansion: 10, mrr_churn: 10, churned_subscriptions: 1, active_subscriptions: 2, mrr_usd: 30 });
    // Day 45: c is back.
    expect(at(45)).toMatchObject({ mrr_reactivation: 10, active_subscriptions: 3, mrr_usd: 40 });
    // Day 60: b's $20 period ends without renewal; day 67: a's second paid period ends.
    expect(at(60)).toMatchObject({ mrr_churn: 20, active_subscriptions: 2 });
    expect(at(67)).toMatchObject({ mrr_churn: 10, active_subscriptions: 1, mrr_usd: 10 });
    // Movement adds up to the MRR change over the whole range.
    const net = days.reduce((s, r) => s + r.mrr_new + r.mrr_expansion + r.mrr_reactivation - r.mrr_contraction - r.mrr_churn, 0);
    expect(net).toBeCloseTo(days[days.length - 1].mrr_usd);
  });

  it("treats a renewal starting exactly at the previous expiry as seamless", () => {
    const txs = [tx({ otid: "x", at: T0, days: 30 }), tx({ otid: "x", at: T0 + 30 * DAY, days: 30 })];
    const days = computeDays(txs, classify(txs), day(T0), day(T0 + 40 * DAY));
    expect(days.reduce((s, r) => s + r.mrr_churn + r.mrr_reactivation, 0)).toBe(0);
    expect(days[35].active_subscriptions).toBe(1);
  });

  it("measures the running day now: periods ending later today stay until Apple renews them", () => {
    // Two weekly subscriptions expire at 18:00 of the running day; one renewal is already announced (starts at expiry).
    const dayStartMs = Date.parse("2026-11-08T00:00:00Z");
    const expiry = dayStartMs + 18 * 3_600_000;
    const txs = [
      tx({ otid: "w1", at: expiry - 7 * DAY, expires_at: expiry, period: "P1W" }),
      tx({ otid: "w2", at: expiry - 7 * DAY, expires_at: expiry, period: "P1W" }),
      tx({ otid: "w1", at: expiry, expires_at: expiry + 7 * DAY, period: "P1W" }),
    ];
    const kinds = classify(txs);
    const full = monthly(10, "P1W") * 2;
    // 06:00: both still covered, whatever happens at 18:00.
    const morning = computeDays(txs, kinds, "2026-11-07", "2026-11-08", undefined, undefined, dayStartMs + 6 * 3_600_000);
    expect(morning[1]).toMatchObject({ active_subscriptions: 2, mrr_churn: 0 });
    expect(morning[1].mrr_usd).toBeCloseTo(full);
    // 20:00: w2 was not renewed and is gone; w1 renewed seamlessly.
    const evening = computeDays(txs, kinds, "2026-11-07", "2026-11-08", undefined, undefined, dayStartMs + 20 * 3_600_000);
    expect(evening[1]).toMatchObject({ active_subscriptions: 1, churned_subscriptions: 1 });
    expect(evening[1].mrr_usd).toBeCloseTo(full / 2);
    // Closed days (nowMs after them) are measured at their end, as before.
    const closed = computeDays(txs, kinds, "2026-11-07", "2026-11-08", undefined, undefined, dayStartMs + 2 * DAY);
    expect(closed[1].active_subscriptions).toBe(1);
  });
});
