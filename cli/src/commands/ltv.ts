import { str } from "../args.js";
import type { Command } from "../context.js";
import { UsageError } from "../errors.js";
import { c, fmtMoney, fmtNum, fmtPct, printJson, println, table } from "../format.js";
import { LTV_DIMENSIONS, type Ltv, type LtvDimension, type LtvGroup, type LtvHorizon, type LtvSummary } from "../types.js";
import { APP_OPTION, CURRENCY_OPTION, RANGE_OPTIONS, rangeQuery, scopeQuery } from "./common.js";

const BY_ALIASES: Record<string, LtvDimension> = { "ad-group": "adgroup", adgroups: "adgroup", campaigns: "campaign", keywords: "keyword", countries: "country", sources: "source" };
const SUMMARY_DAYS = [7, 30, 90];

/** Readable group name: Apple Ads / Organic, campaign 501, ad group 501/601, keyword 501/601/701, country. */
export function ltvGroupLabel(g: LtvGroup): string {
  if (g.group === "apple_ads") return "Apple Ads";
  if (g.group === "organic") return "Organic";
  if (g.group === "google_ads") return "Google Ads";
  if (g.group === "referral") return "Referral";
  if (g.group === "unknown") return "Unknown";
  return g.group;
}

const cell = (h: LtvHorizon | undefined, proceeds: boolean, currency: string) =>
  !h || h.immature ? c.gray("·") : fmtMoney(proceeds ? h.proceedsPerInstall : h.revenuePerInstall, currency);
const horizonLabel = (d: number | null) => (d === null ? "TO DATE" : `D${d}`);

