import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fmtChange, fmtMoney, fmtPct, fmtValue, setColor, sparkline, table } from "../src/format.js";
import { run } from "../src/main.js";
import type { Chart, Overview } from "../src/types.js";
import { app, capture, loggedInEnv, mockFetch } from "./helpers.js";

beforeEach(() => setColor(false));
afterEach(() => vi.restoreAllMocks());

describe("money and values", () => {
  it("formats money in the response currency", () => {
    expect(fmtMoney(1234.5, "USD")).toBe("$1,234.50");
    expect(fmtMoney(1234.5, "EUR")).toBe("€1,234.50");
    expect(fmtMoney(-12, "TRY").replace(/\s/g, " ")).toBe("-TRY 12.00");
    expect(fmtMoney(1234.5, "USD", { compact: true })).toBe("$1,235");
    expect(fmtMoney(12.345, "USD", { compact: true })).toBe("$12.35");
    expect(fmtMoney(null, "USD")).toBe("-");
    expect(fmtMoney(5, "XXQ")).toMatch(/5\.00/);
  });

  it("formats counts, rates and changes", () => {
    expect(fmtValue(0.0345, "percent", "USD")).toBe("3.45%");
    expect(fmtValue(1871, "count", "USD")).toBe("1,871");
    expect(fmtValue(2.333, "count", "USD")).toBe("2.33");
    expect(fmtValue(10, "money", "GBP")).toBe("£10.00");
    expect(fmtPct(0.5, 0)).toBe("50%");
    expect(fmtChange(0.123)).toBe("+12.3%");
    expect(fmtChange(-0.05)).toBe("-5%");
    expect(fmtChange(null)).toBe("");
  });

  it("sparklines and tables", () => {
    expect(sparkline([0, 5, 10])).toBe("▁▅█");
    expect(sparkline([3, 3])).toBe("▁▁");
    expect(table([{ header: "A" }, { header: "B", align: "right" }], [["x", "1"], ["yy", null]])).toBe("A   B\nx   1\nyy  -");
  });
});

