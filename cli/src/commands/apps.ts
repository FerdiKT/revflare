import type { Command } from "../context.js";
import { c, fmtDate, fmtMoney, println, printJson, table } from "../format.js";
import { CliError, UsageError } from "../errors.js";
import { resolveApp } from "../resolve.js";
import type { App, Product, TestDevices } from "../types.js";
import { str } from "../args.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEST_DEVICE_ACTIONS = ["list", "add", "rm"] as const;

const NOTIF: Record<App["notificationUrlStatus"], string> = {
  revflare: c.green("revflare"),
  other: c.yellow("other (polled)"),
  none: c.red("none"),
  unknown: c.gray("unknown"),
};

/** Store column: App Store / Google Play / Polar (web). */
export const storeName = (a: Pick<App, "platform">) => (a.platform === "android" ? "Google Play" : a.platform === "web" ? "Polar (web)" : "App Store");

/** Notifications column: App Store notification URL status; Google Play setup (key, push authentication). */
function notifications(a: App): string {
  if (a.platform === "web") return !a.polar?.connected ? c.yellow("polar not connected") : a.lastNotificationAt ? c.green("polar") : c.gray("waiting for webhook");
  if (a.platform !== "android") return NOTIF[a.notificationUrlStatus];
  const g = a.googlePlay;
  if (!g?.configured) return c.yellow("no service account");
  if (g.lastCheck && !g.lastCheck.ok) return c.red("check failed");
  return a.lastNotificationAt ? c.green("rtdn") : c.gray("waiting for RTDN");
}

const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

export const apps: Command = {
  name: "apps",
  args: "[add-android <name> <package> | add-web <name> [id] | <app> test-devices [list|add <install-id...>|rm <install-id...>]]",
  summary: "Apps with store, MRR, 28-day revenue, active subscriptions and trials (archived ones with --all); add an Android app; an app's test devices.",
  description:
    "  add-android <name> <package>       add a Google Play app (needs manage); then: revflare google-play <app>\n" +
    "  add-web <name> [id]                add a website selling through Polar (needs manage); then: revflare polar <app>\n" +
    "--platform ios|android|web lists one store's apps. An iOS and an Android app may share the bundle id / package name:\n" +
    "select one with ios:<bundle id> or android:<package> (or the app id).\n" +
    "Test devices: RevflareKit install ids (at most 50 per app, Revflare.installId on the device) left out of events,\n" +
    "funnels, experiments, insights, LTV, attributed revenue and Meta sending, like sandbox / Xcode builds.\n" +
    "  <app> test-devices [list]           the app's test devices\n" +
    "  <app> test-devices add <id...>      add install ids (needs manage)\n" +
    "  <app> test-devices rm <id...>       remove install ids (needs manage)",
  options: {
    all: { type: "boolean", description: "Include archived apps" },
    platform: { type: "string", arg: "<ios|android|web>", description: "Only App Store (ios), Google Play (android) or Polar (web) apps" },
  },
  examples: [
    "revflare apps",
    "revflare apps --platform android",
    'revflare apps add-android "Example" com.example.app',
    'revflare apps add-web "Example Web" com.example.web',
    "revflare apps --all --json",
    "revflare apps com.example.app test-devices",
    "revflare apps com.example.app test-devices add 6f1c2a4e-0b7d-4c41-9a51-2f3e4d5c6b7a",
  ],
  async run(ctx, { values, positionals }) {
    if (positionals[0] === "add-android") return addAndroid(ctx, positionals.slice(1));
    if (positionals[0] === "add-web") return addWeb(ctx, positionals.slice(1));
    if (positionals.length) return testDevices(ctx, positionals);
    const platform = str(values.platform)?.toLowerCase();
    if (platform && platform !== "ios" && platform !== "android" && platform !== "web") throw new UsageError("--platform must be ios, android or web");
    const r = await ctx.apps();
    const items = (values.all ? r.items : r.items.filter((a) => !a.archived)).filter((a) => !platform || (a.platform || "ios") === platform);
    if (ctx.json) return printJson({ ...r, items });
    const m = (n: number) => fmtMoney(n, r.currency, { compact: true });
    println(
      table(
        [{ header: "ID" }, { header: "NAME", flex: true }, { header: "STORE" }, { header: "BUNDLE ID", flex: true }, { header: "MRR", align: "right" }, { header: "REVENUE 28D", align: "right" }, { header: "SUBS", align: "right" }, { header: "TRIALS", align: "right" }, { header: "NOTIFICATIONS" }],
        items.map((a) => [a.id, a.name + (a.archived ? c.gray(" (archived)") : "") + (a.storeAvailable === false ? c.gray(" (unreleased)") : ""), storeName(a), a.bundleId, m(a.mrr), m(a.revenue28d), a.activeSubscriptions, a.activeTrials, notifications(a)]),
      ),
    );
    const total = (k: "mrr" | "revenue28d") => items.reduce((s, a) => s + a[k], 0);
    println(c.gray(`${items.length} apps · MRR ${fmtMoney(total("mrr"), r.currency)} · revenue 28d ${fmtMoney(total("revenue28d"), r.currency)}`));
  },
};

