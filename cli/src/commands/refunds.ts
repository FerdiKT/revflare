import { str, type Parsed } from "../args.js";
import type { Command } from "../context.js";
import { UsageError } from "../errors.js";
import { c, fmtDate, fmtNum, fmtWhen, println, printJson, table } from "../format.js";
import { resolveApp } from "../resolve.js";
import type { RefundPolicy, RefundRequestDefaults, RefundRequestLogItem, RefundRequestSettings, RefundRequestSettingsUpdate } from "../types.js";

const ACTIONS = ["set", "log", "consent"] as const;
const SET_FLAGS = ["enable", "disable", "attest-consent", "withdraw-attestation", "policy", "days", "sample", "consumed", "use-defaults"];

/** Short CLI names → API policies (the API names work too). */
const POLICY_ALIASES: Record<string, RefundPolicy> = {
  none: "none",
  decline: "decline",
  "decline-after": "decline_if_delivered_after_days",
  decline_if_delivered_after_days: "decline_if_delivered_after_days",
  prorated: "grant_prorated",
  grant_prorated: "grant_prorated",
  full: "grant_full",
  grant_full: "grant_full",
};

function onOff(v: string | undefined, flag: string): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.toLowerCase();
  if (["on", "true", "yes", "1"].includes(s)) return true;
  if (["off", "false", "no", "0"].includes(s)) return false;
  throw new UsageError(`--${flag} takes on or off`);
}

/** PUT body from `refunds <app> set` flags. */
export function refundsUpdateBody(values: Parsed["values"]): RefundRequestSettingsUpdate {
  const body: RefundRequestSettingsUpdate = {};
  if (values.enable && values.disable) throw new UsageError("Use either --enable or --disable");
  if (values["attest-consent"] && values["withdraw-attestation"]) throw new UsageError("Use either --attest-consent or --withdraw-attestation");
  if (values["attest-consent"]) body.consentAttested = true;
  if (values["withdraw-attestation"]) body.consentAttested = false;
  if (values.enable) body.enabled = true;
  if (values.disable) body.enabled = false;
  const policy = str(values.policy);
  if (policy !== undefined) {
    const p = POLICY_ALIASES[policy.trim().toLowerCase()];
    if (!p) throw new UsageError(`Unknown policy "${policy}": none, decline, decline-after (with --days), prorated, full`);
    body.refundPolicy = p;
  }
  const days = str(values.days);
  if (days !== undefined) {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 3650) throw new UsageError("--days must be a whole number from 1 to 3650");
    body.declineAfterDays = n;
  }
  const sample = onOff(str(values.sample), "sample");
  if (sample !== undefined) body.sampleContentProvided = sample;
  const consumed = str(values.consumed);
  if (consumed !== undefined) {
    if (["none", "off", ""].includes(consumed.trim().toLowerCase())) body.consumptionPercent = null;
    else {
      const n = Number(consumed.replace(/%$/, ""));
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new UsageError("--consumed takes a percentage from 0 to 100, or none");
      body.consumptionPercent = n;
    }
  }
  return body;
}

const POLICY_LABEL: Record<RefundPolicy, string> = {
  none: "no preference",
  decline: "DECLINE (content delivered)",
  decline_if_delivered_after_days: "DECLINE when older than {days} days",
  grant_prorated: "GRANT_PRORATED",
  grant_full: "GRANT_FULL",
};

