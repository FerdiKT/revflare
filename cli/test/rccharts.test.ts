import { afterEach, describe, expect, it, vi } from "vitest";
import { alreadyImported, mapProjects, selectSpecs, toPoints } from "../src/commands/rccharts.js";
import type { Exec } from "../src/context.js";
import { run } from "../src/main.js";
import { RC_METRICS, chunk, chunkRange, parseChart, type RcApp, type RcProject } from "../src/revenuecat.js";
import { BUDGET, QUOTA, app, capture, loggedInEnv, mockFetch } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const DAY = 86_400;
const t = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;
const spec = (m: string) => RC_METRICS.find((s) => s.metric === m)!;

describe("parseChart", () => {
  it("sums the spec's measures per day and skips incomplete days", () => {
    const chart = {
      measures: [{ display_name: "Trial Conversions", unit: "#" }, { display_name: "Intro Offers", unit: "#" }, { display_name: "Direct Subscriptions", unit: "#" }, { display_name: "Product Changes", unit: "#" }, { display_name: "Resubscriptions", unit: "#" }, { display_name: "Total Paid Subscriptions", unit: "#" }],
      values: [
        ...[5, 1, 2, 9, 1, 18].map((value, measure) => ({ cohort: t("2026-09-01"), incomplete: false, measure, value })),
        { cohort: t("2026-09-02"), incomplete: true, measure: 0, value: 3 },
      ],
      user_selectors: {},
    };
    expect([...parseChart(chart, spec("new_subscriptions"))]).toEqual([["2026-09-01", 9]]);
  });

  it("rejects missing measures, ignored selectors and non-USD money", () => {
    const base = { measures: [{ display_name: "Revenue", unit: "$" }], values: [], user_selectors: { revenue_type: "revenue" }, yaxis_currency: "USD" };
    expect(() => parseChart(base, spec("proceeds"))).toThrow(/no measure Proceeds/);
    expect(() => parseChart({ ...base, measures: [{ display_name: "Proceeds", unit: "$" }] }, spec("proceeds"))).toThrow(/ignored revenue_type=proceeds/);
    expect(() => parseChart({ ...base, yaxis_currency: "EUR" }, spec("revenue"))).toThrow(/EUR/);
  });
});

