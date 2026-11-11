import { list, str } from "../args.js";
import type { Command, Ctx } from "../context.js";
import { UsageError } from "../errors.js";
import { c, eprintln, fmtDate, fmtDuration, fmtMoney, fmtStatus, fmtWhen, println, printJson, table } from "../format.js";
import { QUICK_ACTION_MS, type AdsAttribution, type Customer, type Page, type Subscription, type Transaction, type TransactionKind } from "../types.js";

const named = (id: string | null, name: string | null) => (id ? (name ? `${name} (${id})` : `#${id}`) : null);
import { APP_OPTION, CURRENCY_OPTION, positiveInt, scopeQuery } from "./common.js";

const KINDS: TransactionKind[] = ["trial", "conversion", "new", "renewal", "one_time"];
const isQuick = (ms: number | null | undefined): ms is number => typeof ms === "number" && ms >= 0 && ms <= QUICK_ACTION_MS;

const KIND_COLORS: Record<TransactionKind, (s: string) => string> = {
  trial: c.cyan,
  conversion: c.green,
  new: c.green,
  renewal: c.blue,
  one_time: c.magenta,
  cancellation: c.red,
};

/** "⚡ 2m 14s after install", "⚡ cancelled 3m after", "cancelled 2d after" (cancellation rows). */
export function quickLabel(t: Transaction): string {
  if (t.kind === "cancellation") {
    if (t.sincePurchaseMs === null || t.sincePurchaseMs === undefined) return "";
    const what = `${fmtDuration(t.sincePurchaseMs)} after ${t.purchaseKind === "trial" ? "trial start" : "purchase"}`;
    return isQuick(t.sincePurchaseMs) ? c.yellow(`⚡ ${what}`) : c.gray(what);
  }
  const parts: string[] = [];
  if (isQuick(t.sinceInstallMs)) parts.push(`⚡ bought ${fmtDuration(t.sinceInstallMs)} after install`);
  if (isQuick(t.cancelledAfterMs)) parts.push(`⚡ cancelled ${fmtDuration(t.cancelledAfterMs)} after`);
  return parts.length ? c.yellow(parts.join(", ")) : "";
}

/** "Apple Ads · Brand Search" (names when known, else ids), "Google Ads", "referral", "organic", "" (unknown). */
export function sourceLabel(a: AdsAttribution | null | undefined): string {
  if (!a || a.source === "unknown") return "";
  if (a.source === "organic") return c.gray("organic");
  if (a.source === "google_ads") return "Google Ads";
  if (a.source === "referral") return "referral";
  const what = a.adGroupId ? (a.adGroupName ?? `#${a.adGroupId}`) : a.campaignId ? (a.campaignName ?? `#${a.campaignId}`) : null;
  return `${a.test ? "Apple Ads (test)" : "Apple Ads"}${what ? ` · ${what}` : ""}`;
}

const SOURCES = ["apple_ads", "google_ads", "referral", "organic", "unknown"];

function txRows(items: Transaction[], currency: string) {
  return items.map((t) => [
    fmtDate(t.purchasedAt),
    t.appName,
    (KIND_COLORS[t.kind]?.(t.kind) ?? t.kind) + (t.kind === "trial" && t.autoRenew === false && (t.expiresAt ?? 0) > Date.now() ? c.yellow(" cancelled") : ""),
    t.productName ?? t.productId,
    t.refundedAt ? c.red(`${fmtMoney(t.price, currency)} refunded`) : fmtMoney(t.price, currency),
    t.storeCurrency && t.storeCurrency !== currency ? c.gray(fmtMoney(t.storePrice, t.storeCurrency)) : "",
    t.country,
    t.customerId,
    sourceLabel(t.attribution),
    quickLabel(t),
  ]);
}

const TX_COLUMNS = [
  { header: "TIME" },
  { header: "APP", flex: true },
  { header: "KIND" },
  { header: "PRODUCT", flex: true },
  { header: "PRICE", align: "right" as const },
  { header: "STORE PRICE", align: "right" as const },
  { header: "COUNTRY" },
  { header: "CUSTOMER" },
  { header: "SOURCE" },
  { header: "QUICK" },
];

