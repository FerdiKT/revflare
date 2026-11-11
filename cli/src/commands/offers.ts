import { str, type Parsed } from "../args.js";
import type { Command } from "../context.js";
import { UsageError } from "../errors.js";
import { c, fmtDate, fmtMoney, fmtNum, println, printJson, table } from "../format.js";
import { resolveApp } from "../resolve.js";
import type { LapsedSegment, OfferEntry, OfferImportResult, OfferKind, OfferSettings, OfferSettingsUpdate, OfferSignatureLogItem, OfferStats } from "../types.js";

const ACTIONS = ["list", "add", "remove", "set", "import", "lapsed", "stats", "log"] as const;
type Action = (typeof ACTIONS)[number];

/** Which flags each action takes. */
const FLAGS: Record<string, Action[]> = { label: ["add"], "win-back": ["add"], strict: ["set"], days: ["lapsed"], range: ["stats"], limit: ["log"] };

function onOff(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.toLowerCase();
  if (["on", "true", "yes", "1"].includes(s)) return true;
  if (["off", "false", "no", "0"].includes(s)) return false;
  throw new UsageError("--strict takes on or off");
}

const toInput = (o: OfferEntry) => ({ productId: o.productId, offerId: o.offerId, label: o.label, kind: o.kind });

/** The allowlist after `add` (replaces an existing entry for the same product and offer). */
export function addOffer(list: OfferEntry[], productId: string, offerId: string, values: Parsed["values"]): OfferSettingsUpdate {
  const kind: OfferKind = values["win-back"] ? "win_back" : "promotional";
  const label = str(values.label) ?? list.find((o) => o.productId === productId && o.offerId === offerId)?.label ?? null;
  const rest = list.filter((o) => !(o.productId === productId && o.offerId === offerId)).map(toInput);
  return { offers: [...rest, { productId, offerId, label, kind }] };
}

function printSettings(name: string, s: OfferSettings) {
  println(`${c.bold("Offers")}  ${name}`);
  const rows: Array<[string, string]> = [
    ["In-App Purchase key", s.keyConfigured ? c.green("yes") : c.yellow("missing: add one (Settings → Store credentials) to sign promotional offers")],
    ["Bundle id", s.bundleId ?? c.yellow("missing")],
    ["Strict mode", s.strict ? c.green("on (only installs with a subscription in the product's group)") : c.gray("off")],
    ["SDK key", s.sdkKey ?? "-"],
  ];
  for (const [k, v] of rows) println(`${c.gray(k.padEnd(20))}${v}`);
  println("");
  if (!s.offers.length) return println(c.gray("No offers on the allowlist: revflare offers <app> add <product> <offer> (or import)."));
  println(
    table(
      [{ header: "PRODUCT" }, { header: "OFFER" }, { header: "KIND" }, { header: "LABEL", flex: true }],
      s.offers.map((o) => [o.productId, o.offerId, o.kind === "win_back" ? "win-back (no signature)" : "promotional", o.label ?? "-"]),
    ),
  );
}

