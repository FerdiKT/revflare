import { list, str } from "../args.js";
import type { Command } from "../context.js";
import { UsageError } from "../errors.js";
import { bar, c, fmtDate, fmtMoney, fmtNum, fmtPct, fmtRelative, fmtStatus, println, printJson, table, truncate } from "../format.js";
import { resolveApps } from "../resolve.js";
import type { Alert, Goal, GoalInput, GoalMetric, GoalPace, GoalPeriod, GoalProgress, Job } from "../types.js";

// Alerts ------------------------------------------------------------------------------------------------------------

export const alerts: Command = {
  name: "alerts",
  summary: "Recent alerts (notifications stopped, sync failing, refund spikes, revenue drops, app events stopped, funnel drops, release regressions); open ones by default.",
  options: { all: { type: "boolean", description: "Include resolved alerts" } },
  max: 0,
  async run(ctx, { values }) {
    const { items } = await ctx.api.get<{ items: Alert[] }>("/alerts");
    const shown = values.all ? items : items.filter((a) => !a.resolvedAt);
    if (ctx.json) return printJson({ items: shown });
    if (!shown.length) return println(c.green("No open alerts."));
    println(
      table(
        [{ header: "ID" }, { header: "SEVERITY" }, { header: "TITLE", flex: true }, { header: "DETAILS", flex: true }, { header: "CREATED" }, { header: "RESOLVED" }],
        shown.map((a) => [a.id, fmtStatus(a.severity), a.title, truncate(a.body, 80), fmtDate(a.createdAt), a.resolvedAt ? fmtDate(a.resolvedAt) : ""]),
      ),
    );
  },
};

export const alertsResolve: Command = {
  name: "alerts resolve",
  args: "<id...>",
  summary: "Mark alerts as resolved.",
  min: 1,
  async run(ctx, { positionals }) {
    for (const id of positionals) await ctx.api.post(`/alerts/${encodeURIComponent(id)}/resolve`);
    if (ctx.json) return printJson({ resolved: positionals });
    println(`${c.green("✓")} Resolved ${positionals.join(", ")}`);
  },
};

// Goals -------------------------------------------------------------------------------------------------------------

const GOAL_METRIC_LABELS: Record<GoalMetric, string> = {
  revenue: "Revenue",
  proceeds: "Proceeds",
  mrr: "MRR",
  new_subscriptions: "New subscriptions",
  trials_started: "Trials started",
  active_subscriptions: "Active subscriptions",
  sales: "Sales",
};
const GOAL_METRIC_LIST = Object.keys(GOAL_METRIC_LABELS) as GoalMetric[];
const GOAL_PERIOD_LIST: GoalPeriod[] = ["week", "month", "quarter", "year", "custom"];
const PACE_COLORS: Record<GoalPace, (s: string) => string> = { reached: c.green, on_track: c.green, behind: c.yellow, missed: c.red, upcoming: c.gray };

/** "All apps", "Photo Lab", "3 apps", "All apps except Photo Lab", "No apps" (its apps were deleted). */
export function goalScopeLabel(g: Pick<Goal, "scope" | "appIds">, names: Map<string, string>): string {
  const name = (id: string) => names.get(id) ?? id;
  if (g.scope === "include" && !g.appIds.length) return "No apps";
  if (g.scope === "all" || !g.appIds.length) return "All apps";
  if (g.scope === "include") return g.appIds.length === 1 ? name(g.appIds[0]) : `${g.appIds.length} apps`;
  return g.appIds.length === 1 ? `All apps except ${name(g.appIds[0])}` : `All apps except ${g.appIds.length}`;
}

/** "Oct 2026", "2026-Q4", "week 2026-W44", "2026-11-15 → 2026-12-31". */
export function goalPeriodText(g: Pick<GoalProgress, "period" | "periodLabel" | "periodStart" | "periodEnd">): string {
  if (g.period === "custom") return `${g.periodStart} → ${g.periodEnd}`;
  if (g.period === "week") return `week ${g.periodLabel}`;
  return g.periodLabel;
}

