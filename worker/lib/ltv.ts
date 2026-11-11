// LTV by acquisition source (docs/ltv.md): installs reporting to RevflareKit, grouped by install cohort (day / week /
// month of the install time, UTC) and source (Apple Ads or organic, campaign, ad group, keyword, country), with what
// they paid in the first 0 (24 hours), 7, 30, 90 and 180 days and to date.
//
// Cost: one aggregation (attributions → install_links → transactions, plus the paying customers for the coverage)
// per workspace, app selection and install-day range, grouped by install day and every dimension at once. It is kept
// in memory for the UTC day (LTV is not a live metric): every grouping, cohort size and the summary are derived from it
// in JS, and new sales or SDK reports (which bump the data version) do not trigger a new scan before the next day.

import type { Ltv, LtvCohortUnit, LtvCoverage, LtvDimension, LtvGroup, LtvHorizon, LtvRow, LtvSummary, LtvSummaryRow } from "../../shared/types";
import { MAX_INSTALL_LEAD_MS } from "./attribution";
import type { Db } from "./db";
import { cachedFn, workspaceCurrency, type Scope } from "./metrics";
import { addDays, dayOf, dayStart, keptShareSql } from "./money";
import { excludeInstallsSql, installsEpoch, installSource, NOT_TEST_ATTRIBUTION, PRODUCTION_INSTALL, workspaceTestInstalls } from "./test-data";
import { now } from "./util";

const DAY = 86_400_000;
/** Horizons in days after install; D0 is the first 24 hours. */
export const LTV_HORIZONS = [0, 7, 30, 90, 180];
const windowDays = (h: number) => Math.max(1, h);
/** `from` is at most this many days back (about 13 months); it then moves to the start of its week or month. */
const MAX_DAYS_BACK = 396;
/**
 * A subscription or purchase that started more than this before the install time belongs to an earlier install
 * (reinstall, new device, or a user who had the app before RevflareKit): not counted. Wide enough for a first report
 * that arrives late (offline first launch) when the SDK did not send its own install time.
 */
export const GRACE_MS = 48 * 3_600_000;
const CHUNK = 90;

const KEPT = keptShareSql("t");
/** The transaction started after the install time minus the grace (a.it = install time). */
const OWN = `COALESCE(t.original_purchased_at, t.purchased_at) >= a.it - ${GRACE_MS}`;
const PAID = `t.kind != 'trial' AND t.gross_usd > 0 AND ${OWN}`;
/** A payer paid something that was not fully refunded. */
const PAYER = `${PAID} AND ${KEPT} > 0`;

