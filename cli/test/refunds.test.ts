import { afterEach, describe, expect, it, vi } from "vitest";
import { refundsUpdateBody } from "../src/commands/refunds.js";
import { run } from "../src/main.js";
import type { RefundRequestSettings } from "../src/types.js";
import { app, capture, loggedInEnv, mockFetch } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const APPS = { items: [app("app_1", "Photo Lab", "com.example.refunds")], currency: "USD" };
const SETTINGS: RefundRequestSettings = {
  enabled: true,
  consentAttested: true,
  consentAttestedAt: Date.UTC(2026, 9, 1),
  consentAttestedBy: "Owner <owner@example.com>",
  refundPolicy: "decline_if_delivered_after_days",
  declineAfterDays: 30,
  sampleContentProvided: false,
  consumptionPercent: null,
  deliveryStatus: "DELIVERED",
  notifications: { status: "revflare", forwarded: false, lastNotificationAt: null },
  stats: { pending: 0, sent: 4, skipped: 1, failed: 0, expired: 1 },
  lastSentAt: Date.UTC(2026, 9, 20, 12),
  lastError: null,
};

describe("refundsUpdateBody", () => {
  it("maps set flags to the PUT body", () => {
    expect(refundsUpdateBody({ "attest-consent": true, enable: true, policy: "decline-after", days: "30", sample: "on", consumed: "50%" })).toEqual({
      consentAttested: true,
      enabled: true,
      refundPolicy: "decline_if_delivered_after_days",
      declineAfterDays: 30,
      sampleContentProvided: true,
      consumptionPercent: 50,
    });
    expect(refundsUpdateBody({ policy: "grant_full", consumed: "none" })).toEqual({ refundPolicy: "grant_full", consumptionPercent: null });
    expect(() => refundsUpdateBody({ policy: "maybe" })).toThrow(/Unknown policy/);
    expect(() => refundsUpdateBody({ days: "0" })).toThrow(/--days/);
    expect(() => refundsUpdateBody({ consumed: "120" })).toThrow(/--consumed/);
    expect(() => refundsUpdateBody({ enable: true, disable: true })).toThrow(/either/);
  });
});

describe("refunds", () => {
  it("prints the status, sets, logs and changes a customer's consent", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({
      "GET /apps": APPS,
      "GET /apps/app_1/integrations/refunds": SETTINGS,
      "PUT /apps/app_1/integrations/refunds": SETTINGS,
      "GET /apps/app_1/integrations/refunds/log": {
        items: [
          { id: 1, receivedAt: Date.UTC(2026, 9, 20), dueAt: Date.UTC(2026, 9, 20, 12), transactionId: "2000001", originalTransactionId: "2000000", productId: "monthly", productName: "Monthly", environment: "Production", requestReason: "UNINTENDED_PURCHASE", status: "sent", attempts: 1, request: { customerConsented: true, deliveryStatus: "DELIVERED", sampleContentProvided: false, refundPreference: "DECLINE" }, httpStatus: 202, response: null, reason: null, updatedAt: Date.UTC(2026, 9, 20) },
        ],
      },
      "PUT /customers/cus_1/refund-consent": { id: "cus_1", refundDataConsent: false },
    });
    const env = loggedInEnv();
    expect(await run(["refunds", "com.example.refunds", "--no-color"], { env, fetch })).toBe(0);
    expect(out.stdout).toMatch(/Preference\s+DECLINE when older than 30 days/);
    expect(out.stdout).toContain("4 answered · 0 pending · 1 skipped · 0 failed · 1 expired");
    expect(await run(["refunds", "app_1", "set", "--attest-consent", "--enable", "--policy", "full", "--json"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ consentAttested: true, enabled: true, refundPolicy: "grant_full" });
    expect(await run(["refunds", "app_1", "log", "--limit", "5", "--no-color"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.url.searchParams.get("limit")).toBe("5");
    expect(out.stdout).toMatch(/2000001\s+Monthly\s+sent\s+202\s+refundPreference DECLINE/);
    expect(await run(["refunds", "app_1", "consent", "cus_1", "off"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ consent: false });
    expect(out.stdout).toContain("Consent withdrawn for cus_1");
    expect(await run(["refunds", "app_1", "--enable"], { env, fetch })).toBe(2);
  });
});