function goalValue(g: Pick<Goal, "format">, v: number | null | undefined, currency: string) {
  return g.format === "money" ? fmtMoney(v, currency) : fmtNum(v === null || v === undefined ? v : Math.round(v));
}

/** --name/--metric/--target/--period/--from/--to/--apps/--exclude-apps/--all-apps/--notify/--no-notify → a goal body. */
async function goalBody(ctx: Parameters<Command["run"]>[0], values: Record<string, string | boolean | string[] | undefined>, editing: string | null): Promise<GoalInput> {
  const creating = editing === null;
  const body: GoalInput = {};
  const name = str(values.name);
  if (name !== undefined) {
    if (name.trim().length > 60) throw new UsageError("--name is limited to 60 characters");
    body.name = name.trim() || null;
  }
  const metric = str(values.metric) ?? (creating ? "revenue" : undefined);
  if (metric !== undefined) {
    if (!GOAL_METRIC_LIST.includes(metric as GoalMetric)) throw new UsageError(`--metric must be one of ${GOAL_METRIC_LIST.join(", ")}`);
    body.metric = metric as GoalMetric;
  }
  const target = str(values.target);
  if (target !== undefined || creating) {
    const t = Number(target);
    if (!(t > 0)) throw new UsageError("--target must be a positive number");
    body.target = t;
  }
  const from = str(values.from);
  const to = str(values.to);
  let period = str(values.period);
  if ((from || to) && !period) period = "custom";
  if (period !== undefined) {
    if (!GOAL_PERIOD_LIST.includes(period as GoalPeriod)) throw new UsageError(`--period must be one of ${GOAL_PERIOD_LIST.join(", ")}`);
    body.period = period as GoalPeriod;
  }
  if (body.period === "custom" || from || to) {
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if (from !== undefined) {
      if (!day.test(from)) throw new UsageError("--from must be YYYY-MM-DD");
      body.startDate = from;
    }
    if (to !== undefined) {
      if (!day.test(to)) throw new UsageError("--to must be YYYY-MM-DD");
      body.endDate = to;
    }
    if (creating && (!from || !to)) throw new UsageError("a custom period needs --from and --to");
    if (!creating && (!from || !to)) {
      // One date alone only moves a custom period: a rolling goal needs both to become custom.
      const current = await ctx.api.get<{ goal: GoalProgress }>(`/goals/${encodeURIComponent(editing)}`);
      if (current.goal.period !== "custom") throw new UsageError(`goal ${editing} has a ${current.goal.period} period: give both --from and --to to make it a custom period`, "goals edit");
    }
    if (from && to && to < from) throw new UsageError("--to must not be before --from");
  }
  const include = list(values.apps);
  const exclude = list(values["exclude-apps"]);
  if (include.length && exclude.length) throw new UsageError("use either --apps or --exclude-apps");
  if ((include.length || exclude.length) && values["all-apps"]) throw new UsageError("--all-apps cannot be combined with --apps / --exclude-apps");
  if (include.length || exclude.length) {
    const apps = resolveApps(include.length ? include : exclude, (await ctx.apps()).items);
    body.scope = include.length ? "include" : "exclude";
    body.appIds = apps.map((a) => a.id);
  } else if (values["all-apps"]) body.scope = "all";
  if (values.notify && values["no-notify"]) throw new UsageError("use either --notify or --no-notify");
  if (values.notify) body.notify = true;
  if (values["no-notify"]) body.notify = false;
  // New goals notify unless --no-notify (like the web and iOS apps).
  if (creating && body.notify === undefined) body.notify = true;
  return body;
}

