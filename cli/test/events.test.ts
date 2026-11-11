import { afterEach, describe, expect, it, vi } from "vitest";
import { fmtSeconds, parseStepSpec } from "../src/commands/events.js";
import { run } from "../src/main.js";
import type { EventSummary, Funnel, FunnelReport, KeyEventSettings } from "../src/types.js";
import { app, capture, loggedInEnv, mockFetch, reply, type Call } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const APPS = { items: [app("app_1", "Photo Lab", "com.example.events")], currency: "USD" };
const T = Date.UTC(2026, 9, 20);
const FUNNEL: Funnel = {
  id: "fn_1",
  appId: "app_1",
  name: "Onboarding",
  steps: [{ type: "event", name: "onboarding_step", filters: [{ key: "step", value: "1" }] }, { type: "event", name: "paywall_view" }, { type: "revenue", kind: "trial_started" }],
  windowSeconds: 7 * 86_400,
  ordered: true,
  alerts: { enabled: true, sensitivity: "normal" },
  createdAt: T,
  updatedAt: T,
};
const SUMMARY: EventSummary = {
  appId: "app_1",
  from: "2026-10-14",
  to: "2026-10-20",
  days: 7,
  totalEvents: 150,
  uniqueInstalls: 41,
  events: [
    { name: "app_open", count: 120, installs: 40, lastSeenAt: T, source: "sampled" },
    { name: "paywall_view", count: 30, installs: 25, lastSeenAt: T, source: "exact" },
  ],
  daily: [{ date: "2026-10-20", count: 150, byEvent: { app_open: 120, paywall_view: 30 } }],
  approximate: false,
  generatedAt: T,
};
const REPORT: FunnelReport = {
  funnel: FUNNEL,
  from: "2026-09-21",
  to: "2026-10-20",
  breakdown: null,
  steps: [
    { index: 0, label: "onboarding_step (step=1)", users: 300, conversionFromPrevious: 1, conversionFromFirst: 1, dropOff: 0, medianSecondsFromPrevious: null },
    { index: 1, label: "paywall_view", users: 200, conversionFromPrevious: 2 / 3, conversionFromFirst: 2 / 3, dropOff: 100, medianSecondsFromPrevious: 90 },
    { index: 2, label: "Trial started", users: 50, conversionFromPrevious: 0.25, conversionFromFirst: 1 / 6, dropOff: 150, medianSecondsFromPrevious: 7200 },
  ],
  groups: [],
  approximate: true,
  source: "sampled",
  notes: ["Analytics Engine sampled this app's events."],
  generatedAt: T,
};

describe("step specs", () => {
  it("parses event and revenue steps", () => {
    expect(parseStepSpec("event:paywall_view")).toEqual({ type: "event", name: "paywall_view" });
    expect(parseStepSpec("event:onboarding_step:step=1,variant=b")).toEqual({ type: "event", name: "onboarding_step", filters: [{ key: "step", value: "1" }, { key: "variant", value: "b" }] });
    expect(parseStepSpec("event:screen:home")).toEqual({ type: "event", name: "screen:home" });
    expect(parseStepSpec("event:screen:home:tab=1")).toEqual({ type: "event", name: "screen:home", filters: [{ key: "tab", value: "1" }] });
    expect(parseStepSpec("revenue:trial_started")).toEqual({ type: "revenue", kind: "trial_started" });
    for (const bad of ["revenue:refund", "paywall_view", "event:", "event:x:=1"]) expect(() => parseStepSpec(bad), bad).toThrow();
    expect(fmtSeconds(90)).toBe("2m");
    expect(fmtSeconds(7200)).toBe("2h");
  });
});