export const ltv: Command = {
  name: "ltv",
  summary: "LTV by acquisition source: revenue per install at D0/D7/D30/D90/D180 per install cohort and source, campaign, ad group, keyword or country.",
  description:
    "Installs reporting to RevflareKit, grouped by the week (or day / month) they installed and by source: apple_ads or\n" +
    "organic, Apple Ads campaign / ad group / keyword (organic installs are one \"organic\" group) or country. Values are\n" +
    "revenue (or proceeds, --proceeds) per install within D0 (first 24 hours), D7, D30, D90, D180 after install and to\n" +
    "date; refunds are excluded (prorated refunds in part). \"·\" = the cohort is not that old yet. --summary: one row per\n" +
    "group, pooled over the installs old enough for each horizon (payback / ROAS inputs; default range 90d).\n" +
    "Coverage = share of the apps' paying customers linked to a reporting install. Installs whose purchases all started\n" +
    "more than 48 hours before the install (users who had the app before) are not counted. Ids are Apple Ads ids.",
  options: {
    ...RANGE_OPTIONS,
    by: { type: "string", short: "b", arg: "<source|campaign|adgroup|keyword|country>", description: "Group installs by (default source; campaign with --summary)" },
    cohort: { type: "string", arg: "<day|week|month>", description: "Install cohort size (default week)" },
    summary: { type: "boolean", short: "s", description: "Per group only, pooled over mature installs" },
    proceeds: { type: "boolean", description: "Proceeds per install instead of revenue" },
    ...APP_OPTION,
    ...CURRENCY_OPTION,
  },
  max: 0,
  examples: ["revflare ltv", "revflare ltv --by campaign --cohort month --range 12m", "revflare ltv --summary --by keyword --range 180d --json", "revflare ltv --app com.example.app --by country"],
  async run(ctx, { values }) {
    const summary = !!values.summary;
    const byFlag = (str(values.by) ?? (summary ? "campaign" : "source")).toLowerCase();
    const by = (BY_ALIASES[byFlag] ?? byFlag) as LtvDimension;
    if (!LTV_DIMENSIONS.includes(by)) throw new UsageError(`Invalid --by "${byFlag}": use ${LTV_DIMENSIONS.join(", ")}`);
    const cohort = str(values.cohort);
    if (cohort && cohort !== "day" && cohort !== "week" && cohort !== "month") throw new UsageError(`Invalid --cohort "${cohort}": use day, week or month`);
    if (cohort && summary) throw new UsageError("--cohort does not apply to --summary");
    const q = { ...rangeQuery(values), ...(await scopeQuery(ctx, values)), by, ...(cohort ? { cohort } : {}) };
    const proceeds = !!values.proceeds;
    const what = proceeds ? "proceeds" : "revenue";

    if (summary) {
      const d = await ctx.api.get<LtvSummary>("/ltv/summary", q);
      if (ctx.json) return printJson(d);
      println(`${c.bold("LTV summary")}  installs ${d.from} → ${d.to}  ${c.gray(`by ${by}, ${what} per install, ${d.currency}`)}`);
      if (!d.rows.length) return println(noInstalls(d.coverage.installs));
      const m = (n: number | null) => fmtMoney(n, d.currency);
      println(
        table(
          [
            { header: "GROUP" },
            { header: "INSTALLS", align: "right" },
            { header: "PAYERS", align: "right" },
            { header: "CONV", align: "right" },
            ...SUMMARY_DAYS.map((day) => ({ header: `D${day}`, align: "right" as const })),
            { header: "TO DATE", align: "right" },
          ],
          d.rows.map((r) => [
            ltvGroupLabel(r),
            fmtNum(r.installs),
            fmtNum(r.payers),
            fmtPct(r.conversion, 1),
            ...SUMMARY_DAYS.map((day) => {
              const h = r.horizons.find((x) => x.day === day);
              return !h || h.immature ? c.gray("·") : `${cell(h, proceeds, d.currency)} ${c.gray(`(${fmtNum(h.installs)})`)}`;
            }),
            m(r.installs ? (proceeds ? r.proceeds : r.revenue) / r.installs : null),
          ]),
        ),
      );
      println("", c.gray("Dn: pooled over installs at least n days old (their count in parentheses); · = none yet."));
      return println(coverageLine(d.coverage));
    }

    const d = await ctx.api.get<Ltv>("/ltv", q);
    if (ctx.json) return printJson(d);
    println(`${c.bold("LTV")}  installs ${d.from} → ${d.to}  ${c.gray(`${{ day: "daily", week: "weekly", month: "monthly" }[d.cohort]} cohorts by ${by}, ${what} per install, ${d.currency}`)}`);
    if (!d.rows.length) return println(noInstalls(d.coverage.installs));
    const days: (number | null)[] = [...d.horizons, null];
    println(
      table(
        [
          { header: "COHORT" },
          { header: "GROUP" },
          { header: "INSTALLS", align: "right" },
          { header: "PAYERS", align: "right" },
          ...days.map((x) => ({ header: horizonLabel(x), align: "right" as const })),
        ],
        d.rows.map((r) => [r.cohort, ltvGroupLabel(r), fmtNum(r.installs), fmtNum(r.payers), ...days.map((x) => cell(r.horizons.find((h) => h.day === x), proceeds, d.currency))]),
      ),
    );
    println("", c.gray("· = the cohort is not that old yet."));
    println(coverageLine(d.coverage));
  },
};

function noInstalls(installs: number) {
  return installs
    ? "No installs in this range."
    : "No installs reported yet. Add RevflareKit to the app and call Revflare.configure(sdkKey:server:) at launch\n(the key: revflare sdk-key <app>).";
}

function coverageLine(cov: Ltv["coverage"]) {
  return `${c.bold("Coverage")} ${fmtNum(cov.linkedCustomers)} of ${fmtNum(cov.payingCustomers)} paying customers linked to a reporting install${cov.share !== null ? ` (${fmtPct(cov.share, 1)})` : ""}  ${c.gray(`${fmtNum(cov.installs)} installs, ${fmtNum(cov.attributed)} from Apple Ads${cov.preexisting ? `, ${fmtNum(cov.preexisting)} earlier users not counted` : ""}`)}`;
}
