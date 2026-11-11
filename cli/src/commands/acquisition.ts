// App Store acquisition (Apple's App Analytics reports): where App Store visitors, downloads and purchases come from.

import { list, str, type Parsed } from "../args.js";
import type { Command, Ctx } from "../context.js";
import { UsageError } from "../errors.js";
import { c, fmtMoney, fmtNum, fmtPct, fmtRelative, fmtStatus, println, printJson, table, type Column } from "../format.js";
import { resolveApps } from "../resolve.js";
import type { Acquisition, AcquisitionCampaign, AcquisitionDimension, AcquisitionMetrics, AcquisitionRow, AcquisitionStatus } from "../types.js";
import { APP_OPTION, CURRENCY_OPTION, positiveInt, RANGE_OPTIONS, rangeQuery, scopeQuery } from "./common.js";

const ALIASES: Record<string, AcquisitionDimension> = {
  source: "source",
  sources: "source",
  "source-type": "source",
  source_type: "source",
  referrer: "referrer",
  referrers: "referrer",
  campaign: "campaign",
  campaigns: "campaign",
  day: "day",
  days: "day",
  app: "app",
  apps: "app",
};

/** "--by day,source" → ["day", "source"] (aliases accepted, duplicates dropped; default source). */
export function parseAcquisitionBy(s: string | undefined): AcquisitionDimension[] {
  const parts = (s ?? "source").split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  const dims: AcquisitionDimension[] = [];
  for (const p of parts) {
    const d = ALIASES[p];
    if (!d) throw new UsageError(`Invalid --by "${s}": use source, referrer, campaign, day or app (comma separated for several)`);
    if (!dims.includes(d)) dims.push(d);
  }
  return dims.length ? dims : ["source"];
}

const HEADERS: Record<AcquisitionDimension, string> = { day: "DAY", app: "APP", source: "SOURCE", referrer: "REFERRER", campaign: "CAMPAIGN" };

/** The cell of a row for a dimension; empty referrer / campaign → "(none)". */
export function dimCell(row: AcquisitionRow, dim: AcquisitionDimension, appNames?: Map<string, string>): string {
  switch (dim) {
    case "day":
      return row.day ?? "-";
    case "app":
      return row.appId ? appNames?.get(row.appId) ?? row.appId : "-";
    case "source":
      return row.sourceType || "(none)";
    case "referrer":
      return row.referrer || "(none)";
    case "campaign":
      return row.campaign || "(none)";
  }
}

/** "12,345 impressions → 2,345 page views → 456 downloads (19.45% conversion) · 78 redownloads · $123.45 proceeds" */
export function funnelLine(t: AcquisitionMetrics, currency: string): string {
  const conv = t.conversionRate === null ? "" : ` (${fmtPct(t.conversionRate)} conversion)`;
  return `${fmtNum(t.impressions)} impressions → ${fmtNum(t.pageViews)} page views → ${fmtNum(t.downloads)} downloads${conv} · ${fmtNum(t.redownloads)} redownloads · ${fmtMoney(t.proceeds, currency)} proceeds`;
}

/** An App Store link that tags visits with a campaign token (`pt`: the provider token from App Store Connect). */
export const campaignLink = (appleAppId: string | null, campaign: string, providerToken = "<provider token>") =>
  `https://apps.apple.com/app/id${appleAppId ?? "<APPID>"}?pt=${providerToken}&ct=${/^<.*>$/.test(campaign) ? campaign : encodeURIComponent(campaign)}`;

/** The rows as a table: one column per dimension, then the funnel metrics. */
export function acquisitionTable(d: Acquisition, appNames?: Map<string, string>): string {
  const m = (n: number) => fmtMoney(n, d.currency);
  const columns: Column[] = [
    ...d.by.map((dim): Column => ({ header: HEADERS[dim], ...(dim === "referrer" || dim === "campaign" || dim === "app" ? { flex: true } : {}) })),
    { header: "IMPRESSIONS", align: "right" },
    { header: "PAGE VIEWS", align: "right" },
    { header: "DOWNLOADS", align: "right" },
    { header: "CONV.", align: "right" },
    { header: "REDOWNLOADS", align: "right" },
    { header: "PURCHASES", align: "right" },
    { header: "PROCEEDS", align: "right" },
  ];
  return table(
    columns,
    d.rows.map((r) => [
      ...d.by.map((dim) => {
        const v = dimCell(r, dim, appNames);
        return v === "(none)" ? c.gray(v) : v;
      }),
      fmtNum(r.impressions),
      fmtNum(r.pageViews),
      fmtNum(r.downloads),
      r.conversionRate === null ? "-" : fmtPct(r.conversionRate, 1),
      fmtNum(r.redownloads),
      fmtNum(r.purchases),
      m(r.proceeds),
    ]),
  );
}

const NO_DATA =
  "No App Store acquisition data yet. Apple produces the App Analytics reports 1–2 days after they are requested:\n" +
  "request them with `revflare acquisition requests` (needs an App Store Connect key with the Admin role), then check\n" +
  "`revflare acquisition status`. Tag your own links with a campaign token to see them here:\n" +
  `  ${campaignLink(null, "<campaign>")}`;