describe("helpers", () => {
  it("toPoints drops zeros and days from the cutoff on, sorted and rounded", () => {
    const m = new Map([["2026-01-03", 1.005], ["2026-01-01", 2], ["2026-01-02", 0], ["2026-02-01", 5]]);
    expect(toPoints(m, { cutoff: "2026-02-01" })).toEqual([{ day: "2026-01-01", value: 2 }, { day: "2026-01-03", value: 1 }]);
    expect(toPoints(m, { keepZeros: true }).length).toBe(4);
  });

  it("chunks ranges and points", () => {
    expect(chunkRange("2024-01-01", "2024-01-10", 4)).toEqual([["2024-01-01", "2024-01-04"], ["2024-01-05", "2024-01-08"], ["2024-01-09", "2024-01-10"]]);
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("selectSpecs: default excludes opt-in metrics", () => {
    expect(selectSpecs([]).map((s) => s.metric)).not.toContain("new_customers");
    expect(selectSpecs(["mrr,new-customers"]).map((s) => s.metric)).toEqual(["mrr", "new_customers"]);
    expect(() => selectSpecs(["profit"])).toThrow(/Unknown metric/);
  });
});

const PROJECTS: RcProject[] = [
  { id: "projA", name: "Photo Lab", created_at: Date.UTC(2026, 8, 1) },
  { id: "projB", name: "Focus Timer", created_at: Date.UTC(2026, 8, 1) },
  { id: "projC", name: "Unknown", created_at: Date.UTC(2026, 8, 1) },
  { id: "projD", name: "Web only", created_at: Date.UTC(2026, 8, 1) },
];
const rcApp = (id: string, project_id: string, type: string, bundle?: string): RcApp => ({ id, name: id, type, project_id, ...(bundle ? { app_store: { bundle_id: bundle } } : {}) });
const RC_APPS: Record<string, RcApp[]> = {
  projA: [rcApp("appA", "projA", "app_store", "com.example.photolab")],
  projB: [rcApp("appB1", "projB", "stripe"), rcApp("appB2", "projB", "app_store", "Com.Example.FocusTimer")],
  projC: [rcApp("appC", "projC", "app_store", "com.other")],
  projD: [rcApp("appD", "projD", "stripe")],
};
const REVFLARE = [app("app_1", "Photo Lab", "com.example.photolab", { historyBackfilledFrom: "2026-09-04" }), app("app_2", "Focus Timer", "com.example.focustimer")];

describe("mapProjects", () => {
  it("maps App Store bundle ids to Revflare apps and explains the rest", () => {
    const { mappings, targets } = mapProjects(PROJECTS, new Map(Object.entries(RC_APPS)), REVFLARE);
    expect(targets.map((t) => [t.app.id, t.sources.map((s) => s.app.id)])).toEqual([["app_1", ["appA"]], ["app_2", ["appB2"]]]);
    expect(mappings.find((m) => m.project.id === "projC")!.skipped).toMatch(/no Revflare app with bundle id com.other/);
    expect(mappings.find((m) => m.project.id === "projD")!.skipped).toBe("no App Store app in the project");
  });

  it("sums several projects with the same bundle id into one app", () => {
    const apps = new Map(Object.entries({ ...RC_APPS, projC: [rcApp("appC", "projC", "app_store", "com.example.photolab")] }));
    const { targets } = mapProjects(PROJECTS, apps, REVFLARE);
    expect(targets[0].sources.map((s) => s.project.id)).toEqual(["projA", "projC"]);
  });
});

/** A fake `revenuecat` CLI: every chart has value 2 per day for each measure (day 2 is zero). */
function fakeRevenuecat(log: string[][]): Exec {
  const ok = (data: unknown) => JSON.stringify({ ok: true, data, error: null });
  return async (cmd, args) => {
    log.push(args);
    if (args[0] === "projects") return ok({ items: PROJECTS });
    if (args[0] === "apps") return ok({ items: RC_APPS[args[args.indexOf("--project-id") + 1]] });
    const chartName = args[2];
    const param = (k: string) => args.find((a, i) => args[i - 1] === "--param" && a.startsWith(`${k}=`))!.split("=")[1];
    const selectors = args.includes("--selectors-json") ? JSON.parse(args[args.indexOf("--selectors-json") + 1]) : {};
    const s = RC_METRICS.find((m) => m.chart === chartName && (!m.selectors || m.selectors.revenue_type === selectors.revenue_type))!;
    const values = [];
    for (let d = t(param("start_date")), i = 0; d <= t(param("end_date")); d += DAY, i++) {
      for (let measure = 0; measure < s.measures.length; measure++) values.push({ cohort: d, incomplete: false, measure, value: i === 1 ? 0 : 2 });
    }
    return ok({ measures: s.measures.map((display_name) => ({ display_name, unit: s.money ? "$" : "#" })), values, user_selectors: s.selectors ?? {}, yaxis_currency: "USD" });
  };
}

describe("import revenuecat-charts", () => {
  const routes = () => ({
    "GET /apps": { items: REVFLARE, currency: "EUR" },
    "POST /imports/external-metrics": (c: { body: { points: unknown[] } }) => ({ stored: c.body.points.length }),
    "DELETE /imports/external-metrics": { ok: true },
    "GET /imports/external-metrics": { items: [] },
  });

  it("uploads each metric for the days before Revflare's own history, filtered to the App Store app", async () => {
    capture();
    const rcLog: string[][] = [];
    const { fetch, calls } = mockFetch(routes());
    const now = () => new Date(Date.UTC(2026, 8, 6, 12));
    expect(await run(["import", "revenuecat-charts", "--json"], { env: loggedInEnv(), fetch, exec: fakeRevenuecat(rcLog), now })).toBe(0);
    const posts = calls.filter((c) => c.method === "POST");
    // 2 mapped apps × 9 default metrics.
    expect(posts.length).toBe(18);
    const aiRevenue = posts.find((c) => c.body.appId === "app_1" && c.body.metric === "revenue")!.body;
    // Project from 09-01, Revflare's own data from 09-04: 09-01 and 09-03 (09-02 is zero).
    expect(aiRevenue).toEqual({ appId: "app_1", source: "revenuecat", metric: "revenue", points: [{ day: "2026-09-01", value: 2 }, { day: "2026-09-03", value: 2 }] });
    // new_subscriptions sums four measures.
    expect(posts.find((c) => c.body.appId === "app_2" && c.body.metric === "new_subscriptions")!.body.points[0]).toEqual({ day: "2026-09-01", value: 8 });
    const chartCalls = rcLog.filter((a) => a[0] === "metrics");
    expect(chartCalls.every((a) => a.includes("resolution=day"))).toBe(true);
    const focustimer = chartCalls.find((a) => a.includes("projB"))!;
    expect(JSON.parse(focustimer[focustimer.indexOf("--filters-json") + 1])).toEqual([{ name: "app_id", values: ["appB2"] }]);
    expect(rcLog.find((a) => a.includes("projA") && a[0] === "metrics")).toContain("end_date=2026-09-03");
  });

  it("--dry-run writes nothing; --project limits the apps; --replace deletes first", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch(routes());
    const now = () => new Date(Date.UTC(2026, 8, 6, 12));
    expect(await run(["import", "revenuecat-charts", "--dry-run", "--project", "Focus Timer", "--metric", "mrr"], { env: loggedInEnv(), fetch, exec: fakeRevenuecat([]), now })).toBe(0);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(calls.find((c) => c.url.pathname.endsWith("/imports/external-metrics"))!.url.search).toBe("?appId=app_2&source=revenuecat");
    expect(out.stdout).toContain("Dry run: 5 points would be imported into 1 apps.");
    expect(await run(["import", "revenuecat-charts", "--project", "projB", "--metric", "mrr", "--replace", "--json"], { env: loggedInEnv(), fetch, exec: fakeRevenuecat([]), now })).toBe(0);
    expect(calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      "DELETE /api/v1/imports/external-metrics?appId=app_2&source=revenuecat",
      "POST /api/v1/imports/external-metrics",
    ]);
    expect(await run(["import", "revenuecat-charts", "--project", "projZ"], { env: loggedInEnv(), fetch, exec: fakeRevenuecat([]), now })).toBe(2);
  });

  it("splits uploads into requests of at most 5000 points", async () => {
    capture();
    const { fetch, calls } = mockFetch(routes());
    const now = () => new Date(Date.UTC(2041, 0, 1));
    expect(await run(["import", "revenuecat-charts", "--project", "projB", "--metric", "mrr", "--json"], { env: loggedInEnv(), fetch, exec: fakeRevenuecat([]), now })).toBe(0);
    const sizes = calls.filter((c) => c.method === "POST").map((c) => c.body.points.length);
    expect(sizes.length).toBe(2);
    expect(sizes[0]).toBe(5000);
  });

  it("retries rate limits and reports RevenueCat errors per metric", async () => {
    const out = capture();
    const base = fakeRevenuecat([]);
    let limited = 0;
    const exec: Exec = async (cmd, args) => {
      if (args[0] === "metrics" && args[2] === "mrr" && limited++ === 0) return JSON.stringify({ ok: false, data: null, error: { type: "rate_limit_error", status_code: 429, message: "slow down" } });
      if (args[0] === "metrics" && args[2] === "refunds") return JSON.stringify({ ok: false, data: null, error: { type: "parameter_error", status_code: 400, message: "chart unavailable" } });
      return base(cmd, args);
    };
    const { fetch } = mockFetch(routes());
    const sleeps: number[] = [];
    const now = () => new Date(Date.UTC(2026, 8, 6, 12));
    expect(await run(["import", "revenuecat-charts", "--project", "projB", "--metric", "mrr,refunds", "--json"], { env: loggedInEnv(), fetch, exec, now, sleep: async (ms) => void sleeps.push(ms) })).toBe(0);
    expect(sleeps.length).toBe(1);
    const res = JSON.parse(out.stdout);
    const metrics = res.apps[0].metrics;
    expect(metrics.find((m: { metric: string }) => m.metric === "mrr")).toMatchObject({ points: 5, uploaded: true });
    expect(metrics.find((m: { metric: string }) => m.metric === "refunds").skipped).toMatch(/chart unavailable/);
  });

  it("stops cleanly when the daily import budget is used up (exit 3) and says how to continue", async () => {
    const out = capture();
    let posts = 0;
    const { fetch, calls } = mockFetch({ ...routes(), "POST /imports/external-metrics": (c: { body: { points: unknown[] } }) => (posts++ < 2 ? { stored: c.body.points.length } : BUDGET) });
    // 2041: Photo Lab (own history from 2026-09-04) sends 2 points; Focus Timer's mrr needs two requests of 5000 points and
    // the second one hits the budget.
    const now = () => new Date(Date.UTC(2041, 0, 1, 20, 30));
    expect(await run(["import", "revenuecat-charts", "--metric", "mrr", "--json"], { env: loggedInEnv(), fetch, exec: fakeRevenuecat([]), now })).toBe(3);
    let res = JSON.parse(out.stdout);
    expect(res.stopped).toMatchObject({ code: "budget", appId: "app_2", metric: "mrr", appsDone: 1, appsTotal: 2, pointsSent: 5002 });
    expect(res.apps[1].metrics[0]).toMatchObject({ sent: 5000, uploaded: false, stopped: true });
    expect(calls.filter((c) => c.method === "POST").length).toBe(3);

    // Budget used up from the first request: the second app is not started.
    out.stdout = "";
    calls.length = 0;
    posts = 2;
    expect(await run(["import", "revenuecat-charts", "--metric", "mrr", "--json"], { env: loggedInEnv(), fetch, exec: fakeRevenuecat([]), now })).toBe(3);
    res = JSON.parse(out.stdout);
    expect(res.stopped).toMatchObject({ appId: "app_1", appsDone: 0, pointsSent: 0 });
    expect(res.apps.length).toBe(1);
    expect(calls.filter((c) => c.method === "POST").length).toBe(1);
    expect(calls.some((c) => c.url.search.includes("app_2"))).toBe(false);

    out.stdout = out.stderr = "";
    posts = 2;
    expect(await run(["import", "revenuecat-charts", "--metric", "mrr"], { env: loggedInEnv(), fetch, exec: fakeRevenuecat([]), now })).toBe(3);
    expect(out.stderr).toContain("Stopped at Photo Lab (mrr): Today's database budget for imports and other background work is used up");
    expect(out.stderr).toContain("Sent 0 points; 0 of 2 apps complete.");
    expect(out.stderr).toContain("Re-run the same command after 00:00 UTC (in 3h 30m) to continue");
  });

  it("stops on the daily database quota too", async () => {
    const out = capture();
    const { fetch } = mockFetch({ ...routes(), "GET /imports/external-metrics": QUOTA });
    const now = () => new Date(Date.UTC(2026, 8, 6, 23, 59, 30));
    expect(await run(["import", "revenuecat-charts", "--metric", "mrr"], { env: loggedInEnv(), fetch, exec: fakeRevenuecat([]), now })).toBe(3);
    expect(out.stderr).toContain("Cloudflare Free plan database limit: requests fail until 00:00 UTC (in less than a minute)");
  });

  it("skips metrics already imported up to the last day; --force sends them", async () => {
    const out = capture();
    const summary = { items: [{ appId: "app_2", metric: "mrr", first: "2026-09-01", last: "2026-09-06", days: 5 }, { appId: "app_2", metric: "revenue", first: "2026-09-01", last: "2026-09-05", days: 4 }] };
    const { fetch, calls } = mockFetch({ ...routes(), "GET /imports/external-metrics": summary });
    const now = () => new Date(Date.UTC(2026, 8, 6, 12));
    const args = ["import", "revenuecat-charts", "--project", "projB", "--metric", "mrr,revenue"];
    expect(await run([...args, "--json"], { env: loggedInEnv(), fetch, exec: fakeRevenuecat([]), now })).toBe(0);
    let posts = calls.filter((c) => c.method === "POST");
    // mrr is complete up to 09-06; revenue only up to 09-05, so it is sent again.
    expect(posts.map((c) => c.body.metric)).toEqual(["revenue"]);
    const metrics = JSON.parse(out.stdout).apps[0].metrics;
    expect(metrics.find((m: { metric: string }) => m.metric === "mrr")).toMatchObject({ alreadyImported: true, sent: 0, skipped: "already imported up to 2026-09-06" });

    out.stdout = "";
    expect(await run(args, { env: loggedInEnv(), fetch, exec: fakeRevenuecat([]), now })).toBe(0);
    expect(out.stdout).toContain("1 metric already imported, not sent again (--force sends them).");

    calls.length = 0;
    expect(await run([...args, "--force", "--json"], { env: loggedInEnv(), fetch, exec: fakeRevenuecat([]), now })).toBe(0);
    posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.body.metric).sort()).toEqual(["mrr", "revenue"]);
    expect(calls.some((c) => c.method === "GET" && c.url.pathname.endsWith("/imports/external-metrics"))).toBe(false);
  });
});

describe("alreadyImported", () => {
  const items = [{ appId: "a", metric: "mrr", first: "2026-01-02", last: "2026-01-10", days: 9 }];
  it("needs the whole span of the points", () => {
    expect(alreadyImported(items, "a", "mrr", [{ day: "2026-01-02" }, { day: "2026-01-10" }])).toBe(true);
    expect(alreadyImported(items, "a", "mrr", [{ day: "2026-01-02" }, { day: "2026-01-11" }])).toBe(false);
    expect(alreadyImported(items, "a", "mrr", [{ day: "2026-01-01" }, { day: "2026-01-10" }])).toBe(false);
    expect(alreadyImported(items, "a", "revenue", [{ day: "2026-01-05" }])).toBe(false);
    expect(alreadyImported(items, "b", "mrr", [{ day: "2026-01-05" }])).toBe(false);
    expect(alreadyImported(items, "a", "mrr", [])).toBe(false);
  });
});
