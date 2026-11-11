import type { App, Goal, GoalMetric, GoalPace, GoalPeriod, GoalProgress } from "@shared/types";
import { fullNumber, money, moneyCompact, compactNumber } from "./format";
import type { Tone } from "../components/ui/Misc";

export const GOAL_METRIC_LABEL: Record<GoalMetric, string> = {
  revenue: "Revenue",
  proceeds: "Proceeds",
  mrr: "MRR",
  new_subscriptions: "New subscriptions",
  trials_started: "Trials started",
  active_subscriptions: "Active subscriptions",
  sales: "Sales",
};

export const GOAL_METRIC_HELP: Record<GoalMetric, string> = {
  revenue: "Gross revenue summed over the period.",
  proceeds: "Revenue after the store's commission, summed over the period.",
  mrr: "Monthly recurring revenue reached (a level, today's value).",
  new_subscriptions: "New paid subscriptions started in the period.",
  trials_started: "Free trials started in the period.",
  active_subscriptions: "Active paid subscriptions reached (a level, today's value).",
  sales: "New subscriptions, renewals and one-time purchases in the period.",
};

export const MONEY_METRICS: ReadonlySet<GoalMetric> = new Set(["revenue", "proceeds", "mrr"]);
export const STOCK_METRICS: ReadonlySet<GoalMetric> = new Set(["mrr", "active_subscriptions"]);

export const GOAL_PERIOD_LABEL: Record<GoalPeriod, string> = {
  week: "Weekly (Mon–Sun)",
  month: "Monthly",
  quarter: "Quarterly",
  year: "Yearly",
  custom: "Custom dates",
};

export const PACE: Record<GoalPace, { label: string; tone: Tone }> = {
  upcoming: { label: "Upcoming", tone: "zinc" },
  on_track: { label: "On track", tone: "green" },
  behind: { label: "Behind", tone: "amber" },
  reached: { label: "Reached", tone: "brand" },
  missed: { label: "Missed", tone: "red" },
};

export function goalValue(g: Pick<Goal, "format">, v: number, currency: string): string {
  return g.format === "money" ? money(v, currency) : fullNumber(v);
}

export function goalValueCompact(g: Pick<Goal, "format">, v: number, currency: string): string {
  return g.format === "money" ? moneyCompact(v, currency) : compactNumber(v);
}

const utc = (d: string) => new Date(`${d}T00:00:00Z`);
const DM = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
const DMY = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
const MY = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });

/** "1 Oct – 31 Dec 2026", "1 Dec 2026 – 31 Jan 2027". */
export function dateRange(start: string, end: string): string {
  if (start === end) return DMY.format(utc(start));
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return `${(sameYear ? DM : DMY).format(utc(start))} – ${DMY.format(utc(end))}`;
}

export function shortDate(d: string): string {
  return DMY.format(utc(d));
}

/** The goal's cadence: "Monthly", "Weekly (Mon–Sun)", "1 Oct – 31 Dec 2026". */
export function goalPeriodText(g: Pick<Goal, "period" | "startDate" | "endDate">): string {
  if (g.period === "custom") return g.startDate && g.endDate ? dateRange(g.startDate, g.endDate) : "Custom dates";
  return GOAL_PERIOD_LABEL[g.period];
}

/** The current period of a goal: "October 2026", "Q4 2026", "2026", "Week of 26 Oct", "1 Oct – 31 Dec 2026". */
export function currentPeriodText(g: Pick<GoalProgress, "period" | "periodStart" | "periodEnd">): string {
  switch (g.period) {
    case "month":
      return MY.format(utc(g.periodStart));
    case "quarter":
      return `Q${Math.floor(utc(g.periodStart).getUTCMonth() / 3) + 1} ${g.periodStart.slice(0, 4)}`;
    case "year":
      return g.periodStart.slice(0, 4);
    case "week":
      return `Week of ${DM.format(utc(g.periodStart))}`;
    default:
      return dateRange(g.periodStart, g.periodEnd);
  }
}

/** "All apps", "Focus Timer", "3 apps", "All apps except Focus Timer", "No apps" (its apps were deleted). */
export function scopeText(g: Pick<Goal, "scope" | "appIds">, byId: Map<string, App>): string {
  const name = (id: string) => byId.get(id)?.name ?? "an app";
  if (g.scope === "include" && g.appIds.length === 0) return "No apps";
  if (g.scope === "all" || g.appIds.length === 0) return "All apps";
  if (g.scope === "include") return g.appIds.length === 1 ? name(g.appIds[0]) : `${g.appIds.length} apps`;
  return g.appIds.length === 1 ? `All apps except ${name(g.appIds[0])}` : `All apps except ${g.appIds.length}`;
}

export function daysLeftText(g: Pick<GoalProgress, "status" | "daysLeft" | "periodStart">): string {
  if (g.status === "ended") return "Ended";
  if (g.status === "upcoming") return `Starts ${shortDate(g.periodStart)}`;
  if (g.daysLeft === 0) return "Last day";
  return `${g.daysLeft} day${g.daysLeft === 1 ? "" : "s"} left`;
}
