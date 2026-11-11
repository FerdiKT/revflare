import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/errors.js";
import { run } from "../src/main.js";
import { resolveApp, resolveApps } from "../src/resolve.js";
import { app, capture, loggedInEnv, mockFetch } from "./helpers.js";

const APPS = [
  app("app_1", "Photo Lab", "com.example.photolab", { appleAppId: "111" }),
  app("app_2", "Tune Finder", "com.example.Tune-Finder", { appleAppId: "222" }),
  app("app_3", "Doc Scanner", "com.example.docscanner"),
  app("app_4", "Doc Scanner", "com.example.easyscan"),
  app("app_5", "Old Tune Finder", "com.example.old", { archived: true }),
  app("app_6", "Old Tune Finder", "com.example.old2"),
];

afterEach(() => vi.restoreAllMocks());

describe("resolveApp", () => {
  it("by id, bundle id (case-insensitive), App Store id and name", () => {
    expect(resolveApp("app_1", APPS).id).toBe("app_1");
    expect(resolveApp("com.example.tune-finder", APPS).id).toBe("app_2");
    expect(resolveApp("222", APPS).id).toBe("app_2");
    expect(resolveApp("photo lab", APPS).id).toBe("app_1");
  });

  it("prefers active apps over archived duplicates", () => {
    expect(resolveApp("Old Tune Finder", APPS).id).toBe("app_6");
  });

  it("ambiguous and unknown selectors list the candidates", () => {
    expect(() => resolveApp("Doc Scanner", APPS)).toThrow(/matches 2 apps:[\s\S]*app_3[\s\S]*app_4[\s\S]*Use the app id/);
    try {
      resolveApp("com.nope", APPS);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      for (const a of APPS) expect((err as Error).message).toContain(a.id);
    }
    expect(() => resolveApp("x", [])).toThrow(/no apps/);
  });

  it("several selectors, comma separated, deduplicated", () => {
    expect(resolveApps(["com.example.photolab,222", "app_1"], APPS).map((a) => a.id)).toEqual(["app_1", "app_2"]);
  });
});

describe("--app on metric commands", () => {
  it("resolves bundle ids to app ids in the query", async () => {
    capture();
    const { fetch, calls } = mockFetch({
      "GET /apps": { items: APPS, currency: "EUR" },
      "GET /charts/mrr": { metric: "mrr", format: "money", currency: "EUR", interval: "month", from: "2026-01-01", to: "2026-03-31", points: [], total: 0, previousTotal: null },
    });
    expect(await run(["chart", "mrr", "--app", "com.example.photolab", "-a", "222", "--range", "90d", "--interval", "month", "--currency", "usd"], { env: loggedInEnv(), fetch })).toBe(0);
    const chart = calls.find((c) => c.url.pathname === "/api/v1/charts/mrr")!;
    expect(Object.fromEntries(chart.url.searchParams)).toEqual({ apps: "app_1,app_2", range: "90d", interval: "month", currency: "USD" });
    expect(chart.headers.authorization).toBe("Bearer rf_testkey123");
  });

  it("an unknown app is a usage error before any metric call", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({ "GET /apps": { items: APPS, currency: "EUR" } });
    expect(await run(["overview", "--app", "com.nope"], { env: loggedInEnv(), fetch })).toBe(2);
    expect(out.stderr).toContain('No app matches "com.nope"');
    expect(calls.map((c) => c.url.pathname)).toEqual(["/api/v1/apps"]);
  });
});