const GOAL_OPTIONS = {
  name: { type: "string", short: "n", arg: "<text>", description: "Name (≤ 60 characters; empty clears it)" },
  metric: { type: "string", short: "m", arg: "<metric>", description: `${GOAL_METRIC_LIST.join(", ")} (default revenue)` },
  target: { type: "string", short: "t", arg: "<number>", description: "Target: an amount in the workspace currency (revenue, proceeds, mrr) or a count" },
  period: { type: "string", short: "p", arg: "<period>", description: "week (Mon–Sun), month (default), quarter, year or custom" },
  from: { type: "string", arg: "<YYYY-MM-DD>", description: "Custom period: first day (implies --period custom)" },
  to: { type: "string", arg: "<YYYY-MM-DD>", description: "Custom period: last day, inclusive" },
  apps: { type: "string", short: "a", multiple: true, arg: "<id|bundle,...>", description: "Only these apps (combined target)" },
  "exclude-apps": { type: "string", multiple: true, arg: "<id|bundle,...>", description: "All apps except these (apps added later count)" },
  "all-apps": { type: "boolean", description: "All apps (the default when adding)" },
  notify: { type: "boolean", description: "Push to the iOS app when the goal is reached, once per period (the default when adding)" },
  "no-notify": { type: "boolean", description: "No push when reached" },
} as const;

export const goals: Command = {
  name: "goals",
  summary: "Goals with progress: metric, period, apps, current / target, pace, days left (archived with --all).",
  options: { all: { type: "boolean", description: "Include archived goals" } },
  max: 0,
  examples: ["revflare goals", "revflare goals --all --json"],
  async run(ctx, { values }) {
    const r = await ctx.api.get<{ currency: string; items: GoalProgress[] }>("/goals");
    const shown = values.all ? r.items : r.items.filter((g) => !g.archived);
    if (ctx.json) return printJson({ ...r, items: shown });
    if (!shown.length) return println(c.gray("No goals. Add one: revflare goals add --name \"Q4\" --metric revenue --period quarter --target 15000"));
    const names = new Map((await ctx.apps()).items.map((a) => [a.id, a.name]));
    const v = (g: GoalProgress, n: number | null | undefined) => goalValue(g, n, r.currency);
    println(
      table(
        [
          { header: "ID" },
          { header: "GOAL", flex: true },
          { header: "APPS" },
          { header: "PERIOD" },
          { header: "CURRENT", align: "right" },
          { header: "TARGET", align: "right" },
          { header: "PROGRESS" },
          { header: "PACE" },
          { header: "LEFT", align: "right" },
        ],
        shown.map((g) => [
          g.id,
          `${g.name ?? GOAL_METRIC_LABELS[g.metric] ?? g.metric}${g.name ? c.gray(` ${GOAL_METRIC_LABELS[g.metric] ?? g.metric}`) : ""}${g.archived ? c.gray(" (archived)") : ""}`,
          goalScopeLabel(g, names),
          goalPeriodText(g),
          v(g, g.current),
          v(g, g.target),
          `${bar(Math.min(1, g.progress), 10)} ${fmtPct(g.progress, 0)}`,
          (PACE_COLORS[g.pace] ?? ((x: string) => x))(g.pace.replace("_", " ")),
          g.status === "active" ? `${g.daysLeft}d` : g.status === "upcoming" ? c.gray("not started") : c.gray("ended"),
        ]),
      ),
    );
  },
};

export const goalsList: Command = { ...goals, name: "goals list", hidden: true };