export const transactions: Command = {
  name: "transactions",
  summary: "The sales feed (newest first); --quick: bought / cancelled within 5 minutes; --cancellations: auto-renew turned off; --follow polls.",
  options: {
    kind: { type: "string", short: "k", multiple: true, arg: "<kind>", description: "trial, conversion, new, renewal, one_time (repeatable, comma separated)" },
    ...APP_OPTION,
    country: { type: "string", arg: "<CC>", description: "Only this storefront country (ISO code, e.g. US)" },
    product: { type: "string", arg: "<product-id>", description: "Only this product" },
    search: { type: "string", short: "q", arg: "<text>", description: "Search (transaction id, customer, product...)" },
    refunded: { type: "boolean", description: "Only refunded transactions" },
    sandbox: { type: "boolean", description: "Sandbox transactions instead of production" },
    source: { type: "string", arg: "<source>", description: "apple_ads, google_ads, referral, organic or unknown (the purchase's RevflareKit install; a page looks at 500 transactions at most)" },
    quick: { type: "boolean", description: "Only buyers within 5 minutes of the install (RevflareKit) and cancellations within 5 minutes of the purchase (a page looks at 500 rows at most)" },
    cancellations: { type: "boolean", description: "The cancellations (auto-renew turned off) instead of the sales, with the time since the purchase" },
    limit: { type: "string", short: "n", arg: "<n>", description: "Transactions (default 50; 20 before --follow)" },
    cursor: { type: "string", arg: "<cursor>", description: "Next page (nextCursor of a previous --json call)" },
    follow: { type: "boolean", short: "f", description: "Keep polling and print new transactions (Ctrl-C to stop)" },
    every: { type: "string", arg: "<seconds>", description: "Poll interval for --follow (default 15)" },
    polls: { type: "string", arg: "<n>", description: "Stop --follow after n polls (default: never)" },
    ...CURRENCY_OPTION,
  },
  max: 0,
  examples: [
    "revflare transactions",
    "revflare transactions --kind new,conversion --country US",
    "revflare transactions --refunded --limit 20",
    "revflare transactions --source apple_ads",
    "revflare transactions --quick",
    "revflare transactions --cancellations --quick",
    "revflare transactions --follow",
  ],
  async run(ctx, { values }) {
    const kinds = list(values.kind).flatMap((k) => k.split(",")).map((k) => k.trim()).filter(Boolean);
    for (const k of kinds) if (!KINDS.includes(k as TransactionKind)) throw new UsageError(`Unknown kind "${k}": use ${KINDS.join(", ")}`);
    const country = str(values.country);
    if (country && !/^[A-Za-z]{2,3}$/.test(country)) throw new UsageError(`Invalid --country "${country}"`);
    const source = str(values.source)?.toLowerCase().replace("-", "_");
    if (source && !SOURCES.includes(source)) throw new UsageError(`Invalid --source "${values.source}": use ${SOURCES.join(", ")}`);
    const scope = await scopeQuery(ctx, values);
    const query = {
      kinds: kinds.length ? kinds.join(",") : undefined,
      country: country?.toUpperCase(),
      product: str(values.product),
      q: str(values.search),
      refunded: values.refunded ? "true" : undefined,
      environment: values.sandbox ? "Sandbox" : undefined,
      source,
      quick: values.quick ? "true" : undefined,
      cancellations: values.cancellations ? "true" : undefined,
      ...scope,
    };
    const follow = !!values.follow;
    const limit = positiveInt(str(values.limit), "limit", follow ? 20 : 50)!;
    const page = await ctx.api.get<Page<Transaction>>("/transactions", { ...query, limit, cursor: str(values.cursor) });
    if (!follow) {
      if (ctx.json) return printJson(page);
      const currency = page.currency ?? (await ctx.currency(scope.currency));
      println(table(TX_COLUMNS, txRows(page.items, currency)));
      if (page.nextCursor)
        println(
          c.gray(
            `More: revflare transactions --cursor ${page.nextCursor}${kinds.length ? ` --kind ${kinds.join(",")}` : ""}${source ? ` --source ${source}` : ""}${values.quick ? " --quick" : ""}${values.cancellations ? " --cancellations" : ""}`,
          ),
        );
      return;
    }
    await followFeed(ctx, query, page, scope.currency, values);
  },
};

