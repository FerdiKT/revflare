import { describe, expect, it } from "vitest";
import { goalNumbers, isoWeekLabel, parseGoalInput, periodBounds, previousBounds, rowScope, sameAppSet, sameTarget } from "../worker/lib/goals";

describe("goal periods", () => {
  it("weeks run Monday to Sunday with ISO week labels", () => {
    expect(periodBounds("week", "2026-10-26")).toEqual({ start: "2026-10-26", end: "2026-11-01", label: "2026-W44" });
    expect(periodBounds("week", "2026-11-01")).toEqual({ start: "2026-10-26", end: "2026-11-01", label: "2026-W44" });
    // Across a year end: 2026-12-31 is a Thursday of week 53 of 2026; 2027-01-04 starts week 1 of 2027.
    expect(periodBounds("week", "2027-01-02")).toEqual({ start: "2026-12-28", end: "2027-01-03", label: "2026-W53" });
    expect(isoWeekLabel("2027-01-04")).toBe("2027-W01");
    expect(isoWeekLabel("2024-12-30")).toBe("2025-W01");
    expect(previousBounds("week", periodBounds("week", "2026-10-28"))).toEqual({ start: "2026-10-19", end: "2026-10-25", label: "2026-W43" });
  });

  it("months, quarters and years", () => {
    expect(periodBounds("month", "2026-10-26")).toEqual({ start: "2026-10-01", end: "2026-10-31", label: "2026-10" });
    expect(periodBounds("month", "2028-02-10")).toEqual({ start: "2028-02-01", end: "2028-02-29", label: "2028-02" });
    expect(previousBounds("month", periodBounds("month", "2026-01-15"))).toEqual({ start: "2025-12-01", end: "2025-12-31", label: "2025-12" });
    expect(periodBounds("quarter", "2026-10-26")).toEqual({ start: "2026-10-01", end: "2026-12-31", label: "2026-Q4" });
    expect(periodBounds("quarter", "2026-03-31")).toEqual({ start: "2026-01-01", end: "2026-03-31", label: "2026-Q1" });
    expect(periodBounds("quarter", "2026-04-01")).toEqual({ start: "2026-04-01", end: "2026-06-30", label: "2026-Q2" });
    expect(previousBounds("quarter", periodBounds("quarter", "2026-02-01"))).toEqual({ start: "2025-10-01", end: "2025-12-31", label: "2025-Q4" });
    expect(periodBounds("year", "2026-10-26")).toEqual({ start: "2026-01-01", end: "2026-12-31", label: "2026" });
    expect(previousBounds("year", periodBounds("year", "2026-10-26"))?.label).toBe("2025");
  });

  it("custom periods have their dates and no previous period", () => {
    const b = periodBounds("custom", "2026-10-26", { start: "2026-11-15", end: "2026-12-31" });
    expect(b).toEqual({ start: "2026-11-15", end: "2026-12-31", label: "2026-11-15..2026-12-31" });
    expect(previousBounds("custom", b)).toBeNull();
  });
});

describe("goal progress", () => {
  const b = { start: "2026-10-01", end: "2026-10-10", label: "x" };
  const daily = (v: Record<string, number>) => (d: string) => v[d] ?? 0;

  it("flow: projection, expected by now, needed per day", () => {
    // 6 days elapsed (the 1st to the 6th), 10 a day, target 200.
    const v: Record<string, number> = {};
    for (let i = 1; i <= 6; i++) v[`2026-10-0${i}`] = 10;
    v["2026-09-30"] = 1000; // before the period: not counted
    const n = goalNumbers("flow", 200, b, "2026-10-06", daily(v));
    expect(n).toMatchObject({ status: "active", daysTotal: 10, daysElapsed: 6, daysLeft: 4, current: 60, projected: 100, expected: 120, delta: -60, pace: "behind", reachedAt: null, startValue: null });
    // 140 left over 5 days (today included).
    expect(n.requiredPerDay).toBe(28);
    expect(n.progress).toBeCloseTo(0.3);
    // A faster pace is on track.
    expect(goalNumbers("flow", 90, b, "2026-10-06", daily(v)).pace).toBe("on_track");
  });

  it("flow: reached date, then the end", () => {
    const v = { "2026-10-01": 50, "2026-10-03": 60, "2026-10-09": 10 };
    const n = goalNumbers("flow", 100, b, "2026-10-05", daily(v));
    expect(n).toMatchObject({ pace: "reached", reachedAt: "2026-10-03", requiredPerDay: 0, current: 110 });
    const ended = goalNumbers("flow", 500, b, "2026-10-20", daily(v));
    expect(ended).toMatchObject({ status: "ended", daysElapsed: 10, daysLeft: 0, current: 120, projected: 120, pace: "missed", requiredPerDay: null });
    const upcoming = goalNumbers("flow", 100, b, "2026-09-20", daily(v));
    expect(upcoming).toMatchObject({ status: "upcoming", daysElapsed: 0, daysLeft: 10, current: 0, pace: "upcoming", expected: 0 });
    expect(upcoming.requiredPerDay).toBe(10);
  });

  it("stock: today's level, start of period, linear path from it", () => {
    const v = { "2026-09-30": 100, "2026-10-01": 110, "2026-10-02": 130, "2026-10-03": 125, "2026-10-04": 128 };
    const n = goalNumbers("stock", 200, b, "2026-10-04", daily(v));
    expect(n).toMatchObject({ current: 128, startValue: 100, projected: 128, daysElapsed: 4, daysLeft: 6, reachedAt: null });
    // Linear from 100 to 200 over 10 days: 140 after 4 days.
    expect(n.expected).toBe(140);
    expect(n.pace).toBe("behind");
    expect(n.requiredPerDay).toBeCloseTo(72 / 7);
    const reached = goalNumbers("stock", 129, b, "2026-10-04", daily(v));
    // Crossed on the 2nd, back under it today: not reached now, but ahead of the path (100 → 129).
    expect(reached).toMatchObject({ reachedAt: "2026-10-02", pace: "on_track" });
    expect(goalNumbers("stock", 120, b, "2026-10-04", daily(v))).toMatchObject({ pace: "reached", reachedAt: "2026-10-02" });
  });
});