export const goalsShow: Command = {
  name: "goals show",
  args: "<id>",
  summary: "One goal in detail: expected by now, ahead / behind, needed per day, projected, previous period.",
  min: 1,
  max: 1,
  async run(ctx, { positionals }) {
    const r = await ctx.api.get<{ currency: string; goal: GoalProgress }>(`/goals/${encodeURIComponent(positionals[0])}`);
    if (ctx.json) return printJson(r);
    const g = r.goal;
    const names = new Map((await ctx.apps()).items.map((a) => [a.id, a.name]));
    const v = (n: number | null | undefined) => goalValue(g, n, r.currency);
    const lines: [string, string][] = [
      ["Goal", `${g.label}${g.archived ? c.gray(" (archived)") : ""}`],
      ["Metric", `${GOAL_METRIC_LABELS[g.metric] ?? g.metric}${g.kind === "stock" ? c.gray(" (level)") : ""}`],
      ["Apps", `${goalScopeLabel(g, names)}${g.scope !== "all" ? c.gray(` [${g.scope}: ${g.appIds.map((id) => names.get(id) ?? id).join(", ")}]`) : ""}`],
      ["Period", `${g.period} ${goalPeriodText(g)} ${c.gray(`(${g.status}, day ${g.daysElapsed} of ${g.daysTotal}, ${g.daysLeft} left)`)}`],
      ["Progress", `${bar(Math.min(1, g.progress), 20)} ${fmtPct(g.progress, 0)}  ${v(g.current)} of ${v(g.target)}  ${(PACE_COLORS[g.pace] ?? ((x: string) => x))(g.pace.replace("_", " "))}`],
      ["Expected by now", `${v(g.expected)} ${g.delta >= 0 ? c.green(`(${v(g.delta)} ahead)`) : c.red(`(${v(-g.delta)} behind)`)}`],
      ["Projected", v(g.projected)],
      ["Needed per day", g.requiredPerDay === null ? "-" : v(g.requiredPerDay)],
    ];
    if (g.startValue !== null) lines.push(["Start of period", `${v(g.startValue)} ${c.gray(`(change ${g.current - g.startValue >= 0 ? "+" : ""}${v(g.current - g.startValue)})`)}`]);
    if (g.reachedAt) lines.push(["Reached", g.reachedAt]);
    if (g.previous) lines.push(["Previous period", `${g.previous.periodLabel}: ${v(g.previous.value)} ${g.previous.reached ? c.green("hit") : c.red("missed")}`]);
    lines.push(["Notify", g.notify ? "on" : "off"]);
    const w = Math.max(...lines.map((l) => l[0].length));
    for (const [k, val] of lines) println(`${c.bold(k.padEnd(w))}  ${val}`);
  },
};

export const goalsAdd: Command = {
  name: "goals add",
  summary: "Add a goal: metric, target, period (week, month, quarter, year or custom dates), apps (all, some, all but some).",
  options: GOAL_OPTIONS,
  max: 0,
  examples: [
    "revflare goals add --metric mrr --target 10000",
    'revflare goals add --name "Q4 push" --period quarter --target 15000 --apps com.example.one,com.example.two --notify',
    'revflare goals add --name "Not the game" --metric active_subscriptions --target 900 --exclude-apps com.example.game',
    'revflare goals add --name "Holiday sale" --metric sales --target 2500 --from 2026-11-15 --to 2026-12-31',
  ],
  async run(ctx, { values }) {
    const body = await goalBody(ctx, values, null);
    const r = await ctx.api.post<{ id: string; currency: string; goal: GoalProgress | null }>("/goals", body);
    if (ctx.json) return printJson(r);
    println(`${c.green("✓")} Goal ${r.id} added${r.goal ? `: ${r.goal.label}, ${fmtPct(r.goal.progress, 0)} of ${goalValue(r.goal, r.goal.target, r.currency)}` : ""}`);
  },
};

export const goalsEdit: Command = {
  name: "goals edit",
  args: "<id>",
  summary: "Change a goal (only the options given).",
  options: GOAL_OPTIONS,
  min: 1,
  max: 1,
  examples: ['revflare goals edit goal_x --name "Q4" --target 20000', "revflare goals edit goal_x --all-apps --no-notify"],
  async run(ctx, { values, positionals }) {
    const body = await goalBody(ctx, values, positionals[0]);
    if (!Object.keys(body).length) throw new UsageError("nothing to change: give --name, --metric, --target, --period, --from/--to, --apps, --exclude-apps, --all-apps or --notify/--no-notify", "goals edit");
    const r = await ctx.api.patch<{ id: string; currency: string; goal: GoalProgress | null }>(`/goals/${encodeURIComponent(positionals[0])}`, body);
    if (ctx.json) return printJson(r);
    println(`${c.green("✓")} Goal ${r.id} updated${r.goal ? `: ${r.goal.label}` : ""}`);
  },
};