const DETAILED_NOTE =
  "Referrer and campaign rows come from Apple's Detailed reports: Apple leaves out rows with fewer than 5 users and adds\n" +
  "a little noise for privacy, so they sum to less than the totals (which are complete).";

async function appIdsOf(ctx: Ctx, values: Parsed["values"]): Promise<string[] | undefined> {
  const sel = list(values.app);
  return sel.length ? resolveApps(sel, (await ctx.apps()).items).map((a) => a.id) : undefined;
}

const appNamesOf = async (ctx: Ctx) => new Map((await ctx.apps()).items.map((a) => [a.id, a.name]));

export const acquisition: Command = {
  name: "acquisition",
  summary: "App Store acquisition (Apple App Analytics): impressions → page views → downloads by source, referrer, campaign.",
  description:
    "Where App Store visitors, first-time downloads and App Store purchases come from, from Apple's App Analytics reports\n" +
    "(App Store search, browse, app / web referrers, campaign links). Apple Ads taps count as App Store search.\n" +
    "Source / day / app use Apple's Standard reports (complete); referrer and campaign the Detailed reports (Apple leaves\n" +
    "out rows with fewer than 5 users and adds noise). Data arrives 1–2 days after `revflare acquisition requests`.\n" +
    "Conversion = downloads / unique product page views. Proceeds are Apple's estimate.",
  options: {
    ...RANGE_OPTIONS,
    by: { type: "string", short: "b", arg: "<source|referrer|campaign|day|app>", description: "Group by (comma separated for several, e.g. day,source; default source)" },
    ...APP_OPTION,
    ...CURRENCY_OPTION,
    limit: { type: "string", short: "l", arg: "<n>", description: "At most n rows" },
  },
  max: 0,
  examples: ["revflare acquisition", "revflare acquisition --by campaign --range 90d", "revflare acquisition --by day --range 7d --app com.example.app", "revflare acquisition --by referrer --json"],
  async run(ctx, { values }) {
    const by = parseAcquisitionBy(str(values.by));
    const limit = positiveInt(str(values.limit), "limit");
    const q: Record<string, string | undefined> = { ...rangeQuery(values), ...(await scopeQuery(ctx, values)), by: by.join(","), limit: limit === undefined ? undefined : String(limit) };
    if (!q.range && !q.from) q.range = "28d";
    const d = await ctx.api.get<Acquisition>("/acquisition", q);
    if (ctx.json) return printJson(d);

    println(`${c.bold("App Store acquisition")}  ${d.from} → ${d.to}  ${c.gray(`by ${d.by.join(", ")}, ${d.currency}`)}`);
    if (d.firstDay === null) return println(NO_DATA);
    println(funnelLine(d.totals, d.currency));
    if (!d.rows.length) {
      println(c.gray(`No data in this range (Apple's reports cover ${d.firstDay} → ${d.lastDay}).`));
      return;
    }
    println("");
    println(acquisitionTable(d, d.by.includes("app") ? await appNamesOf(ctx) : undefined));
    if (d.level === "detailed") println("", c.gray(DETAILED_NOTE));
    if (d.lastDay && d.lastDay < d.to) println(c.gray(`Apple's reports run until ${d.lastDay} (they arrive 1–2 days late).`));
  },
};

export const acquisitionCampaigns: Command = {
  name: "acquisition campaigns",
  summary: "Campaign tokens (ct= in App Store links) seen in Apple's reports: first / last seen, page views, downloads, proceeds.",
  description: `Campaign links: ${campaignLink(null, "<campaign>")}\n(the provider token pt is in App Store Connect → Analytics → Campaigns). All time; Detailed reports (privacy thresholds apply).`,
  options: { ...APP_OPTION },
  max: 0,
  async run(ctx, { values }) {
    const apps = (await appIdsOf(ctx, values))?.join(",");
    const r = await ctx.api.get<{ currency: string; items: AcquisitionCampaign[] }>("/acquisition/campaigns", { apps });
    if (ctx.json) return printJson(r);
    if (!r.items.length) {
      println(c.gray("No campaign tokens in Apple's reports yet. Tag App Store links with a campaign token:"));
      println(c.gray(`  ${campaignLink(null, "<campaign>")}`));
      return;
    }
    const names = await appNamesOf(ctx);
    println(
      table(
        [
          { header: "CAMPAIGN", flex: true },
          { header: "APP", flex: true },
          { header: "FIRST SEEN" },
          { header: "LAST SEEN" },
          { header: "IMPRESSIONS", align: "right" },
          { header: "PAGE VIEWS", align: "right" },
          { header: "DOWNLOADS", align: "right" },
          { header: "REDOWNLOADS", align: "right" },
          { header: "PROCEEDS", align: "right" },
        ],
        r.items.map((i) => [
          i.campaign || c.gray("(none)"),
          names.get(i.appId) ?? i.appId,
          i.firstSeen,
          i.lastSeen,
          fmtNum(i.impressions),
          fmtNum(i.pageViews),
          fmtNum(i.downloads),
          fmtNum(i.redownloads),
          fmtMoney(i.proceeds, r.currency),
        ]),
      ),
    );
  },
};

