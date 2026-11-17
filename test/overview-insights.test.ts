import { describe, expect, it } from "vitest";
import type { GoalProgress, TodayApp } from "../shared/types";
import type { DayRow } from "../worker/lib/metrics";
import { addDays } from "../worker/lib/money";
import { buildInsights, compactMoney, type AppDay, type InsightInput } from "../worker/lib/overview-insights";

const TODAY = "2026-11-17";

function row(day: string, v: Partial<DayRow> = {}): DayRow {
  return {
    day,
    gross_usd: 100,
    proceeds_usd: 80,
    refunds_usd: 0,
    refunds: 0,
    new_subscriptions: 5,
    renewals: 5,
    one_time_purchases: 0,
    trials_started: 10,
    trial_conversions: 4,
    new_customers: 10,
    new_payers: 5,
    active_subscriptions: 500,
    active_trials: 30,
    mrr_usd: 3000,
    mrr_proceeds_usd: 2400,
    mrr_new: 0,
    mrr_expansion: 0,
    mrr_contraction: 0,
    mrr_churn: 0,
    mrr_reactivation: 0,
    churned_subscriptions: 1,
    ...v,
  };
}

/** 63 flat days ending today; `edit(i, day)` changes a day (0 = today, -1 = yesterday...). */
function rows(edit: (offset: number, day: string) => Partial<DayRow> = () => ({})): DayRow[] {
  return Array.from({ length: 63 }, (_, i) => {
    const offset = i - 62;
    const day = addDays(TODAY, offset);
    return row(day, edit(offset, day));
  });
}

function app(id: string, revenue: number, v: Partial<TodayApp> = {}): TodayApp {
  return { appId: id, name: id.toUpperCase(), iconUrl: null, revenue, proceeds: revenue * 0.8, sales: 1, trialsStarted: 0, refunds: 0, yesterdayRevenue: 0, yesterdayProceeds: 0, ...v };
}

function input(v: Partial<InsightInput> = {}): InsightInput {
  return { currency: "USD", rate: 1, today: TODAY, rows: rows(), appDays: [], appNames: new Map(), todayApps: [], goals: [], filtered: false, ...v };
}

const kinds = (i: InsightInput) => buildInsights(i).map((x) => x.kind);