async function followFeed(ctx: Ctx, query: Record<string, string | undefined>, page: Page<Transaction>, currencyFlag: string | undefined, values: Record<string, unknown>) {
  const every = positiveInt(str(values.every as string | undefined), "every", 15)!;
  const polls = positiveInt(str(values.polls as string | undefined), "polls");
  const first = page.items;
  let currency = ctx.json ? "" : page.currency ?? (await ctx.currency(currencyFlag));
  const seen = new Set(first.map((t) => t.id));
  const emit = (items: Transaction[]) => {
    // Oldest first, like a log.
    const sorted = [...items].sort((a, b) => a.purchasedAt - b.purchasedAt);
    if (ctx.json) for (const t of sorted) process.stdout.write(JSON.stringify(t) + "\n");
    else for (const row of txRows(sorted, currency)) println(row.filter((x) => x !== "" && x !== null && x !== undefined).join("  "));
  };
  emit(first);
  if (!ctx.json) eprintln(c.gray(`Watching for new transactions every ${every}s (Ctrl-C to stop)...`));
  for (let n = 0; polls === undefined || n < polls; n++) {
    await ctx.sleep(every * 1000);
    let items: Transaction[];
    try {
      const next = await ctx.api.get<Page<Transaction>>("/transactions", { ...query, limit: 50 });
      items = next.items;
      if (next.currency && !ctx.json) currency = next.currency;
    } catch (err) {
      eprintln(c.yellow(`poll failed: ${(err as Error).message}`));
      continue;
    }
    const fresh = items.filter((t) => !seen.has(t.id));
    for (const t of fresh) seen.add(t.id);
    if (fresh.length) emit(fresh);
  }
}