export const acquisitionStatus: Command = {
  name: "acquisition status",
  summary: "Per app: App Analytics report request state, newest report imported, data range, error.",
  options: { ...APP_OPTION },
  max: 0,
  async run(ctx, { values }) {
    const apps = (await appIdsOf(ctx, values))?.join(",");
    const r = await ctx.api.get<{ items: AcquisitionStatus[] }>("/acquisition/status", { apps });
    if (ctx.json) return printJson(r);
    if (!r.items.length) return println(c.gray("No apps."));
    const names = await appNamesOf(ctx);
    println(
      table(
        [{ header: "APP", flex: true }, { header: "STATE" }, { header: "REQUESTED" }, { header: "CHECKED" }, { header: "LAST REPORT" }, { header: "DATA" }, { header: "ERROR", flex: true }],
        r.items.map((s) => [
          names.get(s.appId) ?? s.appId,
          fmtStatus(s.state),
          s.requestedAt ? fmtRelative(s.requestedAt) : "",
          s.checkedAt ? fmtRelative(s.checkedAt) : "",
          s.lastProcessingDate ?? "",
          s.firstDay ? `${s.firstDay} → ${s.lastDay}` : "",
          s.error ? c.red(s.error) : "",
        ]),
      ),
    );
    if (r.items.some((s) => s.state === "none" || s.state === "failed")) println("", c.gray("Request the reports: revflare acquisition requests (failed ones: --retry)"));
    else if (r.items.some((s) => s.state === "requested")) println("", c.gray("Apple produces the first reports 1–2 days after the request."));
  },
};

export interface RequestsResult {
  created: { appId: string; name: string }[];
  existing: { appId: string; name: string }[];
  failed: { appId: string; name: string; error: string }[];
  remaining: number;
  error?: string;
}

const MAX_REQUEST_CALLS = 20;

export const acquisitionRequests: Command = {
  name: "acquisition requests",
  summary: "Ask Apple for each app's App Analytics reports (needs an App Store Connect key with the Admin role).",
  description:
    "Creates (or finds) the ongoing App Analytics report request of each app; Apple produces the first reports 1–2 days\n" +
    "later and Revflare imports them on its own. Needs an App Store Connect key with the Admin role (reading the reports\n" +
    "works with Sales: the optional appstore_reports credential is used first). Several calls are made while apps remain.",
  options: { ...APP_OPTION, retry: { type: "boolean", description: "Also retry apps whose request failed before" } },
  max: 0,
  async run(ctx, { values }) {
    const appIds = await appIdsOf(ctx, values);
    const all: RequestsResult = { created: [], existing: [], failed: [], remaining: 0 };
    for (let i = 0; i < MAX_REQUEST_CALLS; i++) {
      const r = await ctx.api.post<RequestsResult>("/acquisition/requests", { appIds, retry: Boolean(values.retry) });
      all.created.push(...r.created);
      all.existing.push(...r.existing);
      all.failed.push(...r.failed);
      all.remaining = r.remaining;
      if (r.error) all.error = r.error;
      if (r.remaining <= 0 || r.error || !(r.created.length + r.existing.length + r.failed.length)) break;
    }
    const seen = new Set<string>();
    const fresh = <T extends { appId: string }>(xs: T[]) => xs.filter((a) => !seen.has(a.appId) && !!seen.add(a.appId));
    all.created = fresh(all.created);
    all.existing = fresh(all.existing);
    all.failed = fresh(all.failed);
    if (ctx.json) return printJson(all);
    for (const a of all.created) println(`${c.green("✓")} ${a.name} ${c.gray("requested")}`);
    for (const a of all.existing) println(`${c.green("✓")} ${a.name} ${c.gray("already requested")}`);
    for (const a of all.failed) println(`${c.red("✗")} ${a.name}: ${a.error}`);
    if (all.error) println(c.red(all.error));
    if (!all.created.length && !all.existing.length && !all.failed.length && !all.error) println(c.gray("No app to request (apps need an App Store id)."));
    if (all.remaining > 0) println(c.yellow(`${all.remaining} app(s) left: run the command again.`));
    if (all.created.length) println(c.gray("Apple produces the first reports 1–2 days after the request; Revflare imports them on its own."));
  },
};

export const acquisitionImport: Command = {
  name: "acquisition import",
  summary: "Import every App Analytics report Apple has now (a background job: requests, then report instances).",
  max: 0,
  async run(ctx) {
    const r = await ctx.api.post<{ id: string; reused: boolean }>("/imports/acquisition");
    if (ctx.json) return printJson(r);
    println(`${c.green("✓")} Job ${r.id} ${r.reused ? "already running" : "started"}. Follow it: revflare jobs show ${r.id}`);
  },
};
