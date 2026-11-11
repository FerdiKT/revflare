import { describe, expect, it } from "vitest";
import { prorationOf, txFromApple } from "../worker/lib/ledger";
import { refundedShare } from "../worker/lib/money";
import { parseRefundUpdate, planConsumption, type RefundConfig } from "../worker/lib/refunds";
import { computeDays } from "../worker/lib/rollup";
import type { TransactionInfo } from "../worker/apple/types";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-15T12:00:00Z");
const on: RefundConfig = { enabled: true, consentAttested: true, policy: "none", declineAfterDays: null, sampleContentProvided: false, consumptionPercent: null };
type PlanInput = Parameters<typeof planConsumption>[0];
const plan = (o: Partial<Omit<PlanInput, "config">> & { config?: Partial<RefundConfig> }) =>
  planConsumption({ productType: "auto_renewable", startedAt: NOW - 10 * DAY, environment: "Production", customerConsent: true, now: NOW, dueAt: NOW + 3_600_000, ...o, config: { ...on, ...o.config } });

describe("planConsumption", () => {
  it("skips without the switch, the attestation or the customer's consent, and expires after the window", () => {
    // Settings that leave a production request unanswered raise an alert; the customer's choice and Xcode do not.
    expect(plan({ config: { enabled: false } })).toMatchObject({ action: "skip", reason: expect.stringContaining("off"), alert: true });
    expect(plan({ config: { enabled: false }, environment: "Sandbox" })).toMatchObject({ action: "skip", alert: false });
    expect(plan({ config: { consentAttested: false } })).toMatchObject({ action: "skip", reason: expect.stringContaining("consent"), alert: true });
    expect(plan({ customerConsent: false })).toMatchObject({ action: "skip", reason: expect.stringContaining("withdrew"), alert: false });
    expect(plan({ environment: "Xcode", config: { enabled: false } })).toMatchObject({ action: "skip", alert: false });
    expect(plan({ dueAt: NOW })).toMatchObject({ action: "expire" });
  });

  it("builds the v2 body: DELIVERED, no percentage for auto-renewable subscriptions", () => {
    expect(plan({ config: { consumptionPercent: 30, sampleContentProvided: true } })).toEqual({
      action: "send",
      body: { customerConsented: true, deliveryStatus: "DELIVERED", sampleContentProvided: true },
    });
    expect(plan({ productType: "consumable", config: { consumptionPercent: 67.932 } })).toMatchObject({ body: { consumptionPercentage: 67932 } });
    expect((plan({ productType: "non_consumable" }) as any).body).not.toHaveProperty("consumptionPercentage");
  });

  it("applies the refund policy", () => {
    const decline = { policy: "decline_if_delivered_after_days" as const, declineAfterDays: 7 };
    expect(plan({ config: decline })).toMatchObject({ body: { refundPreference: "DECLINE" } });
    expect((plan({ config: decline, startedAt: NOW - 3 * DAY }) as any).body.refundPreference).toBeUndefined();
    expect(plan({ config: { policy: "decline" }, startedAt: NOW - 60_000 })).toMatchObject({ body: { refundPreference: "DECLINE" } });
    expect(plan({ productType: "non_consumable", config: { policy: "decline" } })).toMatchObject({ body: { refundPreference: "DECLINE" } });
    expect(plan({ config: { policy: "grant_full" } })).toMatchObject({ body: { refundPreference: "GRANT_FULL" } });
    expect(plan({ config: { policy: "grant_prorated" } })).toMatchObject({ body: { refundPreference: "GRANT_PRORATED" } });
    // Other products need 0 < percentage < 100 % with GRANT_PRORATED: without one, no preference is sent.
    expect((plan({ productType: "consumable", config: { policy: "grant_prorated" } }) as any).body.refundPreference).toBeUndefined();
    expect(plan({ productType: "consumable", config: { policy: "grant_prorated", consumptionPercent: 25 } })).toMatchObject({ body: { refundPreference: "GRANT_PRORATED", consumptionPercentage: 25000 } });
    expect((plan({ productType: "consumable", config: { policy: "none" } }) as any).body.refundPreference).toBeUndefined();
  });

  it("validates settings updates", () => {
    expect(parseRefundUpdate({ enabled: "yes" })).toHaveProperty("error");
    expect(parseRefundUpdate({ declineAfterDays: 0 })).toHaveProperty("error");
    expect(parseRefundUpdate({ consumptionPercent: -1 })).toHaveProperty("error");
    expect(parseRefundUpdate({ refundPolicy: "decline" })).toEqual({ refundPolicy: "decline" });
    expect(parseRefundUpdate({ refundPolicy: "grant_full", declineAfterDays: null, consumptionPercent: 12.5 })).toEqual({ refundPolicy: "grant_full", declineAfterDays: null, consumptionPercent: 12.5 });
  });
});

describe("prorated refunds", () => {
  const base: TransactionInfo = { transactionId: "1", originalTransactionId: "1", bundleId: "com.example.app", productId: "pack", purchaseDate: NOW - DAY, type: "Consumable", signedDate: NOW, environment: "Production", price: 10000, currency: "USD" };

  it("reads revocationPercentage / revocationType", () => {
    expect(prorationOf({ revocationDate: NOW, revocationPercentage: 40000, revocationType: "REFUND_PRORATED" })).toBe(40000);
    expect(prorationOf({ revocationDate: NOW, revocationPercentage: 40000 })).toBe(40000);
    expect(prorationOf({ revocationDate: NOW, revocationPercentage: 100000, revocationType: "REFUND_FULL" })).toBeNull();
    expect(prorationOf({ revocationDate: NOW, revocationPercentage: 40000, revocationType: "REFUND_FULL" })).toBeNull();
    expect(prorationOf({ revocationPercentage: 40000 })).toBeNull();
    expect(txFromApple({ ...base, revocationDate: NOW, revocationReason: 0, revocationPercentage: 25000, revocationType: "REFUND_PRORATED" })).toMatchObject({ refundedAt: NOW, refundMilli: 25000 });
    expect(txFromApple({ ...base, revocationDate: NOW, revocationType: "FAMILY_REVOKE" })).toMatchObject({ refundedAt: null, revokedAt: NOW, refundMilli: null });
    expect(refundedShare({ refunded_at: NOW, refund_milli: 25000 })).toBe(0.25);
    expect(refundedShare({ refunded_at: NOW, refund_milli: null })).toBe(1);
    expect(refundedShare({ refunded_at: null, refund_milli: 25000 })).toBe(0);
  });

  it("keeps the part that was not refunded in daily revenue", () => {
    const t = {
      id: "t1",
      product_id: "pack",
      customer_id: "c1",
      original_transaction_id: "1",
      product_type: "consumable",
      kind: "one_time",
      offer_type: null,
      offer_discount_type: null,
      purchased_at: NOW - DAY,
      expires_at: null,
      period: null,
      gross_usd: 10,
      proceeds_usd: 7,
      refunded_at: NOW,
      refund_milli: 40000,
      revoked_at: null,
    };
    const days = computeDays([t], new Map(), new Date(NOW - DAY).toISOString().slice(0, 10), new Date(NOW).toISOString().slice(0, 10));
    expect(days[0]).toMatchObject({ gross_usd: 6, one_time_purchases: 1 });
    expect(days[0].proceeds_usd).toBeCloseTo(4.2, 9);
    expect(days[1]).toMatchObject({ refunds: 1, refunds_usd: 4 });
  });
});