export const offers: Command = {
  name: "offers",
  args: "<app> [list|add <product> <offer>|remove <product> <offer>|set|import|lapsed|stats|log]",
  summary: "Promotional / win-back offers: allowlist, strict mode, import, lapsed subscribers, redemptions, signature log.",
  description:
    "RevflareKit asks Revflare to sign promotional offers (POST /sdk/v1/offers/sign, In-App Purchase key). Only the\n" +
    "(product, offer) pairs on the app's allowlist are signed. Actions:\n" +
    "  list      (default) settings and the allowlist\n" +
    "  add       add or update an offer (--label, --win-back for a win-back offer: listed for labels, never signed)\n" +
    "  remove    remove an offer\n" +
    "  set       --strict on|off: sign only for installs linked to a subscription of the product's group\n" +
    "  import    add the promotional and win-back offers found in App Store Connect (App Store Connect API key)\n" +
    "  lapsed    subscriptions expired in the last --days (default 90) without auto-renew (the offers' audience)\n" +
    "  stats     promotional (offerType 2) and win-back (4) redemptions per offer (--range, default 90d)\n" +
    "  log       the last signature requests (signed / not_allowed / not_configured / not_subscribed)",
  options: {
    label: { type: "string", arg: "<text>", description: "add: a label for the offer" },
    "win-back": { type: "boolean", description: "add: a win-back offer (no signature needed)" },
    strict: { type: "string", arg: "<on|off>", description: "set: strict mode" },
    days: { type: "string", arg: "<n>", description: "lapsed: window in days (default 90, at most 730)" },
    range: { type: "string", arg: "<range>", description: "stats: 7d, 30d, 90d (default), 12m, ytd, all" },
    limit: { type: "string", arg: "<n>", description: "log: rows (default 30, at most 1000)" },
  },
  min: 1,
  max: 4,
  examples: [
    "revflare offers com.example.app",
    "revflare offers com.example.app add com.example.app.annual save50 --label '50 % off'",
    "revflare offers com.example.app add com.example.app.annual comeback --win-back",
    "revflare offers com.example.app set --strict on",
    "revflare offers com.example.app import",
    "revflare offers com.example.app lapsed --days 30",
    "revflare offers com.example.app stats --range 30d",
    "revflare offers com.example.app log --limit 50",
  ],
  async run(ctx, { values, positionals }) {
    const action = (positionals[1] ?? "list") as Action;
    if (!ACTIONS.includes(action)) throw new UsageError(`Unknown action "${action}": use ${ACTIONS.join(", ")}`);
    const takesIds = action === "add" || action === "remove";
    if (takesIds ? positionals.length !== 4 : positionals.length > 2) throw new UsageError(takesIds ? `Usage: revflare offers <app> ${action} <product id> <offer id>` : `Too many arguments for ${action}`);
    for (const [flag, actions] of Object.entries(FLAGS)) if (values[flag] !== undefined && !actions.includes(action)) throw new UsageError(`--${flag} goes with: ${actions.join(", ")}`);

    const app = resolveApp(positionals[0], (await ctx.apps()).items);
    const base = `/apps/${encodeURIComponent(app.id)}/offers`;

    if (action === "list" || action === "add" || action === "remove" || action === "set") {
      let s: OfferSettings;
      if (action === "set") {
        const strict = onOff(str(values.strict));
        if (strict === undefined) throw new UsageError("Nothing to change: revflare offers <app> set --strict on|off");
        s = await ctx.api.put<OfferSettings>(base, { strict });
      } else if (action === "add" || action === "remove") {
        const [, , productId, offerId] = positionals;
        const current = await ctx.api.get<OfferSettings>(base);
        if (action === "remove" && !current.offers.some((o) => o.productId === productId && o.offerId === offerId)) throw new UsageError(`${productId} / ${offerId} is not on the allowlist`);
        const body = action === "add" ? addOffer(current.offers, productId, offerId, values) : { offers: current.offers.filter((o) => !(o.productId === productId && o.offerId === offerId)).map(toInput) };
        s = await ctx.api.put<OfferSettings>(base, body);
      } else s = await ctx.api.get<OfferSettings>(base);
      if (ctx.json) return printJson(s);
      if (action !== "list") println(c.green("Saved."));
      return printSettings(app.name, s);
    }
    if (action === "import") {
      const r = await ctx.api.post<OfferImportResult>(`${base}/import`);
      if (ctx.json) return printJson(r);
      println(`Found ${fmtNum(r.found)} offers in App Store Connect, added ${fmtNum(r.added)}.`);
      for (const e of r.errors) println(`${c.yellow("warning:")} ${e}`);
      return printSettings(app.name, r.settings);
    }
    if (action === "lapsed") {
      const days = str(values.days);
      if (days !== undefined && !(Number.isInteger(Number(days)) && Number(days) >= 1 && Number(days) <= 730)) throw new UsageError("--days must be a whole number from 1 to 730");
      const r = await ctx.api.get<LapsedSegment>(`/apps/${encodeURIComponent(app.id)}/lapsed`, { days: days ?? 90 });
      if (ctx.json) return printJson(r);
      println(`${c.bold("Lapsed subscribers")}  ${app.name}  ${c.gray(`last ${r.days} days, auto-renew off`)}  ${fmtNum(r.total)}`);
      if (!r.total) return;
      println(table([{ header: "PRODUCT" }, { header: "LAPSED", align: "right" }], r.byProduct.map((p) => [p.productName ?? p.productId, fmtNum(p.count)])));
      println("");
      println(
        table(
          [{ header: "EXPIRED" }, { header: "CUSTOMER" }, { header: "PRODUCT" }, { header: "COUNTRY" }, { header: "PAID", align: "right" }],
          r.items.map((i) => [fmtDate(i.expiredAt), i.customerId ?? i.originalTransactionId, i.productName ?? i.productId, i.country ?? "-", fmtMoney(i.totalPaid, r.currency)]),
        ),
      );
      if (r.total > r.items.length) println(c.gray(`Showing the ${r.items.length} most recent of ${fmtNum(r.total)}.`));
      return;
    }
    if (action === "stats") {
      const r = await ctx.api.get<OfferStats>(`${base}/stats`, { range: str(values.range) ?? "90d" });
      if (ctx.json) return printJson(r);
      println(`${c.bold("Offer redemptions")}  ${app.name}  ${c.gray(`${r.from} → ${r.to}`)}`);
      if (!r.items.length) return println(c.gray("No promotional or win-back redemptions in this range."));
      println(
        table(
          [{ header: "TYPE" }, { header: "OFFER" }, { header: "PRODUCT" }, { header: "REDEMPTIONS", align: "right" }, { header: "CUSTOMERS", align: "right" }, { header: "REVENUE", align: "right" }, { header: "PROCEEDS", align: "right" }],
          r.items.map((i) => [i.offerTypeLabel, i.label ? `${i.label} ${c.gray(i.offerId ?? "")}` : (i.offerId ?? "-"), i.productId, fmtNum(i.redemptions), fmtNum(i.customers), fmtMoney(i.revenue, r.currency), fmtMoney(i.proceeds, r.currency)]),
        ),
      );
      println(c.gray(`Total: ${fmtNum(r.totals.redemptions)} redemptions, ${fmtMoney(r.totals.revenue, r.currency)} revenue, ${fmtMoney(r.totals.proceeds, r.currency)} proceeds`));
      return;
    }
    // log
    const limit = str(values.limit);
    const n = limit === undefined ? 30 : Number(limit);
    if (!Number.isInteger(n) || n <= 0) throw new UsageError("--limit must be a positive integer");
    const r = await ctx.api.get<{ items: OfferSignatureLogItem[] }>(`${base}/log`, { limit: Math.min(n, 1000) });
    if (ctx.json) return printJson(r);
    if (!r.items.length) return println("No signature requests yet.");
    const tone = { signed: c.green, not_allowed: c.red, not_configured: c.yellow, not_subscribed: c.yellow };
    println(
      table(
        [{ header: "AT" }, { header: "INSTALL" }, { header: "PRODUCT" }, { header: "OFFER" }, { header: "STATUS" }, { header: "BUILD" }],
        r.items.map((i) => [fmtDate(i.at), i.installId, i.productId, i.offerId, tone[i.status](i.count > 1 ? `${i.status} ×${i.count}` : i.status), i.environment ?? "-"]),
      ),
    );
  },
};
