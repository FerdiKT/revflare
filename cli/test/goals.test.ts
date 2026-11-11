import { afterEach, describe, expect, it, vi } from "vitest";
import { goalPeriodText, goalScopeLabel } from "../src/commands/manage.js";
import { run } from "../src/main.js";
import type { GoalProgress } from "../src/types.js";
import { app, capture, loggedInEnv, mockFetch, reply } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const APPS = { items: [app("app_1", "Photo Lab", "com.example.photo"), app("app_2", "Sky Routes", "com.example.sky"), app("app_3", "Cubix", "com.example.cubix")], currency: "USD" };

const goal = (extra: Partial<GoalProgress>): GoalProgress => ({
  id: "goal_1",
  name: null,
  label: "Revenue · All apps",
  metric: "revenue",
  format: "money",
  kind: "flow",
  period: "month",
  startDate: null,
  endDate: null,
  target: 5000,
  scope: "all",
  appIds: [],
  appId: null,
  archived: false,
  notify: false,
  sortOrder: 0,
  createdAt: Date.UTC(2026, 9, 1),
  periodStart: "2026-10-01",
  periodEnd: "2026-10-31",
  periodLabel: "2026-10",
  status: "active",
  daysTotal: 31,
  daysElapsed: 26,
  daysLeft: 5,
  current: 4000,
  startValue: null,
  progress: 0.8,
  projected: 4769.23,
  expected: 4193.55,
  delta: -193.55,
  pace: "behind",
  requiredPerDay: 166.67,
  reachedAt: null,
  previous: { periodStart: "2026-09-01", periodEnd: "2026-09-30", periodLabel: "2026-09", value: 5200, reached: true },
  ...extra,
});

const GOALS = {
  currency: "USD",
  items: [
    goal({}),
    goal({ id: "goal_2", name: "Q4 push", label: "Q4 push", period: "quarter", periodLabel: "2026-Q4", scope: "include", appIds: ["app_1", "app_2"], pace: "on_track" }),
    goal({ id: "goal_3", name: "Not the game", label: "Not the game", metric: "active_subscriptions", format: "count", kind: "stock", target: 900, current: 812, startValue: 790, scope: "exclude", appIds: ["app_3"] }),
    goal({ id: "goal_4", name: "Old", label: "Old", archived: true }),
  ],
};

describe("goal labels", () => {
  it("summarizes the app scope and the period", () => {
    const names = new Map(APPS.items.map((a) => [a.id, a.name]));
    expect(goalScopeLabel({ scope: "all", appIds: [] }, names)).toBe("All apps");
    expect(goalScopeLabel({ scope: "include", appIds: ["app_1"] }, names)).toBe("Photo Lab");
    expect(goalScopeLabel({ scope: "include", appIds: ["app_1", "app_2", "app_3"] }, names)).toBe("3 apps");
    expect(goalScopeLabel({ scope: "exclude", appIds: ["app_3"] }, names)).toBe("All apps except Cubix");
    expect(goalScopeLabel({ scope: "exclude", appIds: ["app_2", "app_3"] }, names)).toBe("All apps except 2");
    expect(goalScopeLabel({ scope: "include", appIds: [] }, names)).toBe("No apps");
    expect(goalPeriodText({ period: "custom", periodLabel: "x", periodStart: "2026-11-15", periodEnd: "2026-12-31" })).toBe("2026-11-15 → 2026-12-31");
    expect(goalPeriodText({ period: "week", periodLabel: "2026-W44", periodStart: "2026-10-26", periodEnd: "2026-11-01" })).toBe("week 2026-W44");
  });
});

