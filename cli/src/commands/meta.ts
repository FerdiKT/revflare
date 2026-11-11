import { list, str, type Parsed } from "../args.js";
import type { Command, Ctx } from "../context.js";
import { UsageError } from "../errors.js";
import { readStdin } from "../io.js";
import { c, fmtDate, fmtNum, fmtWhen, println, printJson, table } from "../format.js";
import { resolveApp } from "../resolve.js";
import type { MetaDelivery, MetaEventType, MetaIntegration, MetaIntegrationUpdate } from "../types.js";

export const META_EVENT_TYPES: MetaEventType[] = ["trial_started", "initial_purchase", "trial_converted", "renewal", "non_subscription_purchase"];
const ACTIONS = ["set", "test", "log", "backfill"] as const;
const SET_FLAGS = ["dataset-id", "token", "clear-token", "test-code", "enable", "disable", "sandbox", "without-att", "event", "event-on", "event-off"];

function onOff(v: string | undefined, flag: string): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.toLowerCase();
  if (["on", "true", "yes", "1"].includes(s)) return true;
  if (["off", "false", "no", "0"].includes(s)) return false;
  throw new UsageError(`--${flag} takes on or off`);
}

function eventType(s: string): MetaEventType {
  const t = s.trim().replace(/-/g, "_").toLowerCase() as MetaEventType;
  if (!META_EVENT_TYPES.includes(t)) throw new UsageError(`Unknown event type "${s}": ${META_EVENT_TYPES.join(", ")}`);
  return t;
}

/** PUT body from `meta <app> set` flags (the token is passed separately: it may come from stdin). */
export function metaUpdateBody(values: Parsed["values"], token?: string | null): MetaIntegrationUpdate {
  const body: MetaIntegrationUpdate = {};
  if (values.enable && values.disable) throw new UsageError("Use either --enable or --disable");
  if (values.enable) body.enabled = true;
  if (values.disable) body.enabled = false;
  const dataset = str(values["dataset-id"]);
  if (dataset !== undefined) body.datasetId = dataset.trim() || null;
  if (token !== undefined) body.accessToken = token;
  if (values["clear-token"]) body.accessToken = null;
  const code = str(values["test-code"]);
  if (code !== undefined) body.testEventCode = code.trim() || null;
  const sandbox = onOff(str(values.sandbox), "sandbox");
  if (sandbox !== undefined) body.sendSandbox = sandbox;
  const withoutAtt = onOff(str(values["without-att"]), "without-att");
  if (withoutAtt !== undefined) body.sendWithoutAtt = withoutAtt;
  const events: NonNullable<MetaIntegrationUpdate["events"]> = {};
  const ev = (t: MetaEventType) => (events[t] ??= {});
  for (const e of list(values.event)) {
    const i = e.indexOf("=");
    if (i < 0) throw new UsageError(`--event takes type=Name, e.g. renewal=Subscribe (empty or "default" restores the default)`);
    const name = e.slice(i + 1).trim();
    if (name && (name.length > 40 || !/^[A-Za-z0-9_\- ]+$/.test(name))) throw new UsageError(`Invalid event name "${name}": letters, digits, _, - and spaces, at most 40 characters`);
    Object.assign(ev(eventType(e.slice(0, i))), { enabled: true, name: name && name.toLowerCase() !== "default" ? name : null });
  }
  for (const t of list(values["event-on"])) ev(eventType(t)).enabled = true;
  for (const t of list(values["event-off"])) ev(eventType(t)).enabled = false;
  if (Object.keys(events).length) body.events = events;
  return body;
}

function printStatus(name: string, m: MetaIntegration) {
  const yes = (b: boolean) => (b ? c.green("on") : c.gray("off"));
  println(`${c.bold("Meta Ads")}  ${name}  ${m.enabled ? c.green("● on") : c.gray("○ off")}`);
  const rows: Array<[string, string]> = [
    ["Dataset id", m.datasetId ?? "-"],
    ["Access token", m.accessTokenSet ? "set" : c.yellow("not set")],
    ["Test event code", m.testEventCode ?? "-"],
    ["Send Sandbox", yes(m.sendSandbox)],
    ["Send without ATT", yes(m.sendWithoutAtt)],
    ["Events", `${fmtNum(m.stats.sent)} sent · ${fmtNum(m.stats.pending)} pending · ${fmtNum(m.stats.skipped)} skipped · ${fmtNum(m.stats.failed)} failed`],
    ["Last sent", m.lastSentAt ? fmtWhen(m.lastSentAt) : "-"],
    ["Last backfill", m.backfilledAt ? fmtWhen(m.backfilledAt) : "-"],
  ];
  if (m.lastError) rows.push(["Last error", c.red(m.lastError)]);
  for (const [k, v] of rows) println(`${c.gray(k.padEnd(18))}${v}`);
  println("");
  println(
    table(
      [{ header: "EVENT TYPE" }, { header: "SEND" }, { header: "META EVENT NAME" }, { header: "DEFAULT" }],
      META_EVENT_TYPES.map((t) => [t, yes(m.events[t].enabled), m.events[t].name, c.gray(m.events[t].defaultName)]),
    ),
  );
}

async function appOf(ctx: Ctx, selector: string) {
  return resolveApp(selector, (await ctx.apps()).items);
}

