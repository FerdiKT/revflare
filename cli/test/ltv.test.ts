import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/main.js";
import type { Ltv, LtvHorizon, LtvSummary } from "../src/types.js";
import { app, capture, loggedInEnv, mockFetch } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const h = (day: number | null, rev: number | null, payers: number | null = 1): LtvHorizon =>
  rev === null ? { day, immature: true, revenuePerInstall: null, proceedsPerInstall: null, payers: null } : { day, immature: false, revenuePerInstall: rev, proceedsPerInstall: rev * 0.85, payers };
const none = { campaignId: null, adGroupId: null, keywordId: null, country: null };
const coverage = { installs: 60, attributed: 20, preexisting: 3, payingCustomers: 40, linkedCustomers: 30, share: 0.75 };

const LTV: Ltv = {
  currency: "USD",
  by: "source",
  cohort: "week",
  from: "2026-04-06",
  to: "2026-10-23",
  horizons: [0, 7, 30, 90, 180],
  coverage,
  rows: [
    { cohort: "2026-10-19", group: "apple_ads", ...none, installs: 10, payers: 1, trials: 2, revenue: 9.99, proceeds: 8.49, horizons: [h(0, 0.999), h(7, null), h(30, null), h(90, null), h(180, null), h(null, 0.999)] },
    { cohort: "2026-04-06", group: "organic", ...none, installs: 50, payers: 5, trials: 0, revenue: 250, proceeds: 212.5, horizons: [h(0, 1), h(7, 2), h(30, 3), h(90, 4), h(180, 4.5), h(null, 5)] },
  ],
};

const SUMMARY: LtvSummary = {
  currency: "USD",
  by: "campaign",
  from: "2026-07-26",
  to: "2026-10-23",
  horizons: [0, 7, 30, 90, 180],
  coverage,
  rows: [
    {
      group: "501",
      ...none,
      campaignId: "501",
      installs: 40,
      payers: 4,
      trials: 6,
      conversion: 0.1,
      revenue: 120,
      proceeds: 102,
      horizons: [
        { ...h(0, 1), installs: 40 },
        { ...h(7, 1.5), installs: 38 },
        { ...h(30, 2.25), installs: 20 },
        { ...h(90, null), installs: 0 },
        { ...h(180, null), installs: 0 },
      ],
    },
  ],
};

const APPS = { items: [app("app_1", "Photo Lab", "com.example.mini")], currency: "USD" };

describe("ltv", () => {
  it("prints install cohorts per group with immature horizons dotted and the coverage", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({ "GET /apps": APPS, "GET /ltv": LTV });
    expect(await run(["ltv", "--app", "com.example.mini", "--cohort", "week", "--range", "12m", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    const q = calls.find((c) => c.url.pathname.endsWith("/ltv"))!.url.searchParams;
    expect(Object.fromEntries(q)).toMatchObject({ apps: "app_1", by: "source", cohort: "week", range: "12m" });
    expect(out.stdout).toMatch(/COHORT\s+GROUP\s+INSTALLS\s+PAYERS\s+D0\s+D7\s+D30\s+D90\s+D180\s+TO DATE/);
    expect(out.stdout).toMatch(/2026-10-19\s+Apple Ads\s+10\s+1\s+\$1\.00\s+·\s+·\s+·\s+·\s+\$1\.00/);
    expect(out.stdout).toMatch(/2026-04-06\s+Organic\s+50\s+5\s+\$1\.00\s+\$2\.00\s+\$3\.00\s+\$4\.00\s+\$4\.50\s+\$5\.00/);
    expect(out.stdout).toContain("30 of 40 paying customers linked to a reporting install (75%)");
    expect(out.stdout).toContain("60 installs, 20 from Apple Ads, 3 earlier users not counted");
  });

  it("--summary asks /ltv/summary (default by campaign) and prints pooled values; --json passes the API response", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({ "GET /ltv/summary": SUMMARY });
    expect(await run(["ltv", "--summary", "--range", "90d", "--proceeds", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ by: "campaign", range: "90d" });
    expect(out.stdout).toMatch(/GROUP\s+INSTALLS\s+PAYERS\s+CONV\s+D7\s+D30\s+D90\s+TO DATE/);
    expect(out.stdout).toMatch(/501\s+40\s+4\s+10(\.0)?%\s+\$1\.28 \(38\)\s+\$1\.91 \(20\)\s+·\s+\$2\.55/);
    out.stdout = "";
    expect(await run(["ltv", "--summary", "--by", "keywords", "--json"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(calls[1].url.searchParams.get("by")).toBe("keyword");
    expect(JSON.parse(out.stdout)).toEqual(SUMMARY);
  });

  it("rejects a bad --by or --cohort", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({});
    expect(await run(["ltv", "--by", "placement"], { env: loggedInEnv(), fetch })).toBe(2);
    expect(out.stderr).toContain("use source, campaign, adgroup, keyword, country");
    expect(await run(["ltv", "--cohort", "year"], { env: loggedInEnv(), fetch })).toBe(2);
    expect(await run(["ltv", "--summary", "--cohort", "day"], { env: loggedInEnv(), fetch })).toBe(2);
    expect(calls).toHaveLength(0);
  });
});
