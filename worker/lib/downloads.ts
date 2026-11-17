// Read side of App Store downloads (Apple's Sales and Trends reports, imported by worker/apple/sales.ts into
// downloads_daily): first downloads / redownloads / updates per day, app, country and device, free vs paid, 7 / 28 / 90
// day windows, and what the downloads turned into from Revflare's own data (trials, first payments, revenue per
// download, Apple Ads installs from RevflareKit). Reads go through the workspace's versioned cache (imports bump it).

import type { DownloadApp, DownloadConversions, DownloadCountry, DownloadCounts, DownloadDay, DownloadDevice, DownloadWindow, Downloads } from "../../shared/types";
import type { Db } from "./db";
import { cachedFn, workspaceCurrency, type Scope } from "./metrics";
import { addDays, dayStart, round2 } from "./money";
import { NOT_TEST_ATTRIBUTION, PRODUCTION_INSTALL } from "./test-data";

const DAY = 86_400_000;
export const DOWNLOAD_WINDOWS = [7, 28, 90];
const CHUNK = 90;

const emptyCounts = (): DownloadCounts => ({ downloads: 0, paidDownloads: 0, redownloads: 0, updates: 0 });

function addUnits(c: DownloadCounts, kind: string, paid: number, units: number) {
  if (kind === "first") {
    c.downloads += units;
    if (paid) c.paidDownloads += units;
  } else if (kind === "redownload") c.redownloads += units;
  else if (kind === "update") c.updates += units;
}

interface Raw {
  trials: number;
  payers: number;
  revenueUsd: number;
  proceedsUsd: number;
  ads: number;
  /** First installs RevflareKit saw (the base of the Apple Ads share). */
  sdkInstalls: number;
}
const emptyRaw = (): Raw => ({ trials: 0, payers: 0, revenueUsd: 0, proceedsUsd: 0, ads: 0, sdkInstalls: 0 });

const ratio = (n: number, d: number, digits = 4) => (d > 0 ? Math.round((n / d) * 10 ** digits) / 10 ** digits : null);

function conversions(downloads: number, r: Raw, rate: number): DownloadConversions {
  const revenue = round2(r.revenueUsd * rate);
  return {
    trialsStarted: r.trials,
    newPayers: r.payers,
    revenue,
    proceeds: round2(r.proceedsUsd * rate),
    downloadToTrial: ratio(r.trials, downloads),
    downloadToPaid: ratio(r.payers, downloads),
    revenuePerDownload: downloads > 0 ? Math.round((revenue / downloads) * 1000) / 1000 : null,
    appleAdsDownloads: r.ads,
    appleAdsShare: ratio(r.ads, r.sdkInstalls),
  };
}

const daysBetween = (a: string, b: string) => Math.round((dayStart(b) - dayStart(a)) / DAY);

function window(perDay: Map<string, number>, last: string, days: number): DownloadWindow {
  let downloads = 0;
  let previous = 0;
  for (const [day, n] of perDay) {
    const age = daysBetween(day, last);
    if (age >= 0 && age < days) downloads += n;
    else if (age >= days && age < 2 * days) previous += n;
  }
  return { days, downloads, previous, change: previous > 0 ? Math.round((downloads / previous - 1) * 10000) / 10000 : null };
}

const inList = (n: number) => Array.from({ length: n }, () => "?").join(",");

/**
 * Downloads for a range. `fixedTo`: the range's end was given (to=...); otherwise a preset range ends at the newest
 * report day (Apple publishes a day's report about a day later), keeping its length.
 */