describe("events and funnels", () => {
  it("events: top events table", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({ "GET /apps": APPS, "GET /apps/app_1/events/summary": SUMMARY });
    expect(await run(["events", "com.example.events", "--range", "7d", "--no-color"], { env: loggedInEnv(), fetch })).toBe(0);
    expect(calls.at(-1)!.url.searchParams.get("range")).toBe("7d");
    expect(out.stdout).toContain("150 events from 41 installs");
    expect(out.stdout).toMatch(/app_open\s+120\s+40\s+sampled/);
    expect(out.stdout).toMatch(/paywall_view\s+30\s+25\s+exact/);
  });

  it("events key-events: shows and changes the key-event settings", async () => {
    const out = capture();
    const SETTINGS: KeyEventSettings = {
      appId: "app_1",
      builtin: ["first_open", "purchase_*", "restore_*", "paywall_view", "paywall_close", "onboarding_*", "experiment_exposure"],
      patterns: ["promo_*"],
      dailyCap: 9_166,
      dailyCapIsDefault: true,
      defaultDailyCap: 9_166,
      backgroundWritesPerDay: 55_000,
      writesPerEvent: 3,
      retentionDays: 180,
      since: "2026-10-01",
      today: { date: "2026-10-20", count: 1234, capped: false },
      limits: { patterns: 20, maxDailyCap: 1_000_000, minRetentionDays: 7, maxRetentionDays: 365, perInstallPerDay: 500 },
    };
    const { fetch, calls } = mockFetch({
      "GET /apps": APPS,
      "GET /apps/app_1/key-events": SETTINGS,
      "PUT /apps/app_1/key-events": (call: Call) => ({ ...SETTINGS, ...(call.body as object), today: { ...SETTINGS.today, capped: true } }),
    });
    const env = loggedInEnv();
    expect(await run(["events", "app_1", "key-events", "--no-color"], { env, fetch })).toBe(0);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(out.stdout).toMatch(/Extra patterns\s+promo_\*/);
    expect(out.stdout).toMatch(/Exact since\s+2026-10-01/);
    expect(out.stdout).toMatch(/Today\s+1,234 stored/);
    expect(out.stdout).toMatch(/Daily cap\s+9,166 a day \(default\)/);
    expect(out.stdout).not.toContain("background budget");

    out.stdout = "";
    expect(await run(["events", "app_1", "key-events", "--add", "*_paywall_view", "--rm", "PROMO_*", "--daily-cap", "80000", "--retention", "90", "--no-color"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.method).toBe("PUT");
    expect(calls.at(-1)!.body).toEqual({ patterns: ["*_paywall_view"], dailyCap: 80_000, retentionDays: 90 });
    expect(out.stdout).toContain("incomplete: the rest of today is sampled");
    // 80,000 × 3 rows: over half the background budget.
    expect(out.stdout).toContain("over half the daily background budget (55,000)");

    expect(await run(["events", "app_1", "key-events", "--daily-cap", "default", "--no-color"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ dailyCap: null });

    const n = calls.length;
    expect(await run(["events", "app_1", "key-events", "--add", "a*b"], { env, fetch })).toBe(2);
    expect(await run(["events", "app_1", "key-events", "--daily-cap", "lots"], { env, fetch })).toBe(2);
    expect(await run(["events", "app_1", "keys"], { env, fetch })).toBe(2);
    expect(calls.slice(n).some((c) => c.method === "PUT")).toBe(false);
  });

  it("events: explains the setup when queries are not configured", async () => {
    const out = capture();
    const { fetch } = mockFetch({ "GET /apps": APPS, "GET /apps/app_1/events/summary": reply(409, { error: "Event queries are not configured", code: "analytics_not_configured" }) });
    expect(await run(["events", "app_1"], { env: loggedInEnv(), fetch })).toBe(1);
    expect(out.stderr).toContain("CF_ANALYTICS_TOKEN");
  });

  it("funnels: list, report, create, delete", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({
      "GET /apps": APPS,
      "GET /apps/app_1/funnels": { items: [FUNNEL] },
      "GET /apps/app_1/funnels/fn_1/report": REPORT,
      "POST /apps/app_1/funnels": (call: Call) => ({ ...FUNNEL, ...(call.body as object), id: "fn_2" }),
      "DELETE /apps/app_1/funnels/fn_1": { ok: true },
    });
    const env = loggedInEnv();
    expect(await run(["funnels", "app_1", "--no-color"], { env, fetch })).toBe(0);
    expect(out.stdout).toMatch(/fn_1\s+Onboarding\s+7d\s+ordered\s+on \(normal\)\s+onboarding_step \(step=1\) → paywall_view → revenue:trial_started/);

    out.stdout = "";
    expect(await run(["funnels", "app_1", "show", "onboarding", "--range", "30d", "--breakdown", "country", "--no-color"], { env, fetch })).toBe(0);
    const q = calls.at(-1)!.url.searchParams;
    expect([q.get("range"), q.get("breakdown")]).toEqual(["30d", "country"]);
    expect(out.stdout).toContain("approximate");
    expect(out.stdout).toMatch(/2\s+paywall_view\s+200\s+66\.7%\s+66\.7%\s+100\s+2m/);
    expect(out.stdout).toMatch(/3\s+Trial started\s+50\s+25%\s+16\.7%\s+150\s+2h/);
    expect(out.stdout).toContain("note: Analytics Engine sampled");

    expect(
      await run(["funnels", "app_1", "create", "--name", "Paywall", "--step", "event:paywall_view:placement=onboarding", "--step", "revenue:paid", "--window", "1d", "--unordered", "--no-color"], { env, fetch }),
    ).toBe(0);
    expect(calls.at(-1)!.body).toEqual({
      name: "Paywall",
      steps: [{ type: "event", name: "paywall_view", filters: [{ key: "placement", value: "onboarding" }] }, { type: "revenue", kind: "paid" }],
      window: "1d",
      ordered: false,
    });
    expect(await run(["funnels", "app_1", "create", "--name", "x", "--step", "event:a"], { env, fetch })).toBe(2);

    expect(await run(["funnels", "app_1", "delete", "fn_1"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.method).toBe("DELETE");
    expect(await run(["funnels", "app_1", "show", "nope"], { env, fetch })).toBe(1);
  });

  it("funnels: alert settings (show, on / off, sensitivity)", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({
      "GET /apps": APPS,
      "GET /apps/app_1/funnels": { items: [FUNNEL] },
      "PATCH /apps/app_1/funnels/fn_1": (call: Call) => ({ ...FUNNEL, alerts: { ...FUNNEL.alerts!, ...(call.body as { alerts: object }).alerts } }),
    });
    const env = loggedInEnv();
    expect(await run(["funnels", "app_1", "alerts", "Onboarding", "--no-color"], { env, fetch })).toBe(0);
    expect(out.stdout).toContain("Onboarding fn_1: alerts on, sensitivity normal");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);

    out.stdout = "";
    expect(await run(["funnels", "app_1", "alerts", "fn_1", "off", "--no-color"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ alerts: { enabled: false } });
    expect(out.stdout).toContain("alerts off, sensitivity normal");

    expect(await run(["funnels", "app_1", "alerts", "fn_1", "on", "--sensitivity", "high", "--json"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ alerts: { enabled: true, sensitivity: "high" } });
    expect(await run(["funnels", "app_1", "alerts", "fn_1", "maybe"], { env, fetch })).toBe(2);
    expect(await run(["funnels", "app_1", "alerts", "fn_1", "--sensitivity", "extreme"], { env, fetch })).toBe(2);
    expect(await run(["funnels", "app_1", "show", "fn_1", "extra"], { env, fetch })).toBe(2);
  });
});
