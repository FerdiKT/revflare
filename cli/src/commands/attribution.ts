import { readFileSync } from "node:fs";
import { str } from "../args.js";
import type { Command, Ctx } from "../context.js";
import { CliError, UsageError } from "../errors.js";
import { readStdin } from "../io.js";
import { c, eprintln, fmtMoney, fmtNum, fmtPct, println, printJson, table } from "../format.js";
import { resolveApp } from "../resolve.js";
import type { AdsName, AdsNameKind, AdsNames, AdsNamesUpdate, App, AttributedRevenue } from "../types.js";
import { APP_OPTION, CURRENCY_OPTION, RANGE_OPTIONS, rangeQuery, scopeQuery } from "./common.js";

export type AttributionLevel = "campaign" | "adgroup" | "keyword";

export interface AttributionTotals {
  revenue: number;
  proceeds: number;
  transactions: number;
  trials: number;
  installs: number;
  payers: number;
  /** Revenue / installs (null without installs). */
  revenuePerInstall: number | null;
}

export interface AttributionGroup extends AttributionTotals {
  campaignId: string;
  campaignName: string | null;
  adGroupId?: string | null;
  adGroupName?: string | null;
  keywordId?: string | null;
  keywordName?: string | null;
  /** Test data (with --include-test): Apple's test attribution, a sandbox / Xcode build or a test device. */
  test?: boolean;
  appIds: string[];
}

const zero = () => ({ revenue: 0, proceeds: 0, transactions: 0, trials: 0, installs: 0, payers: 0 });
const round2 = (n: number) => Math.round(n * 100) / 100;

function finish<T extends ReturnType<typeof zero>>(t: T): T & { revenuePerInstall: number | null } {
  return { ...t, revenue: round2(t.revenue), proceeds: round2(t.proceeds), revenuePerInstall: t.installs ? round2(t.revenue / t.installs) : null };
}