export const downloads = cachedFn("downloads", async (db: Db, args: Scope & { from: string; to: string; fixedTo?: boolean }): Promise<Downloads> => {
  const { currency, rate } = await workspaceCurrency(db, args);
  const scoped = args.appIds?.length ? args.appIds.slice(0, CHUNK) : null;
  const appSql = scoped ? ` AND app_id IN (${inList(scoped.length)})` : "";
  const appParams = scoped ?? [];

  const span = await db
    .prepare(`SELECT MIN(day) AS first, MAX(day) AS last FROM downloads_daily WHERE workspace_id = ?${appSql}`)
    .bind(args.workspaceId, ...appParams)
    .first<{ first: string | null; last: string | null }>();
  const firstDay = span?.first ?? null;
  const lastDay = span?.last ?? null;
  let { from, to } = args;
  if (!args.fixedTo && lastDay && lastDay < to) {
    const lag = daysBetween(lastDay, to);
    from = addDays(from, -lag);
    to = lastDay;
  }
  const length = daysBetween(from, to) + 1;
  const prevFrom = addDays(from, -length);
  const anchor = lastDay ?? to;
  const maxWindow = Math.max(...DOWNLOAD_WINDOWS);
  const readFrom = [prevFrom, addDays(anchor, -(2 * maxWindow - 1))].sort()[0];
  const readTo = to > anchor ? to : anchor;

  // Apps of the workspace (names, platform) -------------------------------------------------------------------------
  const { results: appRows } = await db
    .prepare(`SELECT id, name, apple_app_id, platform FROM apps WHERE workspace_id = ?${scoped ? ` AND id IN (${inList(scoped.length)})` : ""}`)
    .bind(args.workspaceId, ...appParams)
    .all<{ id: string; name: string; apple_app_id: string | null; platform: string | null }>();
  const appName = new Map(appRows.map((a) => [a.id, a.name]));
  const iosApps = appRows.filter((a) => (a.platform ?? "ios") === "ios").map((a) => a.id);

  // Units by day and app (range, previous period, windows) ------------------------------------------------------------
  const { results: unitRows } = await db
    .prepare(
      `SELECT day, apple_id, app_id, MAX(title) AS title, kind, paid, SUM(units) AS units FROM downloads_daily
       WHERE workspace_id = ? AND day >= ? AND day <= ?${appSql} GROUP BY day, apple_id, app_id, kind, paid`,
    )
    .bind(args.workspaceId, readFrom, readTo, ...appParams)
    .all<{ day: string; apple_id: string; app_id: string | null; title: string; kind: string; paid: number; units: number }>();

  const totals = emptyCounts();
  const previous = emptyCounts();
  const dayCounts = new Map<string, DownloadCounts>();
  for (let d = from; d <= to; d = addDays(d, 1)) dayCounts.set(d, emptyCounts());
  const companyFirst = new Map<string, number>();
  const apps = new Map<string, { appId: string | null; appleId: string; title: string; counts: DownloadCounts; previous: number; firstByDay: Map<string, number> }>();
  for (const r of unitRows) {
    const key = r.app_id ?? `apple:${r.apple_id}`;
    let a = apps.get(key);
    if (!a) apps.set(key, (a = { appId: r.app_id, appleId: r.apple_id, title: r.title, counts: emptyCounts(), previous: 0, firstByDay: new Map() }));
    if (r.kind === "first") {
      a.firstByDay.set(r.day, (a.firstByDay.get(r.day) ?? 0) + r.units);
      companyFirst.set(r.day, (companyFirst.get(r.day) ?? 0) + r.units);
    }
    if (r.day >= from && r.day <= to) {
      addUnits(totals, r.kind, r.paid, r.units);
      addUnits(a.counts, r.kind, r.paid, r.units);
      addUnits(dayCounts.get(r.day)!, r.kind, r.paid, r.units);
    } else if (r.day >= prevFrom && r.day < from) {
      addUnits(previous, r.kind, r.paid, r.units);
      if (r.kind === "first") a.previous += r.units;
    }
  }

  // Conversions from Revflare's data (iOS apps) -----------------------------------------------------------------------
  const rawByDay = new Map<string, Raw>();
  const rawByApp = new Map<string, Raw>();
  const raw = (map: Map<string, Raw>, key: string) => map.get(key) ?? map.set(key, emptyRaw()).get(key)!;
  const t0 = dayStart(from);
  const t1 = dayStart(addDays(to, 1));
  for (let i = 0; i < iosApps.length; i += CHUNK) {
    const ids = iosApps.slice(i, i + CHUNK);
    const list = inList(ids.length);
    const { results: metrics } = await db
      .prepare(
        `SELECT app_id, day, trials_started, gross_usd, proceeds_usd FROM daily_metrics
         WHERE app_id IN (${list}) AND day >= ? AND day <= ? AND +workspace_id = ?`,
      )
      .bind(...ids, from, to, args.workspaceId)
      .all<{ app_id: string; day: string; trials_started: number; gross_usd: number; proceeds_usd: number }>();
    for (const m of metrics) {
      for (const r of [raw(rawByDay, m.day), raw(rawByApp, m.app_id)]) {
        r.trials += m.trials_started;
        r.revenueUsd += m.gross_usd;
        r.proceedsUsd += m.proceeds_usd;
      }
    }
    const { results: payers } = await db
      .prepare(
        `SELECT app_id, date(first_paid_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM customers
         WHERE app_id IN (${list}) AND first_paid_at >= ? AND first_paid_at < ? AND workspace_id = ? GROUP BY app_id, day`,
      )
      .bind(...ids, t0, t1, args.workspaceId)
      .all<{ app_id: string; day: string; n: number }>();
    for (const p of payers) {
      raw(rawByDay, p.day).payers += p.n;
      raw(rawByApp, p.app_id).payers += p.n;
    }
    // Installs RevflareKit saw (production; redownloads Apple flagged left out), and those Apple attributed to Apple Ads.
    const { results: installs } = await db
      .prepare(
        `SELECT a.app_id, date(COALESCE(a.installed_at, a.created_at) / 1000, 'unixepoch') AS day,
           SUM(CASE WHEN COALESCE(a.conversion_type, '') != 'Redownload' THEN 1 ELSE 0 END) AS installs,
           SUM(CASE WHEN a.attributed = 1 AND COALESCE(a.conversion_type, '') != 'Redownload' THEN 1 ELSE 0 END) AS ads
         FROM attributions a
         WHERE a.workspace_id = ? AND a.created_at >= ? AND a.created_at < ? AND a.app_id IN (${list}) AND ${PRODUCTION_INSTALL("a")} AND ${NOT_TEST_ATTRIBUTION("a")}
         GROUP BY a.app_id, day`,
      )
      .bind(args.workspaceId, t0, t1 + 2 * DAY, ...ids)
      .all<{ app_id: string; day: string; installs: number; ads: number }>();
    for (const r of installs) {
      if (r.day < from || r.day > to) continue;
      for (const x of [raw(rawByDay, r.day), raw(rawByApp, r.app_id)]) {
        x.ads += r.ads;
        x.sdkInstalls += r.installs;
      }
    }
  }
  const totalRaw = emptyRaw();
  for (const r of rawByApp.values()) {
    totalRaw.trials += r.trials;
    totalRaw.payers += r.payers;
    totalRaw.revenueUsd += r.revenueUsd;
    totalRaw.proceedsUsd += r.proceedsUsd;
    totalRaw.ads += r.ads;
    totalRaw.sdkInstalls += r.sdkInstalls;
  }

  const days: DownloadDay[] = [...dayCounts.entries()].map(([day, c]) => ({ day, ...c, ...conversions(c.downloads, rawByDay.get(day) ?? emptyRaw(), rate) }));

  const appList: DownloadApp[] = [...apps.values()]
    .filter((a) => a.counts.downloads || a.counts.redownloads || a.counts.updates || a.previous || [...a.firstByDay.values()].some(Boolean))
    .map((a) => ({
      appId: a.appId,
      appleId: a.appleId,
      name: (a.appId && appName.get(a.appId)) || a.title || a.appleId,
      ...a.counts,
      ...conversions(a.counts.downloads, (a.appId && rawByApp.get(a.appId)) || emptyRaw(), rate),
      previousDownloads: a.previous,
      windows: DOWNLOAD_WINDOWS.map((w) => window(a.firstByDay, anchor, w)),
    }))
    .sort((x, y) => y.downloads - x.downloads || y.previousDownloads - x.previousDownloads || x.name.localeCompare(y.name));

  // Countries and devices (range) -------------------------------------------------------------------------------------
  const { results: countryRows } = await db
    .prepare(`SELECT country, kind, paid, SUM(units) AS units FROM downloads_daily WHERE workspace_id = ? AND day >= ? AND day <= ?${appSql} GROUP BY country, kind, paid`)
    .bind(args.workspaceId, from, to, ...appParams)
    .all<{ country: string; kind: string; paid: number; units: number }>();
  const countries = new Map<string, DownloadCountry>();
  for (const r of countryRows) addUnits(countries.get(r.country) ?? countries.set(r.country, { country: r.country, ...emptyCounts() }).get(r.country)!, r.kind, r.paid, r.units);
  const { results: deviceRows } = await db
    .prepare(`SELECT device, kind, paid, SUM(units) AS units FROM downloads_daily WHERE workspace_id = ? AND day >= ? AND day <= ?${appSql} GROUP BY device, kind, paid`)
    .bind(args.workspaceId, from, to, ...appParams)
    .all<{ device: string; kind: string; paid: number; units: number }>();
  const devices = new Map<string, DownloadDevice>();
  for (const r of deviceRows) {
    const device = r.device || "Other";
    addUnits(devices.get(device) ?? devices.set(device, { device, ...emptyCounts() }).get(device)!, r.kind, r.paid, r.units);
  }
  const byDownloads = <T extends DownloadCounts>(x: T, y: T) => y.downloads - x.downloads || y.redownloads - x.redownloads || y.updates - x.updates;

  return {
    currency,
    from,
    to,
    totals: { ...totals, ...conversions(totals.downloads, totalRaw, rate) },
    previous,
    windows: DOWNLOAD_WINDOWS.map((w) => window(companyFirst, anchor, w)),
    days,
    apps: appList,
    countries: [...countries.values()].sort(byDownloads),
    devices: [...devices.values()].sort(byDownloads),
    firstDay,
    lastDay,
  };
});