export const goalsArchive: Command = {
  name: "goals archive",
  args: "<id...>",
  summary: "Archive goals (hidden, kept); --undo brings them back.",
  options: { undo: { type: "boolean", description: "Unarchive" } },
  min: 1,
  async run(ctx, { values, positionals }) {
    for (const id of positionals) await ctx.api.patch(`/goals/${encodeURIComponent(id)}`, { archived: !values.undo });
    if (ctx.json) return printJson({ [values.undo ? "unarchived" : "archived"]: positionals });
    println(`${c.green("✓")} ${values.undo ? "Unarchived" : "Archived"} ${positionals.join(", ")}`);
  },
};

export const goalsReorder: Command = {
  name: "goals reorder",
  args: "<id...>",
  summary: "Put goals in this order (the others follow).",
  min: 1,
  async run(ctx, { positionals }) {
    const r = await ctx.api.post<{ ids: string[] }>("/goals/reorder", { ids: positionals });
    if (ctx.json) return printJson(r);
    println(`${c.green("✓")} Order: ${r.ids.join(", ")}`);
  },
};

export const goalsRemove: Command = {
  name: "goals rm",
  args: "<id...>",
  summary: "Delete goals.",
  min: 1,
  async run(ctx, { positionals }) {
    for (const id of positionals) await ctx.api.delete(`/goals/${encodeURIComponent(id)}`);
    if (ctx.json) return printJson({ removed: positionals });
    println(`${c.green("✓")} Removed ${positionals.join(", ")}`);
  },
};

export const goalsRemoveAlias: Command = { ...goalsRemove, name: "goals remove", hidden: true };

// Jobs --------------------------------------------------------------------------------------------------------------

function progressText(p: Record<string, unknown>): string {
  return Object.entries(p)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

export const jobs: Command = {
  name: "jobs",
  summary: "Import jobs (Apple backfill, RevenueCat discovery, sales reports, FX) with status and progress.",
  max: 0,
  async run(ctx) {
    const { items } = await ctx.api.get<{ items: Job[] }>("/jobs");
    if (ctx.json) return printJson({ items });
    if (!items.length) return println(c.gray("No jobs."));
    println(
      table(
        [{ header: "ID" }, { header: "KIND" }, { header: "STATUS" }, { header: "PROGRESS", flex: true }, { header: "UPDATED" }, { header: "ERROR", flex: true }],
        items.map((j) => [j.id, j.kind, fmtStatus(j.status), progressText(j.progress), fmtRelative(j.updatedAt), j.error ? c.red(j.error) : ""]),
      ),
    );
  },
};

export const jobsShow: Command = {
  name: "jobs show",
  args: "<id>",
  summary: "One job with its parameters and progress.",
  min: 1,
  max: 1,
  async run(ctx, { positionals }) {
    const j = await ctx.api.get<Job>(`/jobs/${encodeURIComponent(positionals[0])}`);
    if (ctx.json) return printJson(j);
    println(`${c.bold(j.id)}  ${j.kind}  ${fmtStatus(j.status)}`);
    println(`${c.gray("Created".padEnd(10))}${fmtDate(j.createdAt)}`);
    println(`${c.gray("Updated".padEnd(10))}${fmtDate(j.updatedAt)}`);
    if (j.finishedAt) println(`${c.gray("Finished".padEnd(10))}${fmtDate(j.finishedAt)}`);
    println(`${c.gray("Params".padEnd(10))}${JSON.stringify(j.params)}`);
    println(`${c.gray("Progress".padEnd(10))}${JSON.stringify(j.progress)}`);
    if (j.error) println(`${c.gray("Error".padEnd(10))}${c.red(j.error)}`);
  },
};

export const jobsCancel: Command = {
  name: "jobs cancel",
  args: "<id>",
  summary: "Cancel a queued or running job.",
  min: 1,
  max: 1,
  async run(ctx, { positionals }) {
    await ctx.api.post(`/jobs/${encodeURIComponent(positionals[0])}/cancel`);
    if (ctx.json) return printJson({ cancelled: positionals[0] });
    println(`${c.green("✓")} Cancelled ${positionals[0]}`);
  },
};
