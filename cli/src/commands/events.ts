import { list, str } from "../args.js";
import type { Command, Ctx } from "../context.js";
import { CliError, UsageError } from "../errors.js";
import { bar, c, fmtDate, fmtNum, fmtPct, printJson, println, sparkline, table } from "../format.js";
import { resolveApp } from "../resolve.js";
import { FUNNEL_ALERT_SENSITIVITIES, FUNNEL_BREAKDOWNS, KEY_EVENT_PATTERN_RE, type EventSummary, type KeyEventSettings, type Funnel, type FunnelAlertSensitivity, type FunnelInput, type FunnelReport, type FunnelReportStep, type FunnelStep } from "../types.js";

const REVENUE_KINDS = ["trial_started", "paid", "any_purchase"] as const;

/** "event:onboarding_step:step=1,variant=b", "event:paywall_view", "revenue:trial_started" → a funnel step. */
export function parseStepSpec(spec: string): FunnelStep {
  const [type, ...rest] = spec.split(":");
  if (type === "revenue") {
    const kind = rest.join(":");
    if (!(REVENUE_KINDS as readonly string[]).includes(kind)) throw new UsageError(`--step ${spec}: revenue steps are revenue:${REVENUE_KINDS.join(" | revenue:")}`);
    return { type: "revenue", kind: kind as (typeof REVENUE_KINDS)[number] };
  }
  if (type !== "event" || !rest.length) throw new UsageError(`--step ${spec}: use event:<name>[:key=value,...] or revenue:<trial_started|paid|any_purchase>`);
  // Event names may contain ":": the last segment is the filter list when it has "=".
  const last = rest[rest.length - 1];
  const hasFilters = rest.length > 1 && last.includes("=");
  const name = (hasFilters ? rest.slice(0, -1) : rest).join(":");
  if (!name) throw new UsageError(`--step ${spec}: the event name is missing`);
  if (!hasFilters) return { type: "event", name };
  const filters = last.split(",").map((pair) => {
    const i = pair.indexOf("=");
    if (i <= 0) throw new UsageError(`--step ${spec}: filters are key=value, separated by commas`);
    return { key: pair.slice(0, i), value: pair.slice(i + 1) };
  });
  return { type: "event", name, filters };
}

