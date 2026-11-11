import { afterEach, describe, expect, it, vi } from "vitest";
import { campaignLink, dimCell, funnelLine, parseAcquisitionBy } from "../src/commands/acquisition.js";
import { run } from "../src/main.js";
import type { Acquisition, AcquisitionMetrics } from "../src/types.js";
import { app, capture, loggedInEnv, mockFetch, reply } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const metrics = (impressions: number, pageViews: number, downloads: number, proceeds: number): AcquisitionMetrics => ({
  impressions,
  impressionsUnique: Math.round(impressions * 0.8),
  pageViews,
  pageViewsUnique: pageViews,
  downloads,
  redownloads: Math.round(downloads / 10),
  conversionRate: pageViews ? downloads / pageViews : null,
  purchases: proceeds ? 2 : 0,
  proceeds,
  sales: proceeds * 1.2,
});

const DATA: Acquisition = {
  currency: "USD",
  from: "2026-09-19",
  to: "2026-10-16",
  by: ["source"],
  level: "standard",
  totals: metrics(12000, 2000, 400, 120.5),
  rows: [
    { sourceType: "App Store search", ...metrics(10000, 1500, 300, 100) },
    { sourceType: "Web referrer", ...metrics(2000, 500, 100, 20.5) },
  ],
  firstDay: "2026-08-01",
  lastDay: "2026-10-15",
};

const CAMPAIGNS: Acquisition = {
  ...DATA,
  by: ["campaign"],
  level: "detailed",
  rows: [
    { campaign: "spring_launch", ...metrics(0, 300, 60, 10) },
    { campaign: "", ...metrics(0, 1200, 250, 80) },
  ],
};

const APPS = { items: [app("app_1", "Photo Lab", "com.example.mini", { appleAppId: "111" }), app("app_2", "Notes", "com.example.notes")], currency: "USD" };

describe("helpers", () => {
  it("parses --by with aliases and rejects unknown dimensions", () => {
    expect(parseAcquisitionBy(undefined)).toEqual(["source"]);
    expect(parseAcquisitionBy("days, Sources,day")).toEqual(["day", "source"]);
    expect(() => parseAcquisitionBy("keyword")).toThrow(/use source, referrer, campaign, day or app/);
  });

  it("formats cells, the funnel line and campaign links", () => {
    expect(dimCell({ ...metrics(0, 0, 0, 0), campaign: "" }, "campaign")).toBe("(none)");
    expect(dimCell({ ...metrics(0, 0, 0, 0), referrer: "com.example.other" }, "referrer")).toBe("com.example.other");
    expect(dimCell({ ...metrics(0, 0, 0, 0), appId: "app_1" }, "app", new Map([["app_1", "Photo Lab"]]))).toBe("Photo Lab");
    expect(funnelLine(DATA.totals, "USD")).toBe("12,000 impressions → 2,000 page views → 400 downloads (20% conversion) · 40 redownloads · $120.50 proceeds");
    expect(funnelLine(metrics(5, 0, 0, 0), "USD")).not.toContain("conversion");
    expect(campaignLink("111", "spring launch", "12345")).toBe("https://apps.apple.com/app/id111?pt=12345&ct=spring%20launch");
  });
});