describe("goals", () => {
  it("lists, shows, adds, edits, archives, reorders and removes goals", async () => {
    const out = capture();
    const { fetch, calls } = mockFetch({
      "GET /apps": APPS,
      "GET /goals": GOALS,
      "GET /goals/goal_3": { currency: "USD", goal: GOALS.items[2] },
      "POST /goals": (call: { body: Record<string, unknown> }) => ({ id: "goal_9", currency: "USD", goal: goal({ id: "goal_9", label: String(call.body.name ?? "Revenue · All apps"), progress: 0.1 }) }),
      "PATCH /goals/goal_2": { id: "goal_2", currency: "USD", goal: GOALS.items[1] },
      "PATCH /goals/goal_4": { id: "goal_4", currency: "USD", goal: GOALS.items[3] },
      "POST /goals/reorder": (call: { body: { ids: string[] } }) => ({ ok: true, ids: [...call.body.ids, "goal_1"] }),
      "DELETE /goals/goal_1": { ok: true },
    });
    const env = loggedInEnv();

    expect(await run(["goals", "--no-color"], { env, fetch })).toBe(0);
    expect(out.stdout).toMatch(/Q4 push/);
    expect(out.stdout).toMatch(/Photo Lab|2 apps/);
    expect(out.stdout).toMatch(/All apps except Cubix/);
    expect(out.stdout).not.toMatch(/Old/);
    expect(out.stdout).toMatch(/behind/);
    out.stdout = "";
    expect(await run(["goals", "list", "--all", "--json"], { env, fetch })).toBe(0);
    expect(JSON.parse(out.stdout).items).toHaveLength(4);

    out.stdout = "";
    expect(await run(["goals", "show", "goal_3", "--no-color"], { env, fetch })).toBe(0);
    expect(out.stdout).toMatch(/Start of period\s+790/);
    expect(out.stdout).toMatch(/Previous period\s+2026-09/);

    expect(await run(["goals", "add", "--name", "Holiday sale", "--metric", "sales", "--target", "2500", "--from", "2026-11-15", "--to", "2026-12-31", "--apps", "com.example.photo,app_2", "--notify", "--json"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.method).toBe("POST");
    expect(calls.at(-1)!.body).toEqual({ name: "Holiday sale", metric: "sales", target: 2500, period: "custom", startDate: "2026-11-15", endDate: "2026-12-31", scope: "include", appIds: ["app_1", "app_2"], notify: true });

    expect(await run(["goals", "add", "--target", "900", "--metric", "active_subscriptions", "--exclude-apps", "com.example.cubix", "--period", "week", "--json"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ metric: "active_subscriptions", target: 900, period: "week", scope: "exclude", appIds: ["app_3"], notify: true });
    expect(await run(["goals", "add", "--target", "5", "--no-notify", "--json"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ metric: "revenue", target: 5, notify: false });

    expect(await run(["goals", "edit", "goal_2", "--name", "Q4", "--target", "20000", "--all-apps", "--no-notify", "--json"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.method).toBe("PATCH");
    expect(calls.at(-1)!.body).toEqual({ name: "Q4", target: 20000, scope: "all", notify: false });

    expect(await run(["goals", "archive", "goal_4", "--json"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ archived: true });
    expect(await run(["goals", "archive", "goal_4", "--undo", "--json"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ archived: false });

    expect(await run(["goals", "reorder", "goal_3", "goal_2", "--json"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ ids: ["goal_3", "goal_2"] });

    expect(await run(["goals", "rm", "goal_1", "--json"], { env, fetch })).toBe(0);
    expect(calls.at(-1)!.method).toBe("DELETE");
    expect(await run(["goals", "remove", "goal_1", "--json"], { env, fetch })).toBe(0);
  });

  it("rejects bad options before calling the server", async () => {
    capture();
    const { fetch, calls } = mockFetch({ "GET /apps": APPS, "GET /goals/goal_1": { currency: "USD", goal: goal({}) }, "POST /goals": reply(400, { error: "pick at least one app" }) });
    const env = loggedInEnv();
    expect(await run(["goals", "add", "--target", "10", "--metric", "nope"], { env, fetch })).toBe(2);
    expect(await run(["goals", "add", "--target", "10", "--period", "custom", "--from", "2026-11-01"], { env, fetch })).toBe(2);
    expect(await run(["goals", "add", "--target", "10", "--apps", "app_1", "--exclude-apps", "app_2"], { env, fetch })).toBe(2);
    expect(await run(["goals", "add", "--target", "10", "--name", "x".repeat(61)], { env, fetch })).toBe(2);
    expect(await run(["goals", "edit", "goal_1"], { env, fetch })).toBe(2);
    // One date alone on a rolling goal: refused before any change.
    expect(await run(["goals", "edit", "goal_1", "--from", "2026-11-01"], { env, fetch })).toBe(2);
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    // Server errors come through.
    expect(await run(["goals", "add", "--target", "10"], { env, fetch })).not.toBe(0);
  });
});
