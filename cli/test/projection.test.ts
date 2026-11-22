import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/main.js";
import type { Projection, ProjectionBand } from "../src/types.js";
import { app, capture, loggedInEnv, mockFetch } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const APPS = { items: [app("app_1", "Photo Lab", "com.example.lab")], currency: "USD" };
const band = (expected: number, spread = 0.1): ProjectionBand => ({ expected, low: expected * (1 - spread), high: expected * (1 + spread) });
const totals = (k: number) => ({
  existing: band(1000 * k),
  withNew: band(2000 * k),
  existingGross: 1300 * k,
  withNewGross: 2600 * k,
  components: { renewals: 1000 * k, newSubscribers: 800 * k, oneTime: 200 * k },
  mrr: band(900),
  mrrWithNew: band(1100 + k),
});
const P: Projection = {
  currency: "USD",
  from: "2026-11-22",
  days: 365,
  generatedAt: Date.UTC(2026, 10, 22),
  summary: { next30: 2000, next30Previous: 1900, next30Change: 100, mrrNow: 950 },
  totals: { d30: totals(1), d90: totals(3), d365: totals(12) },
  daily: [],
  weekly: [],
  apps: [],
  segments: [
    { appId: "app_1", appName: "Photo Lab", period: "P1Y", stage: "r1", observed: 6, renewed: 2, observedRate: 2 / 6, rate: 0.45, low: 0.22, high: 0.69, lowData: true, source: "default" },
    { appId: "app_1", appName: "Photo Lab", period: "P1W", stage: "r3", observed: 1900, renewed: 1800, observedRate: 0.947, rate: 0.947, low: 0.94, high: 0.96, lowData: false, source: "app" },
  ],
  upcoming: { count: 1, price: 49.99, expectedProceeds: 20, items: [{ appId: "app_1", appName: "Photo Lab", productId: "com.example.annual", period: "P1Y", date: Date.UTC(2026, 11, 1), price: 49.99, expectedProceeds: 20, probability: 0.45, status: "on", stage: "r1" }] },
  backtest: [{ asOf: "2026-10-23", days: 30, existing: { predicted: band(1000), actual: 1040, error: -0.0385, inBand: true }, withNew: { predicted: band(2000), actual: 2100, error: -0.0476, inBand: true } }],
  backtestError: { withNew: 0.0476, existing: 0.0385 },
  inputs: { activeSubscriptions: 120, trials: 5, autoRenewOff: 40, billingRetry: 3, grace: 0, skipped: 0, newStartsPerDay: 2.5, oneTimePerDay: 6.67 },
  assumptions: { proceedsShare: [], refundShare: [], weights: { autoRenewOff: 0.05, billingRetry: 0.25, grace: 0.6 } },
  notes: ["Bands cover the uncertainty of the measured rates and volumes only."],
};

describe("projection", () => {
  it("prints horizons with bands, backtest, upcoming renewals and low-data segments", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({ "GET /apps": APPS, "GET /projection": P });
    expect(await run(["projection", "--app", "com.example.lab", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(calls.at(-1)!.url.searchParams.get("apps")).toBe("app_1");
    expect(out.stdout).toMatch(/30 days\s+\$1,000\.00 \(\$900\.00 – \$1,100\.00\)\s+\$2,000\.00 \(\$1,800\.00 – \$2,200\.00\)\s+\$1,000\.00\s+\$800\.00\s+\$200\.00\s+\$2,600\.00/);
    expect(out.stdout).toContain("365 days");
    expect(out.stdout).toContain("mean absolute error: 4.8% with new subscribers");
    expect(out.stdout).toMatch(/2026-10-23\s+30\s+\$2,000\.00/);
    expect(out.stdout).toMatch(/com\.example\.annual\s+\$49\.99\s+45%\s+\$20\.00\s+auto-renew/);
    expect(out.stdout).toContain("Segments with little data");
    expect(out.stdout).toMatch(/Photo Lab\s+P1Y\s+1st renewal\s+2\/6/);
    expect(out.stdout).not.toContain("1800/1900");
  });

  it("prints the overview line", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "GET /projection/summary": { ...P.summary, currency: "USD", generatedAt: P.generatedAt, next30Band: band(2000), backtestError: P.backtestError } });
    expect(await run(["projection", "--summary", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(out.stdout).toContain("Next 30 days: $2,000.00 ($1,800.00 – $2,200.00) expected proceeds (+$100.00 since yesterday)");
  });
});