export const meta: Command = {
  name: "meta",
  args: "<app> [set|test|log|backfill]",
  summary: "Meta Ads integration (purchases to Meta's Conversions API): status, settings, test event, delivery log, backfill.",
  description:
    "Revflare sends the app's trials, purchases and renewals server-side to Meta's Conversions API as app events, matched\n" +
    "through the identifiers RevflareKit reports (Facebook SDK anonymous id, IDFA). Actions:\n" +
    "  (none)    status: settings (never the token), event names, counts, last error\n" +
    "  set       change settings (needs manage); --token - reads the token from stdin\n" +
    "  test      send one test event with the test event code (shows under Test events in Events Manager)\n" +
    "  log       the last deliveries: sent / skipped (with the reason) / failed (with Meta's answer)\n" +
    "  backfill  queue the last 7 days again (failed and skipped included; sent events are never resent)\n" +
    `Event types: ${META_EVENT_TYPES.join(", ")}.`,
  options: {
    "dataset-id": { type: "string", arg: "<id>", description: "set: Meta dataset (pixel) id (\"\" clears)" },
    token: { type: "string", arg: "<token|->", description: "set: Conversions API access token (- reads stdin; write-only)" },
    "clear-token": { type: "boolean", description: "set: remove the saved token" },
    "test-code": { type: "string", arg: "<code>", description: "set: test event code (\"\" clears)" },
    enable: { type: "boolean", description: "set: turn sending on (the first time also queues the last 7 days)" },
    disable: { type: "boolean", description: "set: turn sending off" },
    sandbox: { type: "string", arg: "<on|off>", description: "set: also send Sandbox purchases" },
    "without-att": { type: "string", arg: "<on|off>", description: "set: also send installs without ATT consent" },
    event: { type: "string", multiple: true, arg: "<type=Name>", description: "set: turn an event on with this Meta name (=default restores it)" },
    "event-on": { type: "string", multiple: true, arg: "<type>", description: "set: turn an event type on" },
    "event-off": { type: "string", multiple: true, arg: "<type>", description: "set: turn an event type off" },
    limit: { type: "string", arg: "<n>", description: "log: rows (default 30, at most 100)" },
  },
  min: 1,
  max: 2,
  examples: [
    "revflare meta com.example.app",
    "revflare meta com.example.app set --dataset-id 123456789012345 --token - --enable < token.txt",
    "revflare meta com.example.app set --event renewal=Subscribe --event-off trial_started --sandbox on",
    "revflare meta com.example.app test",
    "revflare meta com.example.app log --limit 50",
    "revflare meta com.example.app backfill",
  ],
  async run(ctx, { values, positionals }) {
    const action = positionals[1] as (typeof ACTIONS)[number] | undefined;
    if (action && !ACTIONS.includes(action)) throw new UsageError(`Unknown action "${action}": use ${ACTIONS.join(", ")} (or none for the status)`);
    if (action !== "set" && SET_FLAGS.some((f) => values[f] !== undefined)) throw new UsageError(`Settings flags go with: revflare meta ${positionals[0]} set ...`);
    if (action !== "log" && values.limit !== undefined) throw new UsageError("--limit goes with the log action");
    const app = await appOf(ctx, positionals[0]);
    const base = `/apps/${encodeURIComponent(app.id)}/integrations/meta`;

    if (action === "set") {
      let token: string | null | undefined = str(values.token);
      if (token === "-") {
        const read = await (ctx.deps.readStdin ?? readStdin)(false);
        token = read?.trim() || undefined;
        if (!token) throw new UsageError("--token -: nothing on stdin");
      }
      const body = metaUpdateBody(values, token === "" ? null : token);
      if (!Object.keys(body).length) throw new UsageError("Nothing to change: see revflare meta --help for the set flags");
      const m = await ctx.api.put<MetaIntegration>(base, body);
      if (ctx.json) return printJson(m);
      println(c.green("Saved."));
      return printStatus(app.name, m);
    }
    if (action === "test") {
      const r = await ctx.api.post<{ ok: true; status: number; response: unknown }>(`${base}/test`);
      if (ctx.json) return printJson(r);
      println(`${c.green("Test event sent")} (HTTP ${r.status}): ${JSON.stringify(r.response)}`);
      println(c.gray("It shows under Test events in Meta Events Manager within a minute."));
      return;
    }
    if (action === "backfill") {
      const r = await ctx.api.post<{ queued: number }>(`${base}/backfill`);
      if (ctx.json) return printJson(r);
      println(`${fmtNum(r.queued)} purchases of the last 7 days queued: the cron sends them within a few minutes.`);
      return;
    }
    if (action === "log") {
      const limit = str(values.limit);
      const n = limit === undefined ? 30 : Number(limit);
      if (!Number.isInteger(n) || n <= 0) throw new UsageError("--limit must be a positive integer");
      const r = await ctx.api.get<{ items: MetaDelivery[] }>(`${base}/log`, { limit: Math.min(n, 100) });
      if (ctx.json) return printJson(r);
      if (!r.items.length) return println("Nothing sent yet: new purchases show up a few minutes after they happen.");
      const tone = { sent: c.green, skipped: c.gray, failed: c.red };
      println(
        table(
          [{ header: "TIME" }, { header: "EVENT" }, { header: "TRANSACTION" }, { header: "STATUS" }, { header: "HTTP", align: "right" }, { header: "DETAIL", flex: true }],
          r.items.map((d) => [fmtDate(d.at), d.eventName ?? d.eventType ?? "-", d.transactionId, tone[d.status](d.status), d.httpStatus ?? "-", d.reason ?? d.response ?? "-"]),
        ),
      );
      return;
    }
    const m = await ctx.api.get<MetaIntegration>(base);
    if (ctx.json) return printJson(m);
    printStatus(app.name, m);
    if (!m.datasetId || !m.accessTokenSet) println("", c.gray(`Set it up: revflare meta ${positionals[0]} set --dataset-id <id> --token - --enable (token on stdin)`));
  },
};
