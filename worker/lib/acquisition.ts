// Read side of App Store acquisition (Apple's App Analytics reports, imported by worker/apple/analytics.ts): totals and
// groups by day / app / source type / referrer / campaign, campaign tokens, and the report request state per app.
// Reads go through the workspace's versioned cache (imports bump it).

import type { Acquisition, AcquisitionCampaign, AcquisitionDimension, AcquisitionMetrics, AcquisitionRow, AcquisitionStatus } from "../../shared/types";
import { REPORT_KINDS } from "../apple/analytics";
import { defineDbFunction, type Db } from "./db";
import { cachedFn, workspaceCurrency, type Scope } from "./metrics";
import { parseJson } from "./util";

export const ACQUISITION_DIMENSIONS: AcquisitionDimension[] = ["day", "app", "source", "referrer", "campaign"];

const COLUMN: Record<AcquisitionDimension, { sql: string; key: keyof AcquisitionRow }> = {
  day: { sql: "day", key: "day" },
  app: { sql: "app_id", key: "appId" },
  source: { sql: "source_type", key: "sourceType" },
  referrer: { sql: "source_info", key: "referrer" },
  campaign: { sql: "campaign", key: "campaign" },
};

const SUMS = `SUM(impressions) AS impressions, SUM(impressions_unique) AS impressions_unique, SUM(page_views) AS page_views,
  SUM(page_views_unique) AS page_views_unique, SUM(downloads) AS downloads, SUM(redownloads) AS redownloads, SUM(purchases) AS purchases,
  SUM(proceeds_usd) AS proceeds_usd, SUM(sales_usd) AS sales_usd`;

