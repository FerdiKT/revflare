// Overview insights: short, rule-based observations on numbers the overview already read (no extra queries, no
// LLM). Each rule needs a minimum sample and a minimum effect, so small or noisy numbers say nothing; the survivors are
// scored and the top few returned (docs/api.md#insights). Inputs are USD (daily rows) unless noted; texts and values
// are in the workspace currency (`rate`).

import type { GoalProgress, Insight, Metric, TodayApp } from "../../shared/types";
import type { DayRow } from "./metrics";
import { addDays } from "./money";

/** One app's daily row (the overview's per-app read). */
export interface AppDay {
  app_id: string;
  day: string;
  gross_usd: number;
  refunds: number;
  mrr_usd: number;
}

export interface InsightInput {
  currency: string;
  /** Workspace currency per USD. */
  rate: number;
  /** Today (UTC), the last of `rows`. */
  today: string;
  /** The scope's daily totals, oldest first, ending today (at least 57 days for every rule). */
  rows: DayRow[];
  /** Per-app daily rows of the last weeks (any order). */
  appDays: AppDay[];
  appNames: Map<string, string>;
  /** Today per app, already in the workspace currency. */
  todayApps: TodayApp[];
  goals: GoalProgress[];
  /** The overview is filtered to some apps (workspace-wide goals do not apply). */
  filtered: boolean;
}

export const MAX_INSIGHTS = 5;