function printStatus(name: string, s: RefundRequestSettings | RefundRequestDefaults) {
  const yes = (b: boolean) => (b ? c.green("yes") : c.gray("no"));
  const app = "stats" in s;
  const from = app && s.source ? c.gray(s.source === "workspace" ? "  (workspace defaults)" : s.source === "app" ? "  (app settings)" : "") : "";
  println(`${c.bold(app ? "Refund requests" : "Refund request defaults")}  ${name}  ${s.enabled ? c.green("● on") : c.gray("○ off")}${from}`);
  const rows: Array<[string, string]> = [
    ["Consent attested", s.consentAttested ? `yes, by ${s.consentAttestedBy ?? "?"} ${s.consentAttestedAt ? fmtWhen(s.consentAttestedAt) : ""}`.trim() : c.yellow("no")],
    ["Preference", POLICY_LABEL[s.refundPolicy].replace("{days}", String(s.declineAfterDays ?? "?"))],
    ["Sample content", yes(s.sampleContentProvided)],
    ["Consumed %", s.consumptionPercent === null ? c.gray("not sent") : `${s.consumptionPercent} % (not for auto-renewable subscriptions)`],
  ];
  if (!app) rows.push(["Apps", `${fmtNum(s.apps.usingDefaults)} of ${fmtNum(s.apps.total)} App Store apps use these (the others have their own settings)`]);
  else {
    rows.push(
      ["Delivery status", s.deliveryStatus],
      ["Notifications", `${s.notifications.status}${s.notifications.forwarded ? " (forwarded; Revflare answers too)" : ""}`],
      ["Requests", `${fmtNum(s.stats.sent)} answered · ${fmtNum(s.stats.pending)} pending · ${fmtNum(s.stats.skipped)} skipped · ${fmtNum(s.stats.failed)} failed · ${fmtNum(s.stats.expired)} expired`],
      ["Last answered", s.lastSentAt ? fmtWhen(s.lastSentAt) : "-"],
    );
    if (s.lastError) rows.push(["Last error", c.red(s.lastError)]);
  }
  for (const [k, v] of rows) println(`${c.gray(k.padEnd(18))}${v}`);
}