describe("acquisition", () => {
  it("defaults to 28d by source and prints the funnel and a table", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({ "GET /acquisition": DATA });
    expect(await run(["acquisition", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    const q = calls[0].url.searchParams;
    expect(q.get("range")).toBe("28d");
    expect(q.get("by")).toBe("source");
    expect(out.stdout).toContain("400 downloads (20% conversion)");
    expect(out.stdout).toMatch(/SOURCE\s+IMPRESSIONS\s+PAGE VIEWS\s+DOWNLOADS\s+CONV\.\s+REDOWNLOADS\s+PURCHASES\s+PROCEEDS/);
    expect(out.stdout).toMatch(/App Store search\s+10,000\s+1,500\s+300\s+20%\s+30\s+2\s+\$100\.00/);
    expect(out.stdout).not.toContain("Detailed reports");
    expect(out.stdout).toContain("run until 2026-10-15");
  });

  it("--json prints the API response; passes apps, range and currency", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({ "GET /apps": APPS, "GET /acquisition": DATA });
    expect(await run(["acquisition", "--json", "--range", "90d", "--app", "Photo Lab", "--currency", "eur", "--by", "day,source"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(DATA);
    const q = calls.find((c) => c.url.pathname.endsWith("/acquisition"))!.url.searchParams;
    expect([q.get("range"), q.get("apps"), q.get("currency"), q.get("by")]).toEqual(["90d", "app_1", "EUR", "day,source"]);
  });

  it("explains how to get data when Apple has none yet", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "GET /acquisition": { ...DATA, rows: [], firstDay: null, lastDay: null } });
    expect(await run(["acquisition"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(out.stdout).toContain("revflare acquisition requests");
    expect(out.stdout).toContain("1–2 days");
    expect(out.stdout).toContain("https://apps.apple.com/app/id<APPID>?pt=<provider token>&ct=<campaign>");
  });

  it("--by campaign shows (none) and the privacy note; bad --by is a usage error", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({ "GET /acquisition": CAMPAIGNS });
    expect(await run(["acquisition", "--by", "campaign", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(calls[0].url.searchParams.get("by")).toBe("campaign");
    expect(out.stdout).toMatch(/spring_launch\s+0\s+300\s+60/);
    expect(out.stdout).toMatch(/\(none\)\s+0\s+1,200\s+250/);
    expect(out.stdout).toContain("fewer than 5 users");
    expect(await run(["acquisition", "--by", "keyword"], { env: loggedInEnv(), fetch })).toBe(2);
    expect(out.stderr).toContain("Invalid --by");
  });

  it("--by app names the apps", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "GET /apps": APPS, "GET /acquisition": { ...DATA, by: ["app"], rows: [{ appId: "app_2", ...metrics(10, 5, 1, 0) }] } });
    expect(await run(["acquisition", "--by", "app", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(out.stdout).toMatch(/APP\s+IMPRESSIONS/);
    expect(out.stdout).toMatch(/Notes\s+10\s+5\s+1/);
  });
});

describe("acquisition subcommands", () => {
  it("campaigns and status list per app", async () => {
    const out = capture();
    const { fetch } = mockFetch({
      "GET /apps": APPS,
      "GET /acquisition/campaigns": { currency: "USD", items: [{ campaign: "spring_launch", appId: "app_1", appleAppId: "111", firstSeen: "2026-09-01", lastSeen: "2026-10-10", impressions: 0, pageViews: 300, downloads: 60, redownloads: 3, purchases: 2, proceeds: 10 }] },
      "GET /acquisition/status": {
        items: [
          { appId: "app_1", appleAppId: "111", state: "producing", requestId: "r1", requestedAt: 1, checkedAt: 2, reports: ["a"], lastProcessingDate: "2026-10-15", firstDay: "2026-08-01", lastDay: "2026-10-15", error: null },
          { appId: "app_2", appleAppId: null, state: "failed", requestId: null, requestedAt: null, checkedAt: null, reports: [], lastProcessingDate: null, firstDay: null, lastDay: null, error: "Forbidden: needs the Admin role" },
        ],
      },
    });
    expect(await run(["acquisition", "campaigns", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(out.stdout).toMatch(/spring_launch\s+Photo Lab\s+2026-09-01\s+2026-10-10\s+0\s+300\s+60\s+3\s+\$10\.00/);
    out.stdout = "";
    expect(await run(["acquisition", "status", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(out.stdout).toMatch(/Photo Lab\s+producing/);
    expect(out.stdout).toContain("2026-08-01 → 2026-10-15");
    expect(out.stdout).toContain("Forbidden: needs the Admin role");
    expect(out.stdout).toContain("--retry");
  });

  it("requests loops while apps remain and prints created / existing / failed", async () => {
    const out = capture();
    const answers = [
      { created: [{ appId: "app_1", name: "Photo Lab" }], existing: [], failed: [], remaining: 1 },
      { created: [], existing: [], failed: [{ appId: "app_2", name: "Notes", error: "No App Store id" }], remaining: 0 },
    ];
    let n = 0;
    const { fetch, calls } = mockFetch({ "POST /acquisition/requests": () => answers[n++] });
    expect(await run(["acquisition", "requests", "--retry", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(calls.map((c) => c.body)).toEqual([{ retry: true }, { retry: true }]);
    expect(out.stdout).toContain("✓ Photo Lab requested");
    expect(out.stdout).toContain("✗ Notes: No App Store id");
    out.stdout = "";
    n = 0;
    expect(await run(["acquisition", "requests", "--json"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ created: [{ appId: "app_1" }], failed: [{ appId: "app_2" }], remaining: 0 });
  });

  it("requests stops after a bounded number of calls and reports server errors", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({ "POST /acquisition/requests": () => ({ created: [], existing: [{ appId: "app_1", name: "Photo Lab" }], failed: [], remaining: 5 }) });
    expect(await run(["acquisition", "requests", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(calls).toHaveLength(20);
    expect(calls[0].body).toEqual({ retry: false });
    expect(out.stdout.match(/Photo Lab/g)).toHaveLength(1);
    expect(out.stdout).toContain("5 app(s) left");
    const bad = mockFetch({ "POST /acquisition/requests": reply(400, { error: "No App Store Connect key" }) });
    expect(await run(["acquisition", "requests"], { env: loggedInEnv(), fetch: bad.fetch })).toBe(1);
    expect(out.stderr).toContain("No App Store Connect key");
  });

  it("import starts the job", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({ "POST /imports/acquisition": { id: "job_1", reused: false } });
    expect(await run(["acquisition", "import", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(calls[0].method).toBe("POST");
    expect(out.stdout).toContain("Job job_1 started. Follow it: revflare jobs show job_1");
  });
});