export const app: Command = {
  name: "app",
  args: "<id|bundle-id>",
  summary: "One app: setup (notifications, history sync, RevenueCat project, SDK key), KPIs and products.",
  options: { "sdk-key": { type: "boolean", description: "Print only the RevflareKit SDK key (Apple Ads attribution)" } },
  min: 1,
  max: 1,
  examples: ["revflare app com.example.app", "revflare app app_123 --json", "revflare app com.example.app --sdk-key"],
  async run(ctx, { values, positionals }) {
    const { items, currency } = await ctx.apps();
    const a = resolveApp(positionals[0], items);
    const full = await ctx.api.get<App & { products: Product[] }>(`/apps/${encodeURIComponent(a.id)}`);
    if (values["sdk-key"]) {
      if (ctx.json) return printJson({ appId: full.id, sdkKey: full.sdkKey });
      if (!full.sdkKey) throw new CliError(`${full.name} has no SDK key yet: create one with revflare sdk-key ${positionals[0]} --rotate --yes`);
      return println(full.sdkKey);
    }
    if (ctx.json) return printJson(full);
    const m = (n: number) => fmtMoney(n, currency);
    println(`${c.bold(full.name)} ${c.gray(full.id)}${full.archived ? c.yellow(" (archived)") : ""}`);
    if (full.platform === "web") {
      const rows: Array<[string, string]> = [
        ["Store", "Polar (web)"],
        ["Id", full.bundleId ?? "-"],
        ["MRR", m(full.mrr)],
        ["Revenue 28d", m(full.revenue28d)],
        ["Active subs", String(full.activeSubscriptions)],
        ["Active trials", String(full.activeTrials)],
        ["Polar", full.polar?.connected ? c.green("connected") : c.yellow("not connected: revflare polar <app> set-secret -")],
        ["Webhook URL", full.revflareNotificationUrl],
        ["Last webhook", fmtDate(full.lastNotificationAt)],
        ["SDK key", full.sdkKey ?? "-"],
      ];
      for (const [k, v] of rows) println(`${c.gray(k.padEnd(19))}${v}`);
      if (full.products.length) {
        println("", c.bold("Products"));
        println(table([{ header: "PRODUCT ID" }, { header: "NAME", flex: true }, { header: "TYPE" }, { header: "PERIOD" }], full.products.map((p) => [p.productId, p.name, p.type, p.period])));
      }
      return;
    }
    if (full.platform === "android") {
      const g = full.googlePlay;
      const rows: Array<[string, string]> = [
        ["Store", "Google Play"],
        ["Package name", full.bundleId ?? "-"],
        ["Commission", `${full.commissionPct}% (fallback when the Orders API gives no proceeds)`],
        ["MRR", m(full.mrr)],
        ["Revenue 28d", m(full.revenue28d)],
        ["Active subs", String(full.activeSubscriptions)],
        ["Active trials", String(full.activeTrials)],
        ["Service account", g?.configured ? c.green("set") : c.yellow("missing: revflare google-play <app> set-credential <key.json>")],
        ["Push auth", g?.pushAuth ? c.green("OIDC verified") : c.gray("off (URL key only)")],
        ["Last check", g?.lastCheck ? (g.lastCheck.ok ? c.green(`ok ${fmtDate(g.lastCheck.at)}`) : c.red(g.lastCheck.error ?? "failed")) : "-"],
        ["RTDN push URL", full.revflareNotificationUrl],
        ["Last notification", fmtDate(full.lastNotificationAt)],
        ["SDK key", full.sdkKey ?? "-"],
      ];
      for (const [k, v] of rows) println(`${c.gray(k.padEnd(19))}${v}`);
      if (full.products.length) {
        println("", c.bold("Products"));
        println(table([{ header: "PRODUCT ID" }, { header: "NAME", flex: true }, { header: "TYPE" }, { header: "PERIOD" }], full.products.map((p) => [p.productId, p.name, p.type, p.period])));
      }
      return;
    }
    const rows: Array<[string, string]> = [
      ["Bundle id", full.bundleId ?? "-"],
      ["App Store id", full.appleAppId ?? "-"],
      ["Platform", full.platform],
      ["Commission", `${full.commissionPct}%`],
      ["MRR", m(full.mrr)],
      ["Revenue 28d", m(full.revenue28d)],
      ["Active subs", String(full.activeSubscriptions)],
      ["Active trials", String(full.activeTrials)],
      ["Notifications", `${NOTIF[full.notificationUrlStatus]}${full.currentNotificationUrl && full.notificationUrlStatus !== "revflare" ? c.gray(` ${full.currentNotificationUrl}`) : ""}`],
      ["Revflare URL", full.revflareNotificationUrl],
      ["Last notification", fmtDate(full.lastNotificationAt)],
      ["Last history sync", fmtDate(full.lastHistorySyncAt)],
      ["History from", full.historyBackfilledFrom ?? "-"],
      ["RevenueCat project", full.rcProjectId ?? "-"],
      ["SDK key", full.sdkKey ?? "-"],
      ["On the App Store", full.storeAvailable === null ? "unknown" : full.storeAvailable ? "yes" : "no (unreleased)"],
    ];
    for (const [k, v] of rows) println(`${c.gray(k.padEnd(19))}${v}`);
    if (full.products.length) {
      println("", c.bold("Products"));
      println(table([{ header: "PRODUCT ID" }, { header: "NAME", flex: true }, { header: "TYPE" }, { header: "PERIOD" }], full.products.map((p) => [p.productId, p.name, p.type, p.period])));
    }
  },
};