/** First day of the cohort containing `day`. */
export function cohortStart(day: string, unit: LtvCohortUnit): string {
  if (unit === "day") return day;
  if (unit === "month") return `${day.slice(0, 8)}01`;
  const dow = new Date(dayStart(day)).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

/** First day after the cohort. */
export function cohortEnd(cohort: string, unit: LtvCohortUnit): string {
  if (unit === "day") return addDays(cohort, 1);
  if (unit === "week") return addDays(cohort, 7);
  const d = new Date(dayStart(cohort));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return dayOf(d.getTime());
}

/** Installs of one install day with the same source, Apple Ads ids and country, with their per-horizon sums (USD). */
interface BaseRow {
  day: string;
  attributed: number;
  /** Android installs: google_ads | referral | organic (Play Install Referrer); null otherwise. */
  referrer_source?: string | null;
  campaign_id: string | null;
  ad_group_id: string | null;
  keyword_id: string | null;
  country: string | null;
  /** 1: installs whose linked purchases all started before the install (pre-existing users), not counted. */
  pre: number;
  installs: number;
  payers: number;
  trials: number;
  revenue: number;
  proceeds: number;
  /** Per horizon (LTV_HORIZONS order): revenue, proceeds, payers. */
  [k: `r${number}` | `n${number}` | `p${number}`]: number;
}

/** The apps' paying customers by first payment day, and how many are linked to a reporting install. */
interface PaidDay {
  day: string;
  paying: number;
  linked: number;
}

interface Base {
  from: string;
  to: string;
  rows: BaseRow[];
  paid: PaidDay[];
}

/** Installs of [from, to] (install days) grouped by install day and every dimension, and the coverage counts. */
async function aggregate(db: Db, workspaceId: string, appIds: string[], from: string, to: string, testInstalls: string[]): Promise<Base> {
  const rows: BaseRow[] = [];
  const paid: PaidDay[] = [];
  const t0 = dayStart(from);
  const t1 = dayStart(addDays(to, 1));
  const perInstall = LTV_HORIZONS.flatMap((h, i) => {
    const before = `t.purchased_at < a.it + ${windowDays(h) * DAY}`;
    return [
      `SUM(CASE WHEN ${PAID} AND ${before} THEN t.gross_usd * ${KEPT} ELSE 0 END) AS r${i}`,
      `SUM(CASE WHEN ${PAID} AND ${before} THEN t.proceeds_usd * ${KEPT} ELSE 0 END) AS n${i}`,
      `MAX(CASE WHEN ${PAYER} AND ${before} THEN 1 ELSE 0 END) AS p${i}`,
    ];
  }).join(",\n           ");
  const sums = LTV_HORIZONS.flatMap((_, i) => [`SUM(r${i}) AS r${i}`, `SUM(n${i}) AS n${i}`, `SUM(p${i}) AS p${i}`]).join(", ");
  // Production installs only (NULL: reported before RevflareKit sent its environment), test devices and Apple's test
  // attribution left out.
  const counted = (alias: string) => `${PRODUCTION_INSTALL(alias)} AND ${NOT_TEST_ATTRIBUTION(alias)}${excludeInstallsSql(`${alias}.install_id`, testInstalls)}`;
  for (let i = 0; i < appIds.length; i += CHUNK) {
    const apps = appIds.slice(i, i + CHUNK);
    const list = apps.map(() => "?").join(",");
    // The install time is the SDK's own (installed_at, never after the first report) or the first report: the range
    // is read on created_at (indexed), at most MAX_INSTALL_LEAD_MS after the install time.
    const { results } = await db
      .prepare(
        `SELECT day, attributed, referrer_source, campaign_id, ad_group_id, keyword_id, country, pre, COUNT(*) AS installs, SUM(paid) AS payers, SUM(trial) AS trials,
           SUM(revenue) AS revenue, SUM(proceeds) AS proceeds, ${sums}
         FROM (
           SELECT date(a.it / 1000, 'unixepoch') AS day, a.attributed, CASE WHEN a.attributed = 1 THEN NULL ELSE a.referrer_source END AS referrer_source,
           CASE WHEN a.attributed = 1 THEN a.campaign_id END AS campaign_id,
           CASE WHEN a.attributed = 1 THEN a.ad_group_id END AS ad_group_id,
           CASE WHEN a.attributed = 1 THEN a.keyword_id END AS keyword_id,
           COALESCE(a.country, a.install_country) AS country,
           CASE WHEN COUNT(t.app_id) > 0 AND MAX(CASE WHEN ${OWN} THEN 1 ELSE 0 END) = 0 THEN 1 ELSE 0 END AS pre,
           SUM(CASE WHEN ${PAID} THEN t.gross_usd * ${KEPT} ELSE 0 END) AS revenue,
           SUM(CASE WHEN ${PAID} THEN t.proceeds_usd * ${KEPT} ELSE 0 END) AS proceeds,
           MAX(CASE WHEN ${PAYER} THEN 1 ELSE 0 END) AS paid,
           MAX(CASE WHEN t.kind = 'trial' AND ${OWN} THEN 1 ELSE 0 END) AS trial,
           ${perInstall}
           FROM (
             SELECT app_id, install_id, attributed, referrer_source, campaign_id, ad_group_id, keyword_id, country, install_country, COALESCE(installed_at, created_at) AS it
             FROM attributions
             WHERE workspace_id = ? AND created_at >= ? AND created_at < ? AND app_id IN (${list}) AND ${counted("attributions")}
           ) a
           LEFT JOIN install_links l ON l.app_id = a.app_id AND l.install_id = a.install_id
           LEFT JOIN transactions t ON t.app_id = l.app_id AND t.original_transaction_id = l.original_transaction_id AND t.environment = 'Production'
           WHERE a.it >= ? AND a.it < ?
           GROUP BY a.app_id, a.install_id
         )
         GROUP BY day, attributed, referrer_source, campaign_id, ad_group_id, keyword_id, country, pre`,
      )
      .bind(workspaceId, t0, t1 + MAX_INSTALL_LEAD_MS, ...apps, t0, t1)
      .all<BaseRow>();
    rows.push(...results);
    // Coverage: a customer is linked when one of its transactions is linked to a reporting install and passes the
    // grace rule (the same transactions the values count).
    const cov = await db
      .prepare(
        `SELECT date(c.first_paid_at / 1000, 'unixepoch') AS day, COUNT(*) AS paying,
           SUM(EXISTS (
             SELECT 1 FROM transactions t
             JOIN install_links l ON l.app_id = t.app_id AND l.original_transaction_id = t.original_transaction_id
             JOIN attributions a ON a.app_id = l.app_id AND a.install_id = l.install_id
             WHERE t.customer_id = c.id AND COALESCE(t.original_purchased_at, t.purchased_at) >= COALESCE(a.installed_at, a.created_at) - ${GRACE_MS} AND ${counted("a")}
           )) AS linked
         FROM customers c WHERE c.app_id IN (${list}) AND c.first_paid_at >= ? AND c.workspace_id = ?
         GROUP BY day`,
      )
      .bind(...apps, t0, workspaceId)
      .all<PaidDay>();
    paid.push(...cov.results);
  }
  return { from, to, rows, paid };
}

// Day cache (inside the database object): bases per workspace and app selection for the UTC day, reused by any request
// whose install days they cover.
const baseCache = new Map<string, Base[]>();

async function base(db: Db, workspaceId: string, appIds: string[], from: string, to: string): Promise<Base> {
  const today = dayOf(now());
  for (const k of baseCache.keys()) if (!k.startsWith(today)) baseCache.delete(k);
  // A change of the test devices takes effect at once (they are part of the key).
  const testInstalls = appIds.length ? await workspaceTestInstalls(db, workspaceId) : [];
  // So does an install moving in or out of production (installsEpoch).
  const key = `${today}|${workspaceId}|${installsEpoch(workspaceId)}|${[...appIds].sort().join(",")}|${[...testInstalls].sort().join(",")}`;
  const list = baseCache.get(key) ?? [];
  const hit = list.find((b) => b.from <= from && b.to >= to);
  if (hit) return hit;
  const b = appIds.length ? await aggregate(db, workspaceId, appIds, from, to, testInstalls) : { from, to, rows: [], paid: [] };
  baseCache.delete(key);
  baseCache.set(key, [b, ...list.filter((x) => !(x.from >= from && x.to <= to))].slice(0, 4));
  if (baseCache.size > 50) baseCache.delete(baseCache.keys().next().value!);
  return b;
}

/** Workspace apps in the scope (an empty selection is no app). */
async function scopeApps(db: Db, scope: Scope): Promise<string[]> {
  if (scope.appIds && !scope.appIds.length) return [];
  const { results } = await db.prepare("SELECT id FROM apps WHERE workspace_id = ?").bind(scope.workspaceId).all<{ id: string }>();
  const ids = results.map((r) => r.id);
  if (!scope.appIds) return ids;
  const want = new Set(scope.appIds);
  return ids.filter((id) => want.has(id));
}

const inRange = (rows: BaseRow[], from: string, to: string) => rows.filter((r) => r.day >= from && r.day <= to);

/** Coverage of the install days [from, to]: counted installs, pre-existing ones, paying customers from `from` on. */
function coverageOf(b: Base, from: string, to: string): LtvCoverage {
  let installs = 0;
  let attributed = 0;
  let preexisting = 0;
  for (const r of inRange(b.rows, from, to)) {
    if (r.pre) preexisting += r.installs;
    else {
      installs += r.installs;
      if (r.attributed) attributed += r.installs;
    }
  }
  let paying = 0;
  let linked = 0;
  for (const p of b.paid) {
    if (p.day < from) continue;
    paying += p.paying;
    linked += p.linked ?? 0;
  }
  return { installs, attributed, preexisting, payingCustomers: paying, linkedCustomers: linked, share: paying ? Math.round((linked / paying) * 10_000) / 10_000 : null };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** The group of a base row for a dimension. */
function groupOf(r: BaseRow, by: LtvDimension): LtvGroup {
  const none: LtvGroup = { group: "organic", campaignId: null, adGroupId: null, keywordId: null, country: null };
  // Same rule as /sdk/v1/report's source (rows here carry no status: never "unknown").
  const source = installSource({ attributed: r.attributed, referrer_source: r.referrer_source });
  const ads = source === "apple_ads";
  const id = (x: string | null) => x ?? "none";
  switch (by) {
    case "source":
      return { ...none, group: source === "unknown" ? "organic" : source };
    case "campaign":
      return ads ? { ...none, group: id(r.campaign_id), campaignId: r.campaign_id } : none;
    case "adgroup":
      return ads ? { ...none, group: `${id(r.campaign_id)}/${id(r.ad_group_id)}`, campaignId: r.campaign_id, adGroupId: r.ad_group_id } : none;
    case "keyword":
      return ads
        ? { ...none, group: `${id(r.campaign_id)}/${id(r.ad_group_id)}/${id(r.keyword_id)}`, campaignId: r.campaign_id, adGroupId: r.ad_group_id, keywordId: r.keyword_id }
        : none;
    case "country":
      // Apple's country for attributed installs, else the country of the install's first report.
      return { ...none, group: r.country ?? "unknown", country: r.country };
  }
}

/** Sums of counted installs (per horizon: only the install days `mature` accepts). */
interface Acc extends LtvGroup {
  /** First day of the cohort (cohort rows only). */
  cohort?: string;
  installs: number;
  payers: number;
  trials: number;
  revenue: number;
  proceeds: number;
  h: { installs: number; revenue: number; proceeds: number; payers: number }[];
}

function accumulate(rows: BaseRow[], keyOf: (r: BaseRow) => { key: string; group: LtvGroup & { cohort?: string } }, mature: (r: BaseRow, h: number) => boolean): Map<string, Acc> {
  const out = new Map<string, Acc>();
  for (const r of rows) {
    if (r.pre) continue;
    const { key, group } = keyOf(r);
    let g = out.get(key);
    if (!g) {
      g = { ...group, installs: 0, payers: 0, trials: 0, revenue: 0, proceeds: 0, h: LTV_HORIZONS.map(() => ({ installs: 0, revenue: 0, proceeds: 0, payers: 0 })) };
      out.set(key, g);
    }
    g.installs += r.installs;
    g.payers += r.payers;
    g.trials += r.trials;
    g.revenue += r.revenue;
    g.proceeds += r.proceeds;
    LTV_HORIZONS.forEach((h, i) => {
      if (!mature(r, h)) return;
      const x = g.h[i];
      x.installs += r.installs;
      x.revenue += r[`r${i}`];
      x.proceeds += r[`n${i}`];
      x.payers += r[`p${i}`];
    });
  }
  return out;
}

const groupKey = (g: LtvGroup) => `${g.group}|${g.campaignId ?? ""}|${g.adGroupId ?? ""}|${g.keywordId ?? ""}|${g.country ?? ""}`;

/** Per group, pooled over the install days old enough for each horizon. */
function summarize(rows: BaseRow[], by: LtvDimension, rate: number, today: string): LtvSummaryRow[] {
  const groups = accumulate(
    rows,
    (r) => {
      const group = groupOf(r, by);
      return { key: groupKey(group), group };
    },
    (r, h) => addDays(r.day, 1 + windowDays(h)) <= today,
  );
  return [...groups.values()]
    .map(({ h, cohort: _, ...g }) => ({
      ...g,
      revenue: r2(g.revenue * rate),
      proceeds: r2(g.proceeds * rate),
      conversion: g.installs ? r4(g.payers / g.installs) : null,
      horizons: LTV_HORIZONS.map((day, i) =>
        h[i].installs
          ? { day, immature: false, installs: h[i].installs, revenuePerInstall: r4((h[i].revenue * rate) / h[i].installs), proceedsPerInstall: r4((h[i].proceeds * rate) / h[i].installs), payers: h[i].payers }
          : { day, immature: true, installs: 0, revenuePerInstall: null, proceedsPerInstall: null, payers: null },
      ),
    }))
    .sort((a, b) => b.installs - a.installs || b.revenue - a.revenue || (a.group < b.group ? -1 : 1));
}

interface Window {
  workspaceId: string;
  appIds?: string[] | null;
  currency?: string;
  by: LtvDimension;
  from: string;
  to: string;
}

/** Clamps [from, to] to MAX_DAYS_BACK and today. */
function clamp(from: string, to: string): { from: string; to: string } {
  const today = dayOf(now());
  const t = to > today ? today : to;
  const min = addDays(today, -MAX_DAYS_BACK);
  const f = from < min ? min : from;
  return { from: f > t ? t : f, to: t };
}

/** Base covering `from` for every cohort size (the start of its week and of its month), so changing it reuses the base. */
const baseFrom = (from: string) => [cohortStart(from, "week"), cohortStart(from, "month")].sort()[0];

/** GET /ltv: cohorts (rows) × group with revenue and proceeds per install at each horizon (and, asked, the summary of the same installs). */
export const ltv = cachedFn("ltv", async (db, args: Window & { cohort: LtvCohortUnit; summary?: boolean }): Promise<Ltv> => {
  const { currency, rate } = await workspaceCurrency(db, args);
  const c = clamp(args.from, args.to);
  const from = cohortStart(c.from, args.cohort);
  const to = c.to;
  const appIds = await scopeApps(db, args);
  const b = await base(db, args.workspaceId, appIds, baseFrom(c.from), to);
  const today = dayOf(now());
  const end = addDays(to, 1);
  const rows = inRange(b.rows, from, to);
  const groups = accumulate(
    rows,
    (r) => {
      const group = groupOf(r, args.by);
      const cohort = cohortStart(r.day, args.cohort);
      return { key: `${cohort}|${groupKey(group)}`, group: { ...group, cohort } };
    },
    () => true,
  );
  const out: LtvRow[] = [...groups.values()].map(({ h, ...g }) => {
    const cohort = g.cohort!;
    const e = cohortEnd(cohort, args.cohort);
    const last = e < end ? e : end;
    const horizons: LtvHorizon[] = LTV_HORIZONS.map((day, i) => {
      const immature = addDays(last, windowDays(day)) > today;
      return immature
        ? { day, immature, revenuePerInstall: null, proceedsPerInstall: null, payers: null }
        : { day, immature, revenuePerInstall: r4((h[i].revenue * rate) / g.installs), proceedsPerInstall: r4((h[i].proceeds * rate) / g.installs), payers: h[i].payers };
    });
    horizons.push({ day: null, immature: false, revenuePerInstall: r4((g.revenue * rate) / g.installs), proceedsPerInstall: r4((g.proceeds * rate) / g.installs), payers: g.payers });
    return {
      cohort,
      group: g.group,
      campaignId: g.campaignId,
      adGroupId: g.adGroupId,
      keywordId: g.keywordId,
      country: g.country,
      installs: g.installs,
      payers: g.payers,
      trials: g.trials,
      revenue: r2(g.revenue * rate),
      proceeds: r2(g.proceeds * rate),
      horizons,
    };
  });
  out.sort((a, b) => (a.cohort < b.cohort ? 1 : a.cohort > b.cohort ? -1 : b.installs - a.installs || (a.group < b.group ? -1 : 1)));
  return {
    currency,
    by: args.by,
    cohort: args.cohort,
    from,
    to,
    horizons: LTV_HORIZONS,
    coverage: coverageOf(b, from, to),
    rows: out,
    ...(args.summary ? { summary: summarize(rows, args.by, rate, today) } : {}),
  };
});

/**
 * GET /ltv/summary: per group, revenue and proceeds per install at each horizon pooled over the install days old
 * enough for it (what Adsflare uses for payback and ROAS).
 */
export const ltvSummary = cachedFn("ltvSummary", async (db, args: Window): Promise<LtvSummary> => {
  const { currency, rate } = await workspaceCurrency(db, args);
  const { from, to } = clamp(args.from, args.to);
  const appIds = await scopeApps(db, args);
  const b = await base(db, args.workspaceId, appIds, baseFrom(from), to);
  const today = dayOf(now());
  return { currency, by: args.by, from, to, horizons: LTV_HORIZONS, coverage: coverageOf(b, from, to), rows: summarize(inRange(b.rows, from, to), args.by, rate, today) };
});