/** "3600" → "1h", for display. */
export function fmtSeconds(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return "-";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${+(s / 3600).toFixed(1)}h`;
  return `${+(s / 86_400).toFixed(1)}d`;
}

const stepText = (s: FunnelStep) =>
  s.type === "revenue" ? `revenue:${s.kind}` : `${s.name}${s.filters?.length ? ` ${c.gray(`(${s.filters.map((f) => `${f.key}=${f.value}`).join(", ")})`)}` : ""}`;

function notConfiguredHint(err: unknown): never {
  const body = (err as { body?: { code?: string } })?.body;
  if (body?.code === "analytics_not_configured")
    throw new CliError(`${(err as Error).message}\nSee the README (Events and funnels): EVENTS binding, CF_ACCOUNT_ID var, wrangler secret put CF_ANALYTICS_TOKEN.`);
  throw err;
}

/** A cap whose full day would write more than half the instance's daily background budget. */
function capWarning(r: KeyEventSettings): string {
  if (!r.backgroundWritesPerDay || !r.writesPerEvent) return "";
  const writes = r.dailyCap * r.writesPerEvent;
  return writes > r.backgroundWritesPerDay / 2
    ? `  ${c.yellow(`~${fmtNum(writes)} rows written on a full day: over half the daily background budget (${fmtNum(r.backgroundWritesPerDay)})`)}`
    : "";
}

async function keyEvents(ctx: Ctx, appId: string, appName: string, values: Record<string, unknown>) {
  const path = `/apps/${encodeURIComponent(appId)}/key-events`;
  let r = await ctx.api.get<KeyEventSettings>(path);
  const add = list(values.add as string[] | string | undefined);
  const rm = list(values.rm as string[] | string | undefined).map((x) => x.toLowerCase());
  const body: { patterns?: string[]; dailyCap?: number | null; retentionDays?: number } = {};
  for (const p of add) if (!KEY_EVENT_PATTERN_RE.test(p)) throw new UsageError(`--add ${p}: an event name, optionally with one * at the start or the end`);
  if (add.length || rm.length) body.patterns = [...r.patterns.filter((p) => !rm.includes(p.toLowerCase())), ...add.filter((p) => !r.patterns.some((x) => x.toLowerCase() === p.toLowerCase()))];
  for (const [opt, key] of [
    ["daily-cap", "dailyCap"],
    ["retention", "retentionDays"],
  ] as const) {
    const v = str(values[opt] as string | undefined);
    if (v === undefined) continue;
    if (key === "dailyCap" && v === "default") {
      body.dailyCap = null;
      continue;
    }
    if (!/^\d+$/.test(v)) throw new UsageError(`--${opt} must be a whole number${key === "dailyCap" ? ' (or "default")' : ""}`);
    body[key] = Number(v);
  }
  if (Object.keys(body).length) r = await ctx.api.put<KeyEventSettings>(path, body);
  if (ctx.json) return printJson(r);
  println(`${c.bold("Key events")}  ${appName}  ${c.gray("stored exactly besides Analytics Engine")}`);
  const rows: Array<[string, string]> = [
    ["Built in", r.builtin.join(", ")],
    ["Extra patterns", r.patterns.length ? r.patterns.join(", ") : c.gray(`none (up to ${r.limits.patterns})`)],
    ["Daily cap", r.dailyCap ? `${fmtNum(r.dailyCap)} a day${r.dailyCapIsDefault ? c.gray(" (default)") : ""}${capWarning(r)}` : c.yellow("0: none stored")],
    ["Retention", `${r.retentionDays} days`],
    ["Exact since", r.since ?? c.gray("not yet")],
    ["Today", `${fmtNum(r.today.count)} stored${r.today.capped ? `  ${c.yellow("incomplete: the rest of today is sampled")}` : ""}`],
  ];
  for (const [k, v] of rows) println(`${c.gray(k.padEnd(16))}${v}`);
}

export const events: Command = {
  name: "events",
  args: "<app> [key-events]",
  summary: "App events from RevflareKit (Revflare.track): top events, unique installs, per-day counts; key-event settings.",
  description:
    "Events are stored in Cloudflare Workers Analytics Engine (sampled when an app sends a lot; counts are weighted).\n" +
    "Key events (first_open, purchase_*, restore_*, paywall_view, paywall_close, onboarding_*, experiment_exposure and the\n" +
    "app's extra patterns) are also stored exactly: their counts and installs are exact (SOURCE exact); the\n" +
    "others are sampled. Both are counted by UTC day of reception. Days are UTC days. Needs CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN on the server.\n" +
    "Production data from other devices than the app's test devices (revflare apps <app> test-devices) unless --include-test.\n" +
    "  <app> key-events       key-event settings: patterns, daily cap, retention, exact since, today's count\n" +
    "                         (change with --add / --rm / --daily-cap / --retention, needs manage)",
  options: {
    range: { type: "string", arg: "<Nd>", description: "Last N days, 1d to 92d (default 7d)" },
    "include-test": { type: "boolean", description: "Count test data too (sandbox / Xcode builds, test devices)" },
    add: { type: "string", multiple: true, arg: "<pattern>", description: "key-events: add an extra pattern (name, *suffix or prefix*)" },
    rm: { type: "string", multiple: true, arg: "<pattern>", description: "key-events: remove an extra pattern" },
    "daily-cap": { type: "string", arg: "<n>", description: "key-events: key events stored per day at most (0 = none, default = the instance's default)" },
    retention: { type: "string", arg: "<days>", description: "key-events: days stored key events are kept (7 to 365)" },
  },
  min: 1,
  max: 2,
  examples: [
    "revflare events com.example.app",
    "revflare events com.example.app --range 30d --json",
    "revflare events com.example.app key-events --add '*_paywall_view' --daily-cap 80000",
  ],
  async run(ctx, { positionals, values }) {
    const app = resolveApp(positionals[0], (await ctx.apps()).items);
    if (positionals[1] !== undefined) {
      if (positionals[1] !== "key-events") throw new UsageError(`Unknown action "${positionals[1]}": use key-events (or none for the summary)`);
      return keyEvents(ctx, app.id, app.name, values);
    }
    const q = new URLSearchParams({ range: str(values.range) ?? "7d" });
    if (values["include-test"]) q.set("includeTest", "true");
    const r = await ctx.api.get<EventSummary>(`/apps/${encodeURIComponent(app.id)}/events/summary?${q}`).catch(notConfiguredHint);
    if (ctx.json) return printJson(r);
    println(`${c.bold("Events")}  ${app.name}  ${c.gray(`${r.from} → ${r.to} (UTC)`)}${r.approximate ? `  ${c.yellow("sampled")}` : ""}${r.includeTest ? `  ${c.yellow("test data included")}` : ""}`);
    println(`${fmtNum(r.totalEvents)} events from ${fmtNum(r.uniqueInstalls)} installs  ${sparkline(r.daily.map((d) => d.count))}`);
    println("");
    if (!r.events.length) return println(c.gray("No events yet: send them with Revflare.track(...) in RevflareKit."));
    const top = Math.max(...r.events.map((e) => e.count), 1);
    println(
      table(
        [{ header: "EVENT" }, { header: "COUNT", align: "right" }, { header: "INSTALLS", align: "right" }, { header: "SOURCE" }, { header: "LAST SEEN" }, { header: "" }],
        r.events.map((e) => [e.name, fmtNum(e.count), fmtNum(e.installs), e.source === "exact" ? c.green("exact") : e.source === "sampled" ? "sampled" : "-", e.lastSeenAt ? fmtDate(e.lastSeenAt) : "-", bar(e.count / top, 16)]),
      ),
    );
    for (const n of r.notes ?? []) println(c.gray(n));
  },
};

const FUNNEL_ACTIONS = ["show", "create", "delete", "alerts"] as const;

const alertsText = (f: Funnel) => (!f.alerts ? "-" : f.alerts.enabled ? `on (${f.alerts.sensitivity})` : "off");

async function findFunnel(ctx: Ctx, appId: string, selector: string): Promise<Funnel> {
  const { items } = await ctx.api.get<{ items: Funnel[] }>(`/apps/${encodeURIComponent(appId)}/funnels`);
  const f = items.find((x) => x.id === selector) ?? items.filter((x) => x.name.toLowerCase() === selector.toLowerCase())[0];
  if (!f) throw new CliError(`No funnel "${selector}": ${items.map((x) => `${x.id} (${x.name})`).join(", ") || "the app has none"}`);
  return f;
}

function printReportSteps(steps: FunnelReportStep[]) {
  println(
    table(
      [
        { header: "#", align: "right" },
        { header: "STEP" },
        { header: "USERS", align: "right" },
        { header: "FROM PREV", align: "right" },
        { header: "FROM FIRST", align: "right" },
        { header: "DROP-OFF", align: "right" },
        { header: "MEDIAN TIME", align: "right" },
        { header: "" },
      ],
      steps.map((s) => [
        s.index + 1,
        s.label,
        fmtNum(s.users),
        s.index ? fmtPct(s.conversionFromPrevious, 1) : "",
        fmtPct(s.conversionFromFirst, 1),
        s.index ? fmtNum(s.dropOff) : "",
        s.index ? fmtSeconds(s.medianSecondsFromPrevious) : "",
        bar(s.conversionFromFirst, 20),
      ]),
    ),
  );
}

export const funnels: Command = {
  name: "funnels",
  args: "<app> [show <funnel>|create|delete <funnel>|alerts <funnel> [on|off]]",
  summary: "Funnels over app events and sales: list, report (where users drop off), create, delete.",
  description:
    "A funnel is 2 to 10 steps: events (with optional property filters) and revenue steps from Revflare's own sales\n" +
    "(trial_started, paid, any_purchase, linked to installs by RevflareKit). Users count at a step when they do it after\n" +
    "the previous one (ordered, default) and within the window of the first step. Actions:\n" +
    "  (none)               list funnels\n" +
    "  show <funnel>        report: users, conversion, drop-off, median time per step (--range/--from/--to, --breakdown,\n" +
    "                       --include-test to count sandbox / Xcode builds and test devices)\n" +
    "  create               new funnel (needs manage): --name, --step (repeat, in order), --window, --unordered\n" +
    "  delete <funnel>      delete a funnel (needs manage)\n" +
    "  alerts <funnel> [on|off] [--sensitivity high|normal|low]\n" +
    "                       daily funnel anomaly / release regression alerts: show, or change (needs manage)\n" +
    "Steps: event:<name>, event:<name>:<key>=<value>[,<key>=<value>], revenue:trial_started|paid|any_purchase.\n" +
    "Funnels can be given by id or name.",
  options: {
    range: { type: "string", arg: "<Nd>", description: "show: entry days, e.g. 7d, 30d (default), 90d" },
    from: { type: "string", arg: "<YYYY-MM-DD>", description: "show: first entry day (UTC)" },
    to: { type: "string", arg: "<YYYY-MM-DD>", description: "show: last entry day (UTC, default today)" },
    breakdown: { type: "string", arg: "<dim>", description: `show: split by ${FUNNEL_BREAKDOWNS.join(", ")}` },
    "include-test": { type: "boolean", description: "show: count test data too (sandbox / Xcode builds, test devices)" },
    name: { type: "string", arg: "<name>", description: "create: funnel name" },
    step: { type: "string", multiple: true, arg: "<spec>", description: "create: a step, in order (see above)" },
    window: { type: "string", arg: "<dur>", description: "create: conversion window, e.g. 1h, 1d, 7d (default), 30d" },
    unordered: { type: "boolean", description: "create: steps after the first may happen in any order" },
    sensitivity: { type: "string", arg: "<level>", description: "alerts: high (drops ≥ 15%), normal (≥ 20%, default), low (≥ 30%)" },
  },
  min: 1,
  max: 4,
  examples: [
    "revflare funnels com.example.app",
    "revflare funnels com.example.app show fn_abc123 --range 30d --breakdown app_version",
    "revflare funnels com.example.app create --name Onboarding --step event:onboarding_step:step=1 --step event:paywall_view --step revenue:trial_started --window 7d",
    "revflare funnels com.example.app delete Onboarding",
    "revflare funnels com.example.app alerts Onboarding on --sensitivity high",
  ],
  async run(ctx, { positionals, values }) {
    const [selector, action, target, toggle] = positionals as [string, (typeof FUNNEL_ACTIONS)[number] | undefined, string | undefined, string | undefined];
    if (action && !FUNNEL_ACTIONS.includes(action)) throw new UsageError(`Unknown action "${action}": use ${FUNNEL_ACTIONS.join(", ")} (or none for the list)`);
    if (toggle !== undefined && action !== "alerts") throw new UsageError(`Unexpected argument "${toggle}"`);
    const app = resolveApp(selector, (await ctx.apps()).items);
    const base = `/apps/${encodeURIComponent(app.id)}/funnels`;

    if (action === "create") {
      if (target) throw new UsageError(`Usage: revflare funnels ${selector} create --name <name> --step <spec> --step <spec> [--window 7d] [--unordered]`);
      const name = str(values.name);
      if (!name) throw new UsageError("create: --name is required");
      const steps = list(values.step).map(parseStepSpec);
      if (steps.length < 2) throw new UsageError("create: at least two --step");
      const body = { name, steps, ...(str(values.window) ? { window: str(values.window) } : {}), ...(values.unordered ? { ordered: false } : {}) };
      const f = await ctx.api.post<Funnel>(base, body);
      if (ctx.json) return printJson(f);
      println(`${c.green("Created")} ${f.name} ${c.gray(f.id)}: ${f.steps.map(stepText).join(" → ")}`);
      return;
    }
    if (action === "delete") {
      if (!target) throw new UsageError(`Usage: revflare funnels ${selector} delete <funnel>`);
      const f = await findFunnel(ctx, app.id, target);
      await ctx.api.delete(`${base}/${encodeURIComponent(f.id)}`);
      if (ctx.json) return printJson({ ok: true, id: f.id });
      println(`Funnel ${f.name} deleted`);
      return;
    }
    if (action === "alerts") {
      const usage = `Usage: revflare funnels ${selector} alerts <funnel> [on|off] [--sensitivity high|normal|low]`;
      if (!target) throw new UsageError(usage);
      if (toggle !== undefined && toggle !== "on" && toggle !== "off") throw new UsageError(usage);
      const sensitivity = str(values.sensitivity);
      if (sensitivity && !(FUNNEL_ALERT_SENSITIVITIES as readonly string[]).includes(sensitivity)) throw new UsageError(`--sensitivity must be ${FUNNEL_ALERT_SENSITIVITIES.join(", ")}`);
      let f = await findFunnel(ctx, app.id, target);
      if (toggle || sensitivity) {
        const alerts: FunnelInput["alerts"] = { ...(toggle ? { enabled: toggle === "on" } : {}), ...(sensitivity ? { sensitivity: sensitivity as FunnelAlertSensitivity } : {}) };
        f = await ctx.api.patch<Funnel>(`${base}/${encodeURIComponent(f.id)}`, { alerts } satisfies FunnelInput);
      }
      if (ctx.json) return printJson({ id: f.id, name: f.name, alerts: f.alerts ?? null });
      if (!f.alerts) return println(c.yellow("This server has no funnel alerts yet (update Revflare)."));
      println(`${f.name} ${c.gray(f.id)}: alerts ${f.alerts.enabled ? c.green("on") : c.gray("off")}, sensitivity ${f.alerts.sensitivity}`);
      return;
    }
    if (action === "show") {
      if (!target) throw new UsageError(`Usage: revflare funnels ${selector} show <funnel> [--range 30d] [--breakdown app_version]`);
      const f = await findFunnel(ctx, app.id, target);
      const q = new URLSearchParams();
      for (const k of ["range", "from", "to", "breakdown"]) {
        const v = str(values[k]);
        if (v) q.set(k, v);
      }
      if (values["include-test"]) q.set("includeTest", "true");
      const r = await ctx.api.get<FunnelReport>(`${base}/${encodeURIComponent(f.id)}/report${q.toString() ? `?${q}` : ""}`).catch(notConfiguredHint);
      if (ctx.json) return printJson(r);
      println(`${c.bold(f.name)}  ${app.name}  ${c.gray(`entered ${r.from} → ${r.to} (UTC), window ${fmtSeconds(f.windowSeconds)}, ${f.ordered ? "ordered" : "any order"}`)}${r.source === "exact" ? `  ${c.green("exact")}` : ""}${r.approximate ? `  ${c.yellow("approximate")}` : ""}${r.includeTest ? `  ${c.yellow("test data included")}` : ""}`);
      println("");
      printReportSteps(r.steps);
      for (const g of r.groups) {
        println("");
        println(`${c.bold(r.breakdown ?? "")} = ${g.value}`);
        printReportSteps(g.steps);
      }
      for (const n of r.notes) println(c.yellow(`note: ${n}`));
      return;
    }
    const { items } = await ctx.api.get<{ items: Funnel[] }>(base);
    if (ctx.json) return printJson(items);
    if (!items.length) return println(c.gray(`No funnels yet: revflare funnels ${selector} create --name ... --step event:... --step ...`));
    println(
      table(
        [{ header: "ID" }, { header: "NAME" }, { header: "WINDOW" }, { header: "ORDER" }, { header: "ALERTS" }, { header: "STEPS", flex: true }],
        items.map((f) => [f.id, f.name, fmtSeconds(f.windowSeconds), f.ordered ? "ordered" : "any", alertsText(f), f.steps.map(stepText).join(" → ")]),
      ),
    );
  },
};