interface SumRow {
  impressions: number;
  impressions_unique: number;
  page_views: number;
  page_views_unique: number;
  downloads: number;
  redownloads: number;
  purchases: number;
  proceeds_usd: number;
  sales_usd: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function metricsOf(r: SumRow, rate: number): AcquisitionMetrics {
  const views = r.page_views_unique || r.page_views;
  return {
    impressions: r.impressions ?? 0,
    impressionsUnique: r.impressions_unique ?? 0,
    pageViews: r.page_views ?? 0,
    pageViewsUnique: r.page_views_unique ?? 0,
    downloads: r.downloads ?? 0,
    redownloads: r.redownloads ?? 0,
    conversionRate: views ? Math.round((r.downloads / views) * 10000) / 10000 : null,
    purchases: r.purchases ?? 0,
    proceeds: round2((r.proceeds_usd ?? 0) * rate),
    sales: round2((r.sales_usd ?? 0) * rate),
  };
}

const appFilter = (appIds: string[] | null | undefined) => (appIds?.length ? ` AND app_id IN (${appIds.map(() => "?").join(",")})` : "");

/**
 * Totals and groups for a range. Grouping by referrer or campaign reads the Detailed reports (Apple leaves out small
 * rows there); everything else the Standard ones.
 */
export const acquisition = cachedFn(
  "acquisition",
  async (db, args: Scope & { from: string; to: string; by: AcquisitionDimension[]; limit?: number }): Promise<Acquisition> => {
    const { currency, rate } = await workspaceCurrency(db, args);
    const by = ACQUISITION_DIMENSIONS.filter((d) => args.by.includes(d));
    const detailed = by.includes("referrer") || by.includes("campaign") ? 1 : 0;
    const apps = args.appIds?.slice(0, 90) ?? [];
    const where = `workspace_id = ? AND detailed = ? AND day >= ? AND day <= ?${appFilter(apps)}`;
    const params = [args.workspaceId, detailed, args.from, args.to, ...apps];
    const cols = by.map((d) => COLUMN[d].sql);
    const { results } = await db
      .prepare(`SELECT ${[...cols, SUMS].join(", ")} FROM acquisition_daily WHERE ${where}${cols.length ? ` GROUP BY ${cols.join(", ")}` : ""}`)
      .bind(...params)
      .all<SumRow & Record<string, string>>();
    const total: SumRow = { impressions: 0, impressions_unique: 0, page_views: 0, page_views_unique: 0, downloads: 0, redownloads: 0, purchases: 0, proceeds_usd: 0, sales_usd: 0 };
    for (const r of results) for (const k of Object.keys(total) as (keyof SumRow)[]) total[k] += r[k] ?? 0;
    const rows: AcquisitionRow[] = cols.length
      ? results.map((r) => {
          const row: AcquisitionRow = metricsOf(r, rate);
          for (const d of by) (row as unknown as Record<string, string>)[COLUMN[d].key] = r[COLUMN[d].sql] ?? "";
          return row;
        })
      : [];
    rows.sort((a, b) => (a.day && b.day && a.day !== b.day ? a.day.localeCompare(b.day) : b.downloads - a.downloads || b.pageViews - a.pageViews || b.impressions - a.impressions));
    const span = await db
      .prepare(`SELECT MIN(day) AS first, MAX(day) AS last FROM acquisition_daily WHERE workspace_id = ? AND detailed = 0${appFilter(apps)}`)
      .bind(args.workspaceId, ...apps)
      .first<{ first: string | null; last: string | null }>();
    return {
      currency,
      from: args.from,
      to: args.to,
      by,
      level: detailed ? "detailed" : "standard",
      totals: metricsOf(total, rate),
      rows: args.limit ? rows.slice(0, args.limit) : rows,
      firstDay: span?.first ?? null,
      lastDay: span?.last ?? null,
    };
  },
);

/** Campaign tokens Apple reported (Detailed reports), all time, per app; most downloads first. */
export const acquisitionCampaigns = cachedFn("acquisitionCampaigns", async (db, args: Scope): Promise<{ currency: string; items: AcquisitionCampaign[] }> => {
  const { currency, rate } = await workspaceCurrency(db, args);
  const apps = args.appIds?.slice(0, 90) ?? [];
  const { results } = await db
    .prepare(
      `SELECT d.app_id, a.apple_app_id, d.campaign, MIN(d.day) AS first_seen, MAX(d.day) AS last_seen, ${SUMS.replace(/SUM\(/g, "SUM(d.")}
       FROM acquisition_daily d JOIN apps a ON a.id = d.app_id
       WHERE d.workspace_id = ? AND d.campaign != ''${apps.length ? ` AND d.app_id IN (${apps.map(() => "?").join(",")})` : ""}
       GROUP BY d.app_id, d.campaign`,
    )
    .bind(args.workspaceId, ...apps)
    .all<SumRow & { app_id: string; apple_app_id: string | null; campaign: string; first_seen: string; last_seen: string }>();
  const items = results
    .map((r) => {
      const m = metricsOf(r, rate);
      return {
        campaign: r.campaign,
        appId: r.app_id,
        appleAppId: r.apple_app_id,
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
        impressions: m.impressions,
        pageViews: m.pageViews,
        downloads: m.downloads,
        redownloads: m.redownloads,
        purchases: m.purchases,
        proceeds: m.proceeds,
      };
    })
    .sort((a, b) => b.downloads - a.downloads || b.lastSeen.localeCompare(a.lastSeen) || a.campaign.localeCompare(b.campaign));
  return { currency, items };
});

/** Report request state per app (all apps of the workspace with an App Store id, or the given ones). */
export const acquisitionStatus = defineDbFunction("acquisitionStatus", async (db, args: Scope) => ({ items: await acquisitionStatusLocal(db, args) }));

export async function acquisitionStatusLocal(db: Db, args: Scope): Promise<AcquisitionStatus[]> {
  const apps = args.appIds?.slice(0, 90) ?? [];
  const { results } = await db
    .prepare(
      `SELECT a.id, a.apple_app_id, r.request_id, r.state, r.error, r.reports, r.created_at, r.checked_at,
         (SELECT MAX(processing_date) FROM acquisition_instances i WHERE i.app_id = a.id AND i.report = 'downloads') AS last_processing_date,
         (SELECT MIN(day) FROM acquisition_daily d WHERE d.app_id = a.id AND d.report = 'downloads' AND d.detailed = 0) AS first_day,
         (SELECT MAX(day) FROM acquisition_daily d WHERE d.app_id = a.id AND d.report = 'downloads' AND d.detailed = 0) AS last_day
       FROM apps a LEFT JOIN acquisition_requests r ON r.app_id = a.id
       WHERE a.workspace_id = ? AND (a.apple_app_id IS NOT NULL OR r.app_id IS NOT NULL)${apps.length ? ` AND a.id IN (${apps.map(() => "?").join(",")})` : " AND a.archived = 0"}
       ORDER BY a.name`,
    )
    .bind(args.workspaceId, ...apps)
    .all<{
      id: string;
      apple_app_id: string | null;
      request_id: string | null;
      state: AcquisitionStatus["state"] | null;
      error: string | null;
      reports: string | null;
      created_at: number | null;
      checked_at: number | null;
      last_processing_date: string | null;
      first_day: string | null;
      last_day: string | null;
    }>();
  return results.map((r) => {
    const reports = parseJson<Record<string, string>>(r.reports, {});
    return {
      appId: r.id,
      appleAppId: r.apple_app_id,
      state: r.state ?? "none",
      requestId: r.request_id,
      requestedAt: r.created_at,
      checkedAt: r.checked_at,
      reports: REPORT_KINDS.filter((k) => reports[k]),
      lastProcessingDate: r.last_processing_date,
      firstDay: r.first_day,
      lastDay: r.last_day,
      error: r.error,
    };
  });
}