describe("overview insights", () => {
  it("says nothing about flat data", () => {
    // Flat data: only the month pace against a complete October (flat, so neutral).
    const out = buildInsights(input());
    expect(out.map((x) => x.kind)).toEqual(["month_pace"]);
    expect(out[0].tone).toBe("neutral");
  });

  it("names the app carrying today, only with enough revenue and several apps", () => {
    const today = [app("a", 62), app("b", 30), app("c", 8)];
    const out = buildInsights(input({ todayApps: today }));
    const top = out.find((x) => x.kind === "today_top_app")!;
    expect(top.text).toBe("62% of today's revenue came from A ($62.00).");
    expect(top.link).toEqual({ type: "app", appId: "a" });
    expect(kinds(input({ todayApps: [app("a", 62)] }))).not.toContain("today_top_app");
    expect(kinds(input({ todayApps: [app("a", 6), app("b", 2)] }))).not.toContain("today_top_app");
    expect(kinds(input({ todayApps: [app("a", 35), app("b", 35), app("c", 30)] }))).not.toContain("today_top_app");
  });

  it("compares this week's trial conversion with last week's, with enough trials", () => {
    const r = rows((o) => (o <= -1 && o >= -7 ? { trial_conversions: 2 } : {}));
    const out = buildInsights(input({ rows: r }));
    const conv = out.find((x) => x.kind === "trial_conversion_week")!;
    expect(conv.tone).toBe("negative");
    expect(conv.text).toBe("Trial → paid conversion this week: 20%, 40% the week before.");
    // Too few trials.
    const small = rows((o) => (o <= -1 && o >= -7 ? { trial_conversions: 0, trials_started: 2 } : { trials_started: 2, trial_conversions: 1 }));
    expect(kinds(input({ rows: small }))).not.toContain("trial_conversion_week");
  });

  it("projects the month against a monthly revenue goal", () => {
    const goal = { id: "g1", label: "Revenue · All apps", archived: false, status: "active", metric: "revenue", period: "month", scope: "all", appIds: [], target: 5000, reachedAt: null } as unknown as GoalProgress;
    const out = buildInsights(input({ goals: [goal] }));
    const pace = out.find((x) => x.kind === "month_pace")!;
    // 16 days × $100 + 14 days left (today included) × $100 = $3,000.
    expect(pace.values.projected).toBe(3000);
    expect(pace.text).toBe("At this pace the month ends at ≈ $3,000, 60% of the $5,000 goal.");
    expect(pace.link).toEqual({ type: "goal", goalId: "g1" });
    expect(pace.tone).toBe("negative");
    // A filtered overview ignores workspace goals.
    expect(buildInsights(input({ goals: [goal], filtered: true })).find((x) => x.kind === "month_pace")!.link).toEqual({ type: "chart", metric: "revenue" });
  });

  it("flags an app's refund spike against its own usual rate", () => {
    const appDays: AppDay[] = [];
    for (let o = -30; o <= 0; o++) appDays.push({ app_id: "x", day: addDays(TODAY, o), gross_usd: 50, refunds: o >= -2 ? 2 : o % 7 === 0 ? 1 : 0, mrr_usd: 1000 });
    const out = buildInsights(input({ appDays, appNames: new Map([["x", "Messengers"]]) }));
    const spike = out.find((x) => x.kind === "refund_spike")!;
    expect(spike.appName).toBe("Messengers");
    expect(spike.values.refunds).toBe(6);
    expect(spike.text).toMatch(/^Messengers: 6 refunds in 3 days, \d+\.\d× its usual rate\.$/);
    // Two refunds in 3 days: too few.
    const few = appDays.map((d) => ({ ...d, refunds: d.day === TODAY ? 2 : 0 }));
    expect(kinds(input({ appDays: few }))).not.toContain("refund_spike");
  });

  it("reports the biggest MRR rise and fall of an app over 7 days, above a minimum", () => {
    const appDays: AppDay[] = [
      { app_id: "up", day: addDays(TODAY, -7), gross_usd: 0, refunds: 0, mrr_usd: 500 },
      { app_id: "up", day: TODAY, gross_usd: 0, refunds: 0, mrr_usd: 560 },
      { app_id: "down", day: addDays(TODAY, -7), gross_usd: 0, refunds: 0, mrr_usd: 800 },
      { app_id: "down", day: TODAY, gross_usd: 0, refunds: 0, mrr_usd: 600 },
      { app_id: "tiny", day: addDays(TODAY, -7), gross_usd: 0, refunds: 0, mrr_usd: 20 },
      { app_id: "tiny", day: TODAY, gross_usd: 0, refunds: 0, mrr_usd: 40 },
    ];
    const out = buildInsights(input({ appDays, appNames: new Map([["up", "Up"], ["down", "Down"], ["tiny", "Tiny"]]) })).filter((x) => x.kind === "app_mrr_change");
    expect(out.map((x) => x.text).sort()).toEqual(["Down MRR −25% in 7 days (now $600.00).", "Up MRR +12% in 7 days (now $560.00)."]);
  });

  it("keeps at most five, most important first", () => {
    const r = rows((o) => (o <= -1 && o >= -7 ? { trial_conversions: 1, gross_usd: 200, new_customers: 30, churned_subscriptions: 5 } : {}));
    const out = buildInsights(input({ rows: r, todayApps: [app("a", 80), app("b", 20)] }));
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out.map((x) => x.score)).toEqual([...out.map((x) => x.score)].sort((a, b) => b - a));
  });

  it("formats money compactly above 10,000", () => {
    expect(compactMoney(9300, "USD")).toBe("$9,300");
    expect(compactMoney(12_345, "USD")).toBe("$12.3K");
    expect(compactMoney(132.52, "USD")).toBe("$132.52");
  });
});
