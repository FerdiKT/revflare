import { afterEach, describe, expect, it, vi } from "vitest";
import { describeRule } from "../src/commands/remote-config.js";
import { run } from "../src/main.js";
import type { AttributionOptions, EventSummary, Funnel, FunnelReport, RemoteConfigEvaluation, TestDevices } from "../src/types.js";
import { app, capture, loggedInEnv, mockFetch, type Call } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const APPS = { items: [app("app_1", "Photo Lab", "com.example.testdata")], currency: "USD" };
const T = Date.UTC(2026, 9, 20);
const A = "6f1c2a4e-0b7d-4c41-9a51-2f3e4d5c6b7a";
const B = "00000000-0000-4000-8000-000000000002";

describe("remote config by acquisition source", () => {
  it("eval sends source, Apple Ads ids and environment; validates them", async () => {
    capture();
    const EV: RemoteConfigEvaluation = { version: "abc", values: { paywall: "hard" }, conditions: ["ads"], country: null, parameters: { paywall: { condition: "ads", useInAppDefault: false, value: "hard" } } };
    const { fetch, calls } = mockFetch({ "GET /apps": APPS, "POST /apps/app_1/config/evaluate": EV });
    const env = loggedInEnv();
    expect(
      await run(["config", "app_1", "eval", "--source", "apple_ads", "--campaign", "123", "--ad-group", "456", "--keyword", "789", "--environment", "sandbox", "--no-color"], { env, fetch }),
    ).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ source: "apple_ads", campaign: "123", adGroup: "456", keyword: "789", environment: "sandbox" });
    const n = calls.length;
    expect(await run(["config", "app_1", "eval", "--source", "facebook"], { env, fetch })).not.toBe(0);
    expect(await run(["config", "app_1", "eval", "--environment", "staging"], { env, fetch })).not.toBe(0);
    expect(await run(["config", "app_1", "eval", "--campaign", "12a"], { env, fetch })).not.toBe(0);
    expect(calls.slice(n).some((c) => c.method === "POST")).toBe(false);
  });

  it("describes the new rules and lists attribution options", async () => {
    expect(describeRule({ type: "source", values: ["apple_ads"] })).toBe("source in apple_ads");
    expect(describeRule({ type: "apple_ads_campaign", values: ["1", "2"] })).toBe("apple_ads_campaign in 1, 2");
    expect(describeRule({ type: "environment", values: ["sandbox", "xcode"] })).toBe("environment in sandbox, xcode");
    const out = capture();
    const OPTS: AttributionOptions = {
      appId: "app_1",
      days: 14,
      campaigns: [{ id: "1001", name: null, installs: 12 }],
      adGroups: [{ id: "2001", campaignId: "1001", name: null, installs: 12 }],
      keywords: [{ id: "3001", campaignId: "1001", adGroupId: "2001", name: null, installs: 5 }],
    };
    const { fetch, calls } = mockFetch({ "GET /apps": APPS, "GET /apps/app_1/config/attribution-options": OPTS });
    expect(await run(["config", "app_1", "attribution-options", "--days", "14", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(calls.at(-1)!.url.searchParams.get("days")).toBe("14");
    expect(out.stdout).toMatch(/1001\s+-\s+12/);
    expect(out.stdout).toMatch(/3001\s+2001\s+-\s+5/);
  });
});

describe("test data", () => {
  it("--include-test asks events and funnel reports for test data", async () => {
    const out = capture();
    const SUMMARY: EventSummary = { appId: "app_1", from: "2026-10-14", to: "2026-10-20", days: 7, totalEvents: 3, uniqueInstalls: 1, events: [], daily: [], approximate: false, includeTest: true, generatedAt: T };
    const FUNNEL: Funnel = {
      id: "fn_1",
      appId: "app_1",
      name: "Onboarding",
      steps: [{ type: "event", name: "a" }, { type: "event", name: "b" }],
      windowSeconds: 86_400,
      ordered: true,
      alerts: { enabled: false, sensitivity: "normal" },
      createdAt: T,
      updatedAt: T,
    };
    const REPORT: FunnelReport = { funnel: FUNNEL, from: "2026-10-14", to: "2026-10-20", breakdown: null, steps: [], groups: [], approximate: false, notes: [], includeTest: true, generatedAt: T };
    const { fetch, calls } = mockFetch({
      "GET /apps": APPS,
      "GET /apps/app_1/events/summary": SUMMARY,
      "GET /apps/app_1/funnels": { items: [FUNNEL] },
      "GET /apps/app_1/funnels/fn_1/report": REPORT,
    });
    const env = loggedInEnv();
    expect(await run(["events", "app_1", "--no-color"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.url.searchParams.has("includeTest")).toBe(false);
    expect(await run(["events", "app_1", "--include-test", "--no-color"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.url.searchParams.get("includeTest")).toBe("true");
    expect(out.stdout).toContain("test data included");
    expect(await run(["funnels", "app_1", "show", "fn_1", "--include-test", "--no-color"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.url.pathname).toMatch(/\/funnels\/fn_1\/report$/);
    expect(calls.at(-1)!.url.searchParams.get("includeTest")).toBe("true");
  });

  it("apps <app> test-devices list, add and rm (GET then PUT the whole list)", async () => {
    const out = capture();
    let stored: string[] = [A];
    const view = (): TestDevices => ({ appId: "app_1", installIds: stored, limit: 50 });
    const { fetch, calls } = mockFetch({
      "GET /apps": APPS,
      "GET /apps/app_1/test-devices": () => view(),
      "PUT /apps/app_1/test-devices": (call: Call) => {
        stored = call.body.installIds;
        return view();
      },
    });
    const env = loggedInEnv();
    expect(await run(["apps", "com.example.testdata", "test-devices", "--no-color"], { env, fetch })).toBe(0);
    expect(out.stdout).toContain(A);
    expect(await run(["apps", "app_1", "test-devices", "add", B.toUpperCase(), A, "--no-color"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ installIds: [A, B] });
    expect(await run(["apps", "app_1", "test-devices", "rm", A, "--json"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ installIds: [B] });
    const n = calls.length;
    expect(await run(["apps", "app_1", "test-devices", "add", "not-a-uuid"], { env, fetch })).not.toBe(0);
    expect(await run(["apps", "app_1", "test-devices", "add"], { env, fetch })).not.toBe(0);
    expect(await run(["apps", "app_1", "devices"], { env, fetch })).not.toBe(0);
    expect(calls.slice(n).some((c) => c.method === "PUT")).toBe(false);
  });
});