/** Sums the API's per-day rows by campaign, ad group (within its campaign) or keyword (within its ad group); biggest revenue first. Test rows stay apart. */
export function aggregateAttribution(rows: AttributedRevenue["rows"], by: AttributionLevel): { groups: AttributionGroup[]; totals: AttributionTotals } {
  type G = ReturnType<typeof zero> & Omit<AttributionGroup, keyof AttributionTotals | "appIds"> & { apps: Set<string> };
  const groups = new Map<string, G>();
  const totals = zero();
  for (const r of rows) {
    const base = by === "campaign" ? r.campaignId : by === "adgroup" ? `${r.campaignId}|${r.adGroupId ?? ""}` : `${r.campaignId}|${r.adGroupId ?? ""}|${r.keywordId ?? ""}`;
    const key = `${r.test ? "test|" : ""}${base}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        campaignId: r.campaignId,
        campaignName: r.campaignName ?? null,
        ...(by !== "campaign" ? { adGroupId: r.adGroupId, adGroupName: r.adGroupName ?? null } : {}),
        ...(by === "keyword" ? { keywordId: r.keywordId, keywordName: r.keywordName ?? null } : {}),
        ...(r.test ? { test: true } : {}),
        apps: new Set(),
        ...zero(),
      };
      groups.set(key, g);
    }
    for (const t of [g, totals]) {
      t.revenue += r.revenue;
      t.proceeds += r.proceeds;
      t.transactions += r.transactions;
      t.trials += r.trials;
      t.installs += r.installs;
      t.payers += r.payers;
    }
    g.apps.add(r.appId);
  }
  const list = [...groups.values()]
    .map(({ apps, ...g }) => ({ ...finish(g), appIds: [...apps] }))
    .sort((a, b) => b.revenue - a.revenue || b.installs - a.installs || a.campaignId.localeCompare(b.campaignId));
  return { groups: list, totals: finish(totals) };
}

/** "Brand Search (123)" when the name is known, else the id. */
const named = (id: string | null | undefined, name: string | null | undefined) => (id ? (name ? `${name} (${id})` : id) : null);

const LEVELS: Record<string, AttributionLevel> = { campaign: "campaign", campaigns: "campaign", adgroup: "adgroup", "ad-group": "adgroup", adgroups: "adgroup", keyword: "keyword", keywords: "keyword" };

const NAME_KINDS: AdsNameKind[] = ["campaign", "adgroup", "keyword"];

function nameKind(raw: string): AdsNameKind | null {
  const k = raw.trim().toLowerCase().replace(/[\s_-]/g, "").replace(/s$/, "");
  return (NAME_KINDS as string[]).includes(k) ? (k as AdsNameKind) : null;
}

/** One CSV line (double quotes allowed). */
function csvCells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Names to import: JSON (a list of { kind, id, name } or { names: [...] }) or CSV / TSV lines `kind,id,name` (an optional
 * header line `kind,...` is skipped). kind: campaign, adgroup (ad group, ad_group) or keyword; an empty name deletes.
 */
export function parseNamesFile(text: string): AdsName[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith("[") || t.startsWith("{")) {
    let j: unknown;
    try {
      j = JSON.parse(t);
    } catch (err) {
      throw new CliError(`Invalid JSON: ${(err as Error).message}`);
    }
    const list = Array.isArray(j) ? j : (j as { names?: unknown }).names;
    if (!Array.isArray(list)) throw new CliError("JSON must be a list of { kind, id, name } (or { names: [...] })");
    return list.map((e: Record<string, unknown>, i) => {
      const kind = nameKind(String(e?.kind ?? ""));
      const id = String(e?.id ?? "").trim();
      if (!kind || !/^\d{1,20}$/.test(id)) throw new CliError(`Entry ${i + 1}: expected kind (campaign, adgroup, keyword), id (digits) and name`);
      return { kind, id, name: String(e.name ?? "").trim() };
    });
  }
  const out: AdsName[] = [];
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  for (const [i, line] of lines.entries()) {
    const tsv = line.includes("\t");
    const cells = tsv ? line.split("\t") : csvCells(line);
    if (i === 0 && cells[0]?.trim().toLowerCase() === "kind") continue;
    const kind = nameKind(cells[0] ?? "");
    const id = (cells[1] ?? "").trim();
    if (!kind || !/^\d{1,20}$/.test(id)) throw new CliError(`Line ${i + 1}: expected kind (campaign, adgroup, keyword), id (digits), name`);
    out.push({ kind, id, name: cells.slice(2).join(tsv ? "\t" : ",").trim() });
  }
  return out;
}

async function namesCommand(ctx: Ctx, positionals: string[]) {
  const action = positionals[1] ?? "list";
  if (action === "list") {
    if (positionals.length > 2) throw new UsageError("Usage: revflare attribution names [list | import <file|->]");
    const r = await ctx.api.get<AdsNames>("/attribution/names");
    if (ctx.json) return printJson(r);
    if (!r.names.length) {
      println("No Apple Ads names yet. A connected Adsflare fills them; or: revflare attribution names import names.csv (kind,id,name).");
      return;
    }
    println(table([{ header: "KIND" }, { header: "ID" }, { header: "NAME", flex: true }], r.names.map((n) => [n.kind, n.id, n.name])));
    return;
  }
  if (action !== "import") throw new UsageError(`Unknown action "${action}": use revflare attribution names [list | import <file|->]`);
  const source = positionals[2];
  if (!source || positionals.length > 3) throw new UsageError("Usage: revflare attribution names import <file|-> (CSV / TSV kind,id,name or JSON)");
  let text: string | null;
  if (source === "-") {
    text = await (ctx.deps.readStdin ?? readStdin)(false);
    if (!text?.trim()) throw new UsageError("names import -: nothing on stdin");
  } else {
    try {
      text = readFileSync(source, "utf8");
    } catch (err) {
      throw new CliError(`Cannot read ${source}: ${(err as Error).message}`);
    }
  }
  const names = parseNamesFile(text);
  if (!names.length) throw new CliError(`${source === "-" ? "stdin" : source} holds no names`);
  let updated = 0;
  let deleted = 0;
  for (let i = 0; i < names.length; i += ADS_NAMES_LIMIT) {
    const r = await ctx.api.put<AdsNamesUpdate>("/attribution/names", { names: names.slice(i, i + ADS_NAMES_LIMIT) });
    updated += r.updated;
    deleted += r.deleted;
  }
  if (ctx.json) return printJson({ names: names.length, updated, deleted });
  println(`${c.green("✓")} ${fmtNum(names.length)} names read: ${fmtNum(updated)} saved, ${fmtNum(deleted)} removed, ${fmtNum(names.length - updated - deleted)} unchanged`);
}

/** Names per PUT request (the server's limit). */
const ADS_NAMES_LIMIT = 1000;

export const attribution: Command = {
  name: "attribution",
  args: "[names [list | import <file|->]]",
  summary: "Apple Ads revenue (RevflareKit attribution) by campaign, ad group or keyword: revenue, installs, payers, revenue per install; names.",
  description:
    "Revenue of installs Apple attributed to Apple Ads, from RevflareKit in the app, with campaign / ad group / keyword names\n" +
    "when Revflare knows them (a connected Adsflare fills them; or revflare attribution names import <file>). Revenue counts on\n" +
    "the purchase day, installs on the day they reported. Coverage = installs that reported to RevflareKit and the share Apple\n" +
    "attributed to Apple Ads. Apple's test attribution (AdServices test payload), sandbox / Xcode builds and test devices are\n" +
    "left out unless --include-test. --json prints the aggregated groups; --raw the API's per-day rows.\n" +
    "names: list the stored names; names import <file|->: CSV / TSV lines kind,id,name (kind: campaign, adgroup, keyword) or\n" +
    "JSON [{ kind, id, name }]; an empty name removes one. Only changed names are written.",
  options: {
    ...RANGE_OPTIONS,
    by: { type: "string", short: "b", arg: "<campaign|adgroup|keyword>", description: "Group rows by (default campaign)" },
    ...APP_OPTION,
    ...CURRENCY_OPTION,
    "include-test": { type: "boolean", description: "Count test data (test attribution, sandbox / Xcode builds, test devices), flagged" },
    raw: { type: "boolean", description: "With --json: the API response (per day, app, campaign, ad group, keyword)" },
  },
  max: 3,
  examples: [
    "revflare attribution",
    "revflare attribution --range 90d --by keyword",
    "revflare attribution --app com.example.app --by adgroup --json",
    "revflare attribution --include-test",
    "revflare attribution names",
    "revflare attribution names import names.csv",
  ],
  async run(ctx, { values, positionals }) {
    if (positionals.length) {
      if (positionals[0] !== "names") throw new UsageError(`Unknown subcommand "${positionals[0]}": use revflare attribution [names [list | import <file|->]]`);
      return namesCommand(ctx, positionals);
    }
    const byFlag = str(values.by) ?? "campaign";
    const by = LEVELS[byFlag.toLowerCase()];
    if (!by) throw new UsageError(`Invalid --by "${byFlag}": use campaign, adgroup or keyword`);
    const q: Record<string, string | undefined> = { ...rangeQuery(values), ...(await scopeQuery(ctx, values)) };
    if (!q.range && !q.from) q.range = "28d";
    if (values["include-test"]) q.includeTest = "true";
    const d = await ctx.api.get<AttributedRevenue>("/revenue/attributed", q);
    if (ctx.json && values.raw) return printJson(d);
    const { groups, totals } = aggregateAttribution(d.rows, by);
    const share = d.coverage.installs ? d.coverage.attributed / d.coverage.installs : null;
    if (ctx.json) return printJson({ currency: d.currency, from: d.from, to: d.to, by, ...(d.includeTest ? { includeTest: true } : {}), coverage: { ...d.coverage, share: share === null ? null : Math.round(share * 10000) / 10000 }, totals, groups });

    println(`${c.bold("Apple Ads attribution")}  ${d.from} → ${d.to}  ${c.gray(`by ${by === "adgroup" ? "ad group" : by}, ${d.currency}`)}${d.includeTest ? `  ${c.yellow("test data included")}` : ""}`);
    const testNote = d.coverage.testInstalls ? ` (${fmtNum(d.coverage.testInstalls)} test ${d.coverage.testInstalls === 1 ? "install" : "installs"} ${d.includeTest ? "included" : "hidden"})` : "";
    if (!d.rows.length) {
      println(
        d.coverage.installs
          ? `No Apple Ads installs in this range (${fmtNum(d.coverage.installs)} installs reported to RevflareKit)${testNote}.`
          : `No installs reported yet${testNote}. Add RevflareKit to the app and call Revflare.configure(sdkKey:server:) at launch\n(the key: revflare sdk-key <app>). StoreKit 2 purchases: .appAccountToken(Revflare.installId).`,
      );
      return;
    }
    const appIds = new Set(d.rows.map((r) => r.appId));
    const names = appIds.size > 1 ? new Map((await ctx.apps()).items.map((a) => [a.id, a.name])) : null;
    const m = (n: number) => fmtMoney(n, d.currency);
    const idCols = [{ header: "CAMPAIGN" }, ...(by !== "campaign" ? [{ header: "AD GROUP" }] : []), ...(by === "keyword" ? [{ header: "KEYWORD" }] : [])];
    println(
      table(
        [
          ...idCols,
          ...(names ? [{ header: "APP", flex: true }] : []),
          { header: "REVENUE", align: "right" },
          { header: "PROCEEDS", align: "right" },
          { header: "TXNS", align: "right" },
          { header: "TRIALS", align: "right" },
          { header: "INSTALLS", align: "right" },
          { header: "PAYERS", align: "right" },
          { header: "REV/INSTALL", align: "right" },
        ],
        groups.map((g) => [
          `${named(g.campaignId, g.campaignName)}${g.test ? ` ${c.yellow("[test]")}` : ""}`,
          ...(by !== "campaign" ? [named(g.adGroupId, g.adGroupName) ?? c.gray("(none)")] : []),
          ...(by === "keyword" ? [named(g.keywordId, g.keywordName) ?? c.gray("(none)")] : []),
          ...(names ? [g.appIds.map((id) => names.get(id) ?? id).join(", ")] : []),
          m(g.revenue),
          m(g.proceeds),
          fmtNum(g.transactions),
          fmtNum(g.trials),
          fmtNum(g.installs),
          fmtNum(g.payers),
          g.revenuePerInstall === null ? "-" : m(g.revenuePerInstall),
        ]),
      ),
    );
    println("");
    println(
      `${c.bold("Total")} ${m(totals.revenue)} revenue, ${m(totals.proceeds)} proceeds  ${c.gray(`${fmtNum(totals.transactions)} transactions · ${fmtNum(totals.trials)} trials · ${fmtNum(totals.installs)} installs · ${fmtNum(totals.payers)} payers`)}${totals.revenuePerInstall !== null ? `  ${m(totals.revenuePerInstall)}/install` : ""}`,
    );
    println(`${c.bold("Coverage")} ${fmtNum(d.coverage.attributed)} of ${fmtNum(d.coverage.installs)} reporting installs came from Apple Ads${share !== null ? ` (${fmtPct(share, 1)})` : ""}${testNote}`);
    if (d.rows.some((r) => !r.campaignName)) println(c.gray("Unnamed ids: connect Adsflare, or revflare attribution names import <file> (kind,id,name)."));
  },
};

async function getApp(ctx: Parameters<Command["run"]>[0], selector: string): Promise<App> {
  const a = resolveApp(selector, (await ctx.apps()).items);
  return ctx.api.get<App>(`/apps/${encodeURIComponent(a.id)}`);
}

export const sdkKey: Command = {
  name: "sdk-key",
  args: "<app>",
  summary: "The app's public RevflareKit SDK key (Apple Ads attribution); --rotate --yes replaces it.",
  description:
    "RevflareKit embeds this key: Revflare.configure(sdkKey: \"<key>\", server: <your Revflare URL>).\nIt is public (it ships inside the app) and only lets " +
    "installs report attribution for this app. Rotating makes the old key stop working at once: installs of app versions\n" +
    "that embed it can no longer report, so ship an update with the new key first (rotate only if the key leaked).",
  options: {
    rotate: { type: "boolean", description: "Replace the key (the old one stops working; needs --yes)" },
    yes: { type: "boolean", short: "y", description: "Confirm --rotate" },
  },
  min: 1,
  max: 1,
  examples: ["revflare sdk-key com.example.app", "revflare sdk-key com.example.app --rotate --yes"],
  async run(ctx, { values, positionals }) {
    const app = await getApp(ctx, positionals[0]);
    if (values.rotate) {
      if (!values.yes) throw new UsageError(`Rotating ${app.name}'s SDK key makes the current one stop working at once (app versions that embed it can no longer report). Add --yes to confirm.`);
      const r = await ctx.api.post<{ sdkKey: string }>(`/apps/${encodeURIComponent(app.id)}/sdk-key`);
      if (ctx.json) return printJson({ appId: app.id, sdkKey: r.sdkKey, previous: app.sdkKey, rotated: true });
      println(r.sdkKey);
      eprintln(c.gray(`${app.sdkKey ? `Rotated: ${app.sdkKey} no longer works.` : "Created."} Put the new key in Revflare.configure(sdkKey:server:) and ship an update.`));
      return;
    }
    if (ctx.json) return printJson({ appId: app.id, sdkKey: app.sdkKey });
    if (!app.sdkKey) throw new CliError(`${app.name} has no SDK key yet: create one with revflare sdk-key ${positionals[0]} --rotate --yes`);
    println(app.sdkKey);
  },
};
