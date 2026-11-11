import { afterEach, describe, expect, it, vi } from "vitest";
import { addOffer } from "../src/commands/offers.js";
import { run } from "../src/main.js";
import type { OfferSettings } from "../src/types.js";
import { app, capture, loggedInEnv, mockFetch } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const APPS = { items: [app("app_1", "Photo Lab", "com.example.offers")], currency: "USD" };
const SETTINGS: OfferSettings = {
  appId: "app_1",
  offers: [{ productId: "com.example.offers.annual", offerId: "save50", label: "Half price", kind: "promotional" }],
  strict: false,
  keyConfigured: true,
  bundleId: "com.example.offers",
  sdkKey: "rfp_test",
  updatedAt: Date.UTC(2026, 9, 1),
};

describe("addOffer", () => {
  it("adds or replaces an entry", () => {
    expect(addOffer(SETTINGS.offers, "com.example.offers.annual", "comeback", { "win-back": true })).toEqual({
      offers: [
        { productId: "com.example.offers.annual", offerId: "save50", label: "Half price", kind: "promotional" },
        { productId: "com.example.offers.annual", offerId: "comeback", label: null, kind: "win_back" },
      ],
    });
    expect(addOffer(SETTINGS.offers, "com.example.offers.annual", "save50", { label: "60 % off" })).toEqual({
      offers: [{ productId: "com.example.offers.annual", offerId: "save50", label: "60 % off", kind: "promotional" }],
    });
  });
});

describe("offers", () => {
  it("lists, edits, imports, shows lapsed subscribers, stats and the log", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({
      "GET /apps": APPS,
      "GET /apps/app_1/offers": SETTINGS,
      "PUT /apps/app_1/offers": (call: { body: Record<string, unknown> }) => ({ ...SETTINGS, ...call.body }),
      "POST /apps/app_1/offers/import": { added: 1, found: 2, errors: [], settings: SETTINGS },
      "GET /apps/app_1/lapsed": {
        appId: "app_1",
        days: 30,
        from: 0,
        to: 0,
        currency: "USD",
        total: 1,
        byProduct: [{ productId: "com.example.offers.monthly", productName: "Monthly", count: 1 }],
        items: [{ customerId: "cus_1", originalTransactionId: "2000000", productId: "com.example.offers.monthly", productName: "Monthly", expiredAt: Date.UTC(2026, 9, 10, 12), country: "US", totalPaid: 59.9 }],
      },
      "GET /apps/app_1/offers/stats": {
        appId: "app_1",
        from: "2026-07-25",
        to: "2026-10-22",
        currency: "USD",
        totals: { redemptions: 3, revenue: 79.97, proceeds: 67.97 },
        items: [
          { offerType: 2, offerTypeLabel: "Promotional", offerId: "save50", productId: "com.example.offers.annual", label: "Half price", redemptions: 2, customers: 2, revenue: 59.98, proceeds: 50.98 },
          { offerType: 4, offerTypeLabel: "Win-back", offerId: "comeback", productId: "com.example.offers.annual", label: null, redemptions: 1, customers: 1, revenue: 19.99, proceeds: 16.99 },
        ],
      },
      "GET /apps/app_1/offers/log": { items: [{ at: Date.UTC(2026, 9, 20), installId: "inst-1", productId: "com.example.offers.annual", offerId: "save50", status: "signed" }] },
    });
    const env = loggedInEnv();
    expect(await run(["offers", "com.example.offers", "--no-color"], { env, fetch })).toBe(0);
    expect(out.stdout).toMatch(/com\.example\.offers\.annual\s+save50\s+promotional\s+Half price/);

    expect(await run(["offers", "app_1", "add", "com.example.offers.annual", "comeback", "--win-back", "--json"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.method).toBe("PUT");
    expect(calls.at(-1)!.body.offers).toHaveLength(2);
    expect(calls.at(-1)!.body.offers[1]).toEqual({ productId: "com.example.offers.annual", offerId: "comeback", label: null, kind: "win_back" });

    expect(await run(["offers", "app_1", "remove", "com.example.offers.annual", "save50", "--json"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ offers: [] });
    expect(await run(["offers", "app_1", "remove", "com.example.offers.annual", "nope"], { env, fetch })).toBe(2);

    expect(await run(["offers", "app_1", "set", "--strict", "on", "--json"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ strict: true });

    expect(await run(["offers", "app_1", "import", "--no-color"], { env, fetch })).toBe(0);
    expect(out.stdout).toContain("Found 2 offers in App Store Connect, added 1.");

    expect(await run(["offers", "app_1", "lapsed", "--days", "30", "--no-color"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.url.searchParams.get("days")).toBe("30");
    expect(out.stdout).toMatch(/cus_1\s+Monthly\s+US\s+\$59\.90/);

    expect(await run(["offers", "app_1", "stats", "--range", "90d", "--no-color"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.url.searchParams.get("range")).toBe("90d");
    expect(out.stdout).toMatch(/Win-back\s+comeback/);
    expect(out.stdout).toContain("Total: 3 redemptions");

    expect(await run(["offers", "app_1", "log", "--limit", "5", "--no-color"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.url.searchParams.get("limit")).toBe("5");
    expect(out.stdout).toMatch(/inst-1\s+com\.example\.offers\.annual\s+save50\s+signed/);

    expect(await run(["offers", "app_1", "--strict", "on"], { env, fetch })).toBe(2);
    expect(await run(["offers", "app_1", "lapsed", "--days", "0"], { env, fetch })).toBe(2);
    expect(await run(["offers", "app_1", "explode"], { env, fetch })).toBe(2);
  });
});