describe("goal input", () => {
  it("validates and merges", () => {
    expect(parseGoalInput({ metric: "revenue", target: 10 }, null)).toEqual({
      value: { name: null, metric: "revenue", target: 10, period: "month", startDate: null, endDate: null, scope: "all", appIds: [], archived: false, notify: false },
    });
    expect(parseGoalInput({ metric: "revenue", target: 10, appId: "app_1" }, null)).toMatchObject({ value: { scope: "include", appIds: ["app_1"] } });
    expect(parseGoalInput({ metric: "sales", target: 5, name: "  Q4  ", scope: "exclude", appIds: ["a", "a", "b"], period: "custom", startDate: "2026-11-01", endDate: "2026-11-30", notify: true }, null)).toMatchObject({
      value: { name: "Q4", scope: "exclude", appIds: ["a", "b"], period: "custom", startDate: "2026-11-01", endDate: "2026-11-30", notify: true },
    });
    const errors = [
      { metric: "nope", target: 1 },
      { metric: "revenue" },
      { metric: "revenue", target: -1 },
      { metric: "revenue", target: 1, name: "x".repeat(61) },
      { metric: "revenue", target: 1, period: "custom" },
      { metric: "revenue", target: 1, period: "custom", startDate: "2026-11-30", endDate: "2026-11-01" },
      { metric: "revenue", target: 1, period: "custom", startDate: "2026-02-30", endDate: "2026-03-01" },
      { metric: "revenue", target: 1, period: "custom", startDate: "2024-01-01", endDate: "2026-12-31" },
      { metric: "revenue", target: 1, scope: "include" },
      { metric: "revenue", target: 1, scope: "exclude", appIds: [] },
      { metric: "revenue", target: 1, scope: "everything" },
      { metric: "revenue", target: 1, notify: "yes" },
    ];
    for (const e of errors) expect(parseGoalInput(e as never, null), JSON.stringify(e)).toHaveProperty("error");
    // An update keeps what it does not change; leaving a custom period drops its dates.
    const base = { name: "Q4", metric: "revenue" as const, target: 10, period: "custom" as const, startDate: "2026-11-01", endDate: "2026-11-30", scope: "include" as const, appIds: ["a"], archived: false, notify: true };
    expect(parseGoalInput({ archived: true }, base)).toEqual({ value: { ...base, archived: true } });
    expect(parseGoalInput({ period: "quarter" }, base)).toEqual({ value: { ...base, period: "quarter", startDate: null, endDate: null } });
    expect(parseGoalInput({ scope: "all" }, base)).toEqual({ value: { ...base, scope: "all", appIds: [] } });
    expect(parseGoalInput({ name: "" }, base)).toEqual({ value: { ...base, name: null } });
  });

  it("reads rows written before the scope columns", () => {
    expect(rowScope({ scope: "all", app_ids: "[]", app_id: "app_1" })).toEqual({ scope: "include", appIds: ["app_1"] });
    expect(rowScope({ scope: "all", app_ids: "[]", app_id: null })).toEqual({ scope: "all", appIds: [] });
    expect(rowScope({ scope: "exclude", app_ids: '["a","b"]', app_id: null })).toEqual({ scope: "exclude", appIds: ["a", "b"] });
  });
});

describe("goal edits", () => {
  it("compares app sets and targets the way clients send them back", () => {
    expect(sameAppSet(["b", "a"], ["a", "b"])).toBe(true);
    expect(sameAppSet(["a"], ["a", "b"])).toBe(false);
    expect(sameTarget(103.33, 103.333333)).toBe(true);
    expect(sameTarget(1_234_567.891, 1_234_567.89)).toBe(true);
    expect(sameTarget(103.34, 103.333333)).toBe(false);
    expect(sameTarget(10, 11)).toBe(false);
  });

  it("an include goal left without apps stays editable until its apps change", () => {
    const base = { name: null, metric: "revenue" as const, target: 10, period: "month" as const, startDate: null, endDate: null, scope: "include" as const, appIds: [], archived: false, notify: true };
    expect(parseGoalInput({ archived: true }, base)).toMatchObject({ value: { archived: true, scope: "include", appIds: [] } });
    expect(parseGoalInput({ scope: "include" }, base)).toEqual({ error: "pick at least one app" });
    expect(parseGoalInput({ appIds: [] }, base)).toEqual({ error: "pick at least one app" });
  });
});