export const customer: Command = {
  name: "customer",
  args: "<id>",
  summary: "One customer: lifetime spend, subscriptions and transactions.",
  options: CURRENCY_OPTION,
  min: 1,
  max: 1,
  async run(ctx, { values, positionals }) {
    const cur = str(values.currency);
    const cu = await ctx.api.get<Customer>(`/customers/${encodeURIComponent(positionals[0])}`, { currency: cur?.toUpperCase() });
    if (ctx.json) return printJson(cu);
    const currency = await ctx.currency(cur);
    const m = (n: number) => fmtMoney(n, currency);
    println(`${c.bold(cu.id)}  ${cu.appName}${cu.country ? `  ${cu.country}` : ""}`);
    println(`${c.gray("Spent".padEnd(14))}${m(cu.totalSpent)} ${c.gray(`(proceeds ${m(cu.totalProceeds)})`)}`);
    const firstSrc = cu.firstSeenSource === "install" ? "app install" : cu.firstSeenSource === "purchase" ? "first purchase" : "";
    const lastSrc = cu.lastSeenSource === "app" ? "in the app" : cu.lastSeenSource === "notification" ? "store notification" : cu.lastSeenSource === "purchase" ? "purchase" : "";
    println(`${c.gray("First seen".padEnd(14))}${fmtWhen(cu.firstSeenAt)}${firstSrc ? c.gray(` · ${firstSrc}`) : ""}`);
    println(`${c.gray("Last seen".padEnd(14))}${fmtWhen(cu.lastSeenAt)}${lastSrc ? c.gray(` · ${lastSrc}`) : ""}`);
    if (cu.installedAt) println(`${c.gray("Installed".padEnd(14))}${fmtWhen(cu.installedAt)}${cu.installedAtSource === "first_report" ? c.gray(" · first report") : ""}`);
    println(`${c.gray("First paid".padEnd(14))}${fmtDate(cu.firstPaidAt)}`);
    const tm = cu.timing;
    if (tm) {
      const step = (label: string, ms: number | null) => ms !== null && println(`${c.gray(label.padEnd(14))}${isQuick(ms) ? c.yellow(`⚡ ${fmtDuration(ms)}`) : fmtDuration(ms)}`);
      step(tm.firstPurchaseKind === "trial" ? "Install→trial" : "Install→buy", tm.installToPurchaseMs);
      step("Buy→cancel", tm.purchaseToCancelMs);
      step("Buy→refund", tm.purchaseToRefundMs);
      const flags = [tm.quickPurchase ? "bought within 5 min of install" : null, tm.quickCancel ? "cancelled within 5 min of buying" : null].filter(Boolean);
      if (flags.length) println(`${c.gray("Quick".padEnd(14))}${c.yellow(flags.join(", "))}`);
    }
    if (cu.rcAppUserId) println(`${c.gray("RevenueCat id".padEnd(14))}${cu.rcAppUserId}`);
    if (cu.appAccountToken) println(`${c.gray("Account token".padEnd(14))}${cu.appAccountToken}`);
    if (cu.attribution) {
      const a = cu.attribution;
      const path = [named(a.campaignId, a.campaignName), named(a.adGroupId, a.adGroupName), named(a.keywordId, a.keywordName)].filter(Boolean).join(" → ");
      const label = a.source === "apple_ads" ? `${a.test ? "Apple Ads (test attribution)" : "Apple Ads"}${path ? `  ${path}` : ""}` : a.source === "organic" ? "Organic" : a.source === "google_ads" ? "Google Ads (install referrer gclid)" : a.source === "referral" ? "Referral (install referrer utm_source)" : c.gray("Unknown (no RevflareKit install linked)");
      println(`${c.gray("Acquisition".padEnd(14))}${label}`);
    }
    if (cu.subscriptions.length) {
      println("", c.bold("Subscriptions"));
      println(
        table(
          [{ header: "PRODUCT", flex: true }, { header: "STATUS" }, { header: "AUTO-RENEW" }, { header: "PERIOD" }, { header: "MRR", align: "right" }, { header: "STARTED" }, { header: "EXPIRES" }],
          cu.subscriptions.map((s) => [s.productName ?? s.productId, fmtStatus(s.status), autoRenewLabel(s), s.period, m(s.mrr), fmtDate(s.startedAt), fmtDate(s.expiresAt)]),
        ),
      );
    }
    if (cu.transactions.length) {
      println("", c.bold("Transactions"));
      println(table([...TX_COLUMNS.slice(0, 7), { header: "SINCE INSTALL" }], txRows(cu.transactions, currency).map((r, i) => [...r.slice(0, 7), cu.transactions[i].sinceInstallMs != null ? fmtDuration(cu.transactions[i].sinceInstallMs) : ""])));
    }
    if (cu.events?.length) {
      println("", c.bold("History"));
      println(
        table(
          [{ header: "TIME" }, { header: "EVENT", flex: true }, { header: "PRODUCT", flex: true }],
          cu.events.map((e) => [fmtDate(e.at), e.subtype ? `${e.type} / ${e.subtype}` : e.type, e.productId ?? ""]),
        ),
      );
    }
  },
};

const RUNNING = new Set(["trial", "active", "grace", "billing_retry"]);

/** "on", "off", or "off: cancelled 2026-10-20" in yellow for a running subscription that will not renew. */
function autoRenewLabel(s: Subscription): string {
  if (s.autoRenew) return "on";
  if (!RUNNING.has(s.status)) return "off";
  const after = s.cancelledAfterMs !== null && s.cancelledAfterMs !== undefined ? `, ${isQuick(s.cancelledAfterMs) ? "⚡ " : ""}${fmtDuration(s.cancelledAfterMs)} after buying` : "";
  return c.yellow(`off: ${s.status === "trial" ? "trial cancelled" : "cancelled"}${s.autoRenewOffAt ? ` ${fmtDate(s.autoRenewOffAt)}` : ""}${after}${s.cancelReason ? ` (${s.cancelReason})` : ""}`);
}