// Minimum samples / effects (USD for money).
const TOP_APP_MIN_TODAY_USD = 10;
const TOP_APP_MIN_SHARE = 0.4;
const WEEK_MIN_REVENUE_USD = 50;
const WEEK_MIN_CHANGE = 0.15;
const TRIALS_MIN = 30;
const CONVERSION_MIN_POINTS = 0.03;
const CONVERSION_MIN_CHANGE = 0.1;
const REFUNDS_MIN = 3;
const REFUNDS_MIN_RATIO = 2;
const MRR_MIN_USD = 50;
const MRR_MIN_DELTA_USD = 10;
const MRR_MIN_CHANGE = 0.1;
const CHURN_MIN_SUBS = 100;
const CHURN_MIN_CHANGE = 0.25;
const CHURN_MIN_POINTS = 0.005;
const NEW_CUSTOMERS_MIN = 20;
const NEW_CUSTOMERS_MIN_CHANGE = 0.2;
const PACE_MIN_DAY = 4;
const PACE_MIN_LAST_MONTH_USD = 50;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function buildInsights(input: InsightInput): Insight[] {
  const { rows, rate, currency } = input;
  const out: Insight[] = [];
  if (rows.length < 15) return out;
  const money = (usd: number) => compactMoney(usd * rate, currency);
  const pct = (f: number) => `${Math.round(f * 100)}%`;
  const signed = (f: number) => `${f >= 0 ? "+" : "−"}${Math.round(Math.abs(f) * 100)}%`;
  const sum = (rs: DayRow[], c: keyof DayRow) => rs.reduce((s, r) => s + (r[c] as number), 0);
  // Complete days: today is still running.
  const c7 = rows.slice(-8, -1);
  const p7 = rows.slice(-15, -8);
  const chart = (metric: Metric): Insight["link"] => ({ type: "chart", metric });
  const push = (i: Omit<Insight, "score" | "appId" | "appName"> & { score: number; appId?: string | null; appName?: string | null }) =>
    out.push({ appId: null, appName: null, ...i, score: Math.round(Math.max(0, Math.min(100, i.score))) });

  // 1. One app carries today.
  {
    const paying = input.todayApps.filter((a) => a.revenue > 0);
    const total = paying.reduce((s, a) => s + a.revenue, 0);
    const top = paying[0];
    if (top && paying.length >= 2 && total / rate >= TOP_APP_MIN_TODAY_USD) {
      const share = top.revenue / total;
      if (share >= TOP_APP_MIN_SHARE) {
        push({
          id: `today_top_app:${top.appId}`,
          kind: "today_top_app",
          tone: "neutral",
          score: 30 + share * 30,
          text: `${pct(share)} of today's revenue came from ${top.name} (${compactMoney(top.revenue, currency)}).`,
          values: { share, revenue: top.revenue, total },
          appId: top.appId,
          appName: top.name,
          link: { type: "app", appId: top.appId },
        });
      }
    }
  }

  // 2. Month-end pace: the month so far plus the last 14 complete days' average for the days left (today included).
  {
    const month = input.today.slice(0, 7);
    const dom = Number(input.today.slice(8, 10));
    const dim = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
    const recent = rows.slice(-15, -1);
    if (dom >= PACE_MIN_DAY && recent.length) {
      const mtd = sum(rows.filter((r) => r.day.startsWith(month) && r.day < input.today), "gross_usd");
      const avg = sum(recent, "gross_usd") / recent.length;
      const projected = mtd + avg * (dim - dom + 1);
      const goal = input.filtered
        ? undefined
        : input.goals.find((g) => !g.archived && g.status === "active" && g.metric === "revenue" && g.period === "month" && (g.scope === "all" || !g.appIds.length));
      const goalRatio = goal && goal.target > 0 ? (projected * rate) / goal.target : null;
      // A reached goal says nothing new: compare with last month instead.
      if (goal && goalRatio != null && !goal.reachedAt) {
        const ratio = goalRatio;
        {
          push({
            id: `month_pace:${goal.id}`,
            kind: "month_pace",
            tone: ratio >= 1 ? "positive" : "negative",
            score: ratio >= 1 ? 45 : 65,
            text: `At this pace the month ends at ≈ ${money(projected)}, ${pct(ratio)} of the ${compactMoney(goal.target, currency)} goal.`,
            values: { projected: projected * rate, target: goal.target, ratio, goal: goal.label },
            link: { type: "goal", goalId: goal.id },
          });
        }
      } else {
        const prevMonth = addDays(`${month}-01`, -1).slice(0, 7);
        const prevRows = rows.filter((r) => r.day.startsWith(prevMonth));
        const last = sum(prevRows, "gross_usd");
        // The previous month must be complete in the rows.
        if (prevRows.length >= Number(addDays(`${month}-01`, -1).slice(8, 10)) && last >= PACE_MIN_LAST_MONTH_USD) {
          const change = (projected - last) / last;
          push({
            id: "month_pace",
            kind: "month_pace",
            tone: change >= 0.05 ? "positive" : change <= -0.05 ? "negative" : "neutral",
            score: 35 + Math.min(20, Math.abs(change) * 50),
            text: `At this pace the month ends at ≈ ${money(projected)}, ${signed(change)} vs ${MONTHS[Number(prevMonth.slice(5, 7)) - 1]} (${money(last)}).`,
            values: { projected: projected * rate, lastMonth: last * rate, change, month: prevMonth },
            link: chart("revenue"),
          });
        }
      }
    }
  }

  // 3. Revenue, last 7 complete days against the 7 before.
  {
    const cur = sum(c7, "gross_usd");
    const prev = sum(p7, "gross_usd");
    if (p7.length === 7 && prev >= WEEK_MIN_REVENUE_USD) {
      const change = (cur - prev) / prev;
      if (Math.abs(change) >= WEEK_MIN_CHANGE) {
        push({
          id: "revenue_week",
          kind: "revenue_week",
          tone: change > 0 ? "positive" : "negative",
          score: 35 + Math.min(25, Math.abs(change) * 60),
          text: `Revenue over the last 7 days: ${money(cur)}, ${signed(change)} vs the week before.`,
          values: { current: cur * rate, previous: prev * rate, change },
          link: chart("revenue"),
        });
      }
    }
  }

  // 4. Trial → paid conversion, this week against last week.
  {
    const t1 = sum(c7, "trials_started");
    const t0 = sum(p7, "trials_started");
    if (t1 >= TRIALS_MIN && t0 >= TRIALS_MIN) {
      const cur = sum(c7, "trial_conversions") / t1;
      const prev = sum(p7, "trial_conversions") / t0;
      const diff = cur - prev;
      if (prev > 0 && Math.abs(diff) >= CONVERSION_MIN_POINTS && Math.abs(diff) / prev >= CONVERSION_MIN_CHANGE) {
        push({
          id: "trial_conversion_week",
          kind: "trial_conversion_week",
          tone: diff > 0 ? "positive" : "negative",
          score: 50 + Math.min(25, (Math.abs(diff) / prev) * 60),
          text: `Trial → paid conversion this week: ${pct(cur)}, ${pct(prev)} the week before.`,
          values: { current: cur, previous: prev, trials: t1 },
          link: chart("trial_conversion_rate"),
        });
      }
    }
  }

  // Per-app series, by day.
  const byApp = new Map<string, Map<string, AppDay>>();
  for (const d of input.appDays) {
    let m = byApp.get(d.app_id);
    if (!m) byApp.set(d.app_id, (m = new Map()));
    m.set(d.day, d);
  }
  const days = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => addDays(input.today, from + i));
  const last3 = days(-2, 0);
  const base28 = days(-30, -3);

  // 5. Refunds of an app: last 3 days (today included) against its usual daily rate (the 28 days before).
  {
    let worst: { appId: string; n: number; ratio: number | null } | null = null;
    for (const [appId, m] of byApp) {
      const n = last3.reduce((s, d) => s + (m.get(d)?.refunds ?? 0), 0);
      if (n < REFUNDS_MIN) continue;
      const expected = (base28.reduce((s, d) => s + (m.get(d)?.refunds ?? 0), 0) / base28.length) * 3;
      const ratio = expected > 0 ? n / expected : null;
      if (ratio != null ? ratio < REFUNDS_MIN_RATIO : n < REFUNDS_MIN + 1) continue;
      const key = ratio ?? n;
      if (!worst || key > (worst.ratio ?? worst.n)) worst = { appId, n, ratio };
    }
    if (worst) {
      const name = input.appNames.get(worst.appId) ?? "An app";
      push({
        id: `refund_spike:${worst.appId}`,
        kind: "refund_spike",
        tone: "negative",
        score: 60 + Math.min(20, (worst.ratio ?? 4) * 3),
        text:
          worst.ratio != null
            ? `${name}: ${worst.n} refunds in 3 days, ${worst.ratio.toFixed(1)}× its usual rate.`
            : `${name}: ${worst.n} refunds in 3 days, none in the 4 weeks before.`,
        values: { refunds: worst.n, ratio: worst.ratio },
        appId: worst.appId,
        appName: name,
        link: { type: "app", appId: worst.appId },
      });
    }
  }

  // 6. An app's MRR over 7 days: the biggest rise and the biggest fall.
  {
    const weekAgo = addDays(input.today, -7);
    const moves: { appId: string; now: number; change: number }[] = [];
    for (const [appId, m] of byApp) {
      const now = m.get(input.today)?.mrr_usd ?? 0;
      const before = m.get(weekAgo)?.mrr_usd ?? 0;
      if (before < MRR_MIN_USD || Math.abs(now - before) < MRR_MIN_DELTA_USD) continue;
      const change = (now - before) / before;
      if (Math.abs(change) >= MRR_MIN_CHANGE) moves.push({ appId, now, change });
    }
    const up = moves.filter((x) => x.change > 0).sort((a, b) => b.change - a.change)[0];
    const down = moves.filter((x) => x.change < 0).sort((a, b) => a.change - b.change)[0];
    for (const x of [up, down]) {
      if (!x) continue;
      const name = input.appNames.get(x.appId) ?? "An app";
      push({
        id: `app_mrr_change:${x.appId}`,
        kind: "app_mrr_change",
        tone: x.change > 0 ? "positive" : "negative",
        score: 40 + Math.min(25, Math.abs(x.change) * 80),
        text: `${name} MRR ${signed(x.change)} in 7 days (now ${money(x.now)}).`,
        values: { mrr: x.now * rate, change: x.change },
        appId: x.appId,
        appName: name,
        link: { type: "app", appId: x.appId },
      });
    }
  }

  // 7. Churn over 28 days against the 28 before.
  if (rows.length >= 57) {
    const cur = rows.slice(-28);
    const prev = rows.slice(-56, -28);
    const baseCur = rows[rows.length - 29].active_subscriptions;
    const basePrev = rows[rows.length - 57].active_subscriptions;
    if (baseCur >= CHURN_MIN_SUBS && basePrev >= CHURN_MIN_SUBS) {
      const c = sum(cur, "churned_subscriptions") / baseCur;
      const p = sum(prev, "churned_subscriptions") / basePrev;
      if (p > 0 && Math.abs(c - p) >= CHURN_MIN_POINTS && Math.abs(c - p) / p >= CHURN_MIN_CHANGE) {
        push({
          id: "churn_change",
          kind: "churn_change",
          tone: c > p ? "negative" : "positive",
          score: c > p ? 55 : 35,
          text: `Churn over 28 days: ${(c * 100).toFixed(1)}%, ${c > p ? "up" : "down"} from ${(p * 100).toFixed(1)}%.`,
          values: { current: c, previous: p },
          link: chart("churn_rate"),
        });
      }
    }
  }

  // 8. New customers, this week against last week.
  {
    const cur = sum(c7, "new_customers");
    const prev = sum(p7, "new_customers");
    if (prev >= NEW_CUSTOMERS_MIN) {
      const change = (cur - prev) / prev;
      if (Math.abs(change) >= NEW_CUSTOMERS_MIN_CHANGE) {
        push({
          id: "new_customers_week",
          kind: "new_customers_week",
          tone: change > 0 ? "positive" : "negative",
          score: 30 + Math.min(20, Math.abs(change) * 40),
          text: `${cur} new customers in the last 7 days, ${signed(change)} vs the week before.`,
          values: { current: cur, previous: prev, change },
          link: chart("new_customers"),
        });
      }
    }
  }

  return out.sort((a, b) => b.score - a.score).slice(0, MAX_INSIGHTS);
}

/** "$9.3K", "$132.52": compact above 10,000. */
export function compactMoney(amount: number, currency: string): string {
  try {
    const big = Math.abs(amount) >= 10_000;
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      ...(big ? { notation: "compact", maximumFractionDigits: 1 } : { maximumFractionDigits: Math.abs(amount) >= 1000 ? 0 : 2 }),
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