export const refunds: Command = {
  name: "refunds",
  args: "<app|defaults> [set|log|consent <customer> <on|off>]",
  summary: "Apple refund requests (CONSUMPTION_REQUEST answers): status, settings, log, a customer's consent.",
  description:
    "When a customer asks Apple for a refund, Apple sends a CONSUMPTION_REQUEST and accepts consumption information for\n" +
    "12 hours (it asks again every ~8 hours, then decides alone). Revflare answers requests that reach its URL (also\n" +
    "when it forwards them) and, for apps whose URL is another server's, requests polled inside the 12 hours. An\n" +
    "unanswered production request raises a refund_request_unanswered alert. `defaults` = the workspace defaults that\n" +
    "apps without their own settings use (new apps too). Actions:\n" +
    "  (none)    status: settings, consent attestation, counts, last error\n" +
    "  set       change settings (needs manage). Turning it on needs --attest-consent: you confirm you obtained your\n" +
    "            customers' consent to share consumption data with Apple, as Apple requires\n" +
    "  log       the last requests: answered (Apple's HTTP status) / skipped / failed / expired, with the reason\n" +
    "  consent   a customer withdraws (off) or gives back (on) consent: their requests are skipped\n" +
    "Policies: none (default), decline (DECLINE at any age), decline-after --days N (DECLINE when the purchase is at least N days old), prorated, full.",
  options: {
    enable: { type: "boolean", description: "set: answer refund requests (needs the consent attestation)" },
    disable: { type: "boolean", description: "set: stop answering" },
    "attest-consent": { type: "boolean", description: "set: confirm you obtained your customers' consent (recorded with your name)" },
    "withdraw-attestation": { type: "boolean", description: "set: withdraw the attestation (turns answers off)" },
    policy: { type: "string", arg: "<none|decline-after|prorated|full>", description: "set: refund preference sent to Apple" },
    days: { type: "string", arg: "<n>", description: "set: days for decline-after" },
    sample: { type: "string", arg: "<on|off>", description: "set: sampleContentProvided (a trial / sample was offered)" },
    consumed: { type: "string", arg: "<percent|none>", description: "set: consumed % for non-subscription products (never sent for auto-renewables)" },
    "use-defaults": { type: "boolean", description: "set (an app): drop the app's own settings, the workspace defaults apply" },
    limit: { type: "string", arg: "<n>", description: "log: rows (default 30, at most 100)" },
  },
  min: 1,
  max: 4,
  examples: [
    "revflare refunds com.example.app",
    "revflare refunds defaults set --attest-consent --enable --policy decline",
    "revflare refunds com.example.app set --use-defaults",
    "revflare refunds com.example.app set --attest-consent --enable --policy decline-after --days 30",
    "revflare refunds com.example.app set --policy none --sample on",
    "revflare refunds com.example.app log --limit 50",
    "revflare refunds com.example.app consent cus_123 off",
  ],
  async run(ctx, { values, positionals }) {
    const action = positionals[1] as (typeof ACTIONS)[number] | undefined;
    if (action && !ACTIONS.includes(action)) throw new UsageError(`Unknown action "${action}": use ${ACTIONS.join(", ")} (or none for the status)`);
    if (action !== "consent" && positionals.length > 2) throw new UsageError(`Too many arguments: revflare refunds ${positionals[0]} ${action ?? ""}`.trim());
    if (action !== "set" && SET_FLAGS.some((f) => values[f] !== undefined)) throw new UsageError(`Settings flags go with: revflare refunds ${positionals[0]} set ...`);
    if (action !== "log" && values.limit !== undefined) throw new UsageError("--limit goes with the log action");

    if (action === "consent") {
      const [, , customer, state] = positionals;
      const consent = onOff(state, "consent");
      if (!customer || consent === undefined) throw new UsageError("Usage: revflare refunds <app> consent <customer id> <on|off>");
      const r = await ctx.api.put<{ id: string; refundDataConsent: boolean }>(`/customers/${encodeURIComponent(customer)}/refund-consent`, { consent });
      if (ctx.json) return printJson(r);
      println(r.refundDataConsent ? `Consent restored for ${r.id}.` : `Consent withdrawn for ${r.id}: Apple's refund requests are no longer answered for this customer.`);
      return;
    }

    if (positionals[0] === "defaults") {
      if (action && action !== "set") throw new UsageError("Workspace defaults take: revflare refunds defaults [set ...]");
      if (values["use-defaults"]) throw new UsageError("--use-defaults goes with an app");
      const path = "/integrations/refunds/defaults";
      let d: RefundRequestDefaults;
      if (action === "set") {
        const body = refundsUpdateBody(values);
        if (!Object.keys(body).length) throw new UsageError("Nothing to change: see revflare refunds --help for the set flags");
        d = await ctx.api.put<RefundRequestDefaults>(path, body);
        if (!ctx.json) println(c.green("Saved."));
      } else d = await ctx.api.get<RefundRequestDefaults>(path);
      if (ctx.json) return printJson(d);
      return printStatus("workspace", d);
    }

    const app = resolveApp(positionals[0], (await ctx.apps()).items);
    const base = `/apps/${encodeURIComponent(app.id)}/integrations/refunds`;
    if (action === "set") {
      const body = refundsUpdateBody(values);
      if (values["use-defaults"]) body.useDefaults = true;
      if (!Object.keys(body).length) throw new UsageError("Nothing to change: see revflare refunds --help for the set flags");
      const s = await ctx.api.put<RefundRequestSettings>(base, body);
      if (ctx.json) return printJson(s);
      println(c.green("Saved."));
      return printStatus(app.name, s);
    }
    if (action === "log") {
      const limit = str(values.limit);
      const n = limit === undefined ? 30 : Number(limit);
      if (!Number.isInteger(n) || n <= 0) throw new UsageError("--limit must be a positive integer");
      const r = await ctx.api.get<{ items: RefundRequestLogItem[] }>(`${base}/log`, { limit: Math.min(n, 100) });
      if (ctx.json) return printJson(r);
      if (!r.items.length) return println("No refund requests yet.");
      const tone = { sent: c.green, skipped: c.gray, failed: c.red, expired: c.red, pending: c.yellow };
      println(
        table(
          [{ header: "RECEIVED" }, { header: "TRANSACTION" }, { header: "PRODUCT" }, { header: "STATUS" }, { header: "HTTP", align: "right" }, { header: "DETAIL", flex: true }],
          r.items.map((d) => [
            fmtDate(d.receivedAt),
            d.transactionId,
            d.productName ?? d.productId ?? "-",
            tone[d.status](d.status),
            d.httpStatus ?? "-",
            d.reason ?? (d.request?.refundPreference ? `refundPreference ${d.request.refundPreference}` : d.response ?? "-"),
          ]),
        ),
      );
      return;
    }
    const s = await ctx.api.get<RefundRequestSettings>(base);
    if (ctx.json) return printJson(s);
    printStatus(app.name, s);
    if (!s.enabled) println("", c.gray(`Turn it on: revflare refunds ${positionals[0]} set --attest-consent --enable, or for every app: revflare refunds defaults set --attest-consent --enable (after obtaining your customers' consent)`));
  },
};