async function addAndroid(ctx: Parameters<Command["run"]>[0], args: string[]) {
  const [name, pkg] = args;
  if (args.length !== 2 || !name?.trim()) throw new UsageError('Usage: revflare apps add-android <name> <package>, e.g. revflare apps add-android "Example" com.example.app');
  if (!PACKAGE_RE.test(pkg)) throw new UsageError(`Not an Android package name: ${pkg} (e.g. com.example.app)`);
  const a = await ctx.api.post<App>("/apps", { platform: "android", name: name.trim(), packageName: pkg });
  if (ctx.json) return printJson(a);
  println(`${c.green("Added")} ${a.name} ${c.gray(a.id)} (Google Play, ${a.bundleId})`);
  println(`RTDN push URL (Pub/Sub push subscription endpoint; keep it secret): ${a.revflareNotificationUrl}`);
  println(c.gray(`Next: revflare google-play ${a.id} set-credential <service-account.json>  (setup steps: docs/google-play.md)`));
}

async function addWeb(ctx: Parameters<Command["run"]>[0], args: string[]) {
  const [name, id] = args;
  if (args.length < 1 || args.length > 2 || !name?.trim()) throw new UsageError('Usage: revflare apps add-web <name> [id], e.g. revflare apps add-web "Example Web" com.example.web');
  const a = await ctx.api.post<App>("/apps", { platform: "web", name: name.trim(), ...(id ? { bundleId: id } : {}) });
  if (ctx.json) return printJson(a);
  println(`${c.green("Added")} ${a.name} ${c.gray(a.id)} (Polar, web)`);
  println(`Polar webhook URL (keep it secret): ${a.revflareNotificationUrl}`);
  println(c.gray(`Next: revflare polar ${a.id} set-token -   (or set-secret -; setup steps: docs/polar.md)`));
}

async function testDevices(ctx: Parameters<Command["run"]>[0], positionals: string[]) {
  const [selector, sub, action = "list", ...ids] = positionals;
  if (sub !== "test-devices") throw new UsageError(`Usage: revflare apps <app> test-devices [list|add|rm] [install-id...]`);
  if (!(TEST_DEVICE_ACTIONS as readonly string[]).includes(action)) throw new UsageError(`Unknown action "${action}": use ${TEST_DEVICE_ACTIONS.join(", ")}`);
  const a = resolveApp(selector, (await ctx.apps()).items);
  const path = `/apps/${encodeURIComponent(a.id)}/test-devices`;
  let r = await ctx.api.get<TestDevices>(path);
  if (action === "list") {
    if (ids.length) throw new UsageError("Usage: revflare apps <app> test-devices list");
  } else {
    if (!ids.length) throw new UsageError(`Usage: revflare apps <app> test-devices ${action} <install-id...>`);
    const wanted = ids.map((x) => x.trim().toLowerCase());
    for (const id of wanted) if (!UUID_RE.test(id)) throw new UsageError(`Not an install id (UUID): ${id}`);
    const next = action === "add" ? [...new Set([...r.installIds, ...wanted])] : r.installIds.filter((x) => !wanted.includes(x));
    if (next.length > r.limit) throw new CliError(`At most ${r.limit} test devices per app`);
    r = await ctx.api.put<TestDevices>(path, { installIds: next });
  }
  if (ctx.json) return printJson(r);
  println(`${c.bold("Test devices")}  ${a.name}  ${c.gray(`${r.installIds.length}/${r.limit}`)}`);
  if (!r.installIds.length) return println(c.gray("None: add install ids with revflare apps <app> test-devices add <install-id>."));
  for (const id of r.installIds) println(id);
}