describe("command output", () => {
  const chartData: Chart = {
    metric: "revenue",
    format: "money",
    currency: "EUR",
    interval: "month",
    from: "2026-08-01",
    to: "2026-10-16",
    points: [
      { date: "2026-08-01", value: 1000 },
      { date: "2026-09-01", value: 1500.5 },
      { date: "2026-10-01", value: 700 },
    ],
    total: 3200.5,
    previousTotal: 3000,
    importedUntil: "2026-08-31",
  };

  it("chart prints money in the chart currency, imported days and the change", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "GET /charts/revenue": chartData });
    expect(await run(["chart", "revenue", "--range", "90d", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(out.stdout).toContain("2026-08-01*");
    expect(out.stdout).toContain("€1,501");
    expect(out.stdout).toContain("Total €3,200.50");
    expect(out.stdout).toContain("+6.7%");
    expect(out.stdout).toContain("imported history (RevenueCat) up to 2026-08-31");
  });

  it("--json prints the raw response", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "GET /charts/revenue": chartData });
    expect(await run(["chart", "revenue", "--json"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(chartData);
  });

  it("overview prints today, KPIs and top apps", async () => {
    const out = capture();
    const o: Overview = {
      currency: "USD",
      asOf: Date.UTC(2026, 9, 16),
      today: { revenue: 255.38, proceeds: 197.31, sales: 33, newSubscriptions: 5, trialsStarted: 27, refunds: 1, date: "2026-10-16" },
      yesterday: { revenue: 300, proceeds: 230, sales: 40 },
      kpis: [
        { id: "mrr", metric: "mrr", label: "MRR", format: "money", value: 7247, previous: 7000, change: 0.0353, spark: [1, 2, 3] },
        { id: "churn", metric: "churn_rate", label: "Churn rate", format: "percent", value: 0.05, previous: 0.04, change: 0.25, spark: [] },
      ],
      mrrMovement: { new: 900, expansion: 10, contraction: 5, churn: 600, reactivation: 20, net: 325 },
      atRisk: { mrr: 120, subscriptions: 9 },
      forecast30: 6000,
      goals: [],
      records: { bestDay: { date: "2026-03-01", revenue: 999 }, todayIsRecord: false, bestMonth: null },
      topApps: [{ appId: "app_1", name: "Photo Lab", iconUrl: null, revenue28d: 7049, mrr: 7247, change: 0.1 }],
      alerts: [],
    };
    const { fetch } = mockFetch({ "GET /overview": o });
    expect(await run(["overview", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(out.stdout).toContain("$255.38 revenue");
    expect(out.stdout).toContain("$7,247.00");
    expect(out.stdout).toContain("5%");
    expect(out.stdout).toContain("Photo Lab");
    expect(out.stdout).toContain("$6,000.00");
  });

  it("apps hides archived apps unless --all", async () => {
    const out = capture();
    const items = [app("app_1", "Live", "a.b", { mrr: 10 }), app("app_2", "Gone", "c.d", { archived: true })];
    const { fetch } = mockFetch({ "GET /apps": { items, currency: "EUR" } });
    expect(await run(["apps", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(out.stdout).toContain("Live");
    expect(out.stdout).not.toContain("Gone");
    expect(await run(["apps", "--all", "--json"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(out.stdout).toContain("Gone");
  });

  it("transactions passes filters and --follow prints only new sales", async () => {
    const out = capture();
    const tx = (id: string, at: number) => ({ id, appId: "app_1", appName: "Photo Lab", appIconUrl: null, customerId: "cus_1", transactionId: id, originalTransactionId: id, productId: "weekly", productName: "Weekly", kind: "new", purchasedAt: at, expiresAt: null, price: 4.99, storeCurrency: "USD", storePrice: 4.99, proceeds: 4.24, country: "US", environment: "Production", refundedAt: null, offer: null, source: "notification" });
    let page = 0;
    const { fetch, calls } = mockFetch({
      "GET /me": { workspace: { currency: "USD" } },
      "GET /transactions": () => (page++ === 0 ? { items: [tx("t1", 1000)], nextCursor: null } : { items: [tx("t2", 2000), tx("t1", 1000)], nextCursor: null }),
    });
    const code = await run(["transactions", "--follow", "--polls", "2", "--every", "1", "--kind", "new,renewal", "--country", "us", "--json"], { env: loggedInEnv(), fetch, sleep: async () => {} });
    expect(code).toBe(0);
    const lines = out.stdout.trim().split("\n").map((l) => JSON.parse(l).id);
    expect(lines).toEqual(["t1", "t2"]);
    const q = Object.fromEntries(calls.find((c) => c.url.pathname.endsWith("/transactions"))!.url.searchParams);
    expect(q).toMatchObject({ kinds: "new,renewal", country: "US", limit: "20" });
    expect(await run(["transactions", "--kind", "gift"], { env: loggedInEnv(), fetch })).toBe(2);
  });

  it("transactions --source filters by acquisition and shows the Apple Ads source", async () => {
    const out = capture();
    const ads = { source: "apple_ads", test: false, campaignId: "10", campaignName: "Brand", adGroupId: "20", adGroupName: null, keywordId: null, keywordName: null };
    const tx = { id: "t1", appId: "app_1", appName: "Photo Lab", appIconUrl: null, customerId: "cus_1", transactionId: "t1", originalTransactionId: "t1", productId: "weekly", productName: "Weekly", kind: "trial", purchasedAt: 1000, expiresAt: null, price: 0, storeCurrency: "USD", storePrice: 0, proceeds: 0, country: "US", environment: "Production", refundedAt: null, offer: null, source: "notification", attribution: ads };
    const { fetch, calls } = mockFetch({ "GET /transactions": { items: [tx], nextCursor: "abc", currency: "USD" } });
    expect(await run(["transactions", "--source", "apple-ads", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(calls[0].url.searchParams.get("source")).toBe("apple_ads");
    expect(out.stdout).toMatch(/SOURCE/);
    expect(out.stdout).toContain("Apple Ads · #20");
    expect(out.stdout).toContain("--cursor abc --source apple_ads");
    expect(await run(["transactions", "--source", "facebook"], { env: loggedInEnv(), fetch })).toBe(2);
  });
});
