// Apple Ads attribution (RevflareKit). Each install sends its AdServices attribution token once; Revflare asks Apple's
// attribution API which campaign / ad group / keyword brought it (https://api-adservices.apple.com/api/v1/, token as
// the body). Installs report the original transaction ids they own, so revenue joins to campaigns through
// install_links. Tokens live 24 hours; Apple can answer 404 for a while right after install, so pending tokens are
// retried by the cron.

import { isTestAttribution, lookupNames, nameKey } from "./ads-names";
import { defineDbFunction, type Db } from "./db";
import { addDays, dayStart, keptShareSql } from "./money";
import type { AttributionOptions, InstallSource, SdkEnvironment } from "../../shared/types";
import { cachedFn } from "./metrics";
import { installsChanged, installsInSql, installSource, PRODUCTION_INSTALL, referrerSource, workspaceTestInstalls } from "./test-data";
import { errorMessage, now } from "./util";

const ADSERVICES = "https://api-adservices.apple.com/api/v1/";
const MAX_ATTEMPTS = 8;

const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

interface AppleAttribution {
  attribution?: boolean;
  orgId?: number;
  campaignId?: number;
  adGroupId?: number;
  keywordId?: number;
  adId?: number;
  countryOrRegion?: string;
  clickDate?: string;
  conversionType?: string;
  claimType?: string;
}

/** Asks Apple about one token. Returns null while Apple does not know it yet (404, 5xx). */
async function resolveToken(token: string): Promise<{ data: AppleAttribution } | { retry: true; error: string } | { failed: string }> {
  const res = await fetch(ADSERVICES, { method: "POST", headers: { "content-type": "text/plain" }, body: token });
  if (res.ok) return { data: (await res.json()) as AppleAttribution };
  const text = (await res.text()).slice(0, 200);
  if (res.status === 404 || res.status >= 500 || res.status === 429) return { retry: true, error: `${res.status} ${text}` };
  return { failed: `${res.status} ${text}` };
}

async function resolveRow(db: Db, appId: string, installId: string, token: string, attempts: number, env: Env) {
  const t = now();
  if (env.TEST_MODE === "true" && !token.startsWith("test:")) return;
  let r: Awaited<ReturnType<typeof resolveToken>>;
  try {
    r = env.TEST_MODE === "true" ? { data: JSON.parse(token.slice(5)) as AppleAttribution } : await resolveToken(token);
  } catch (err) {
    r = { retry: true, error: errorMessage(err) };
  }
  if ("data" in r) {
    const a = r.data;
    const s = (v: number | string | undefined) => (v === undefined || v === null ? null : String(v));
    await db
      .prepare(
        `UPDATE attributions SET status = 'resolved', attributed = ?, org_id = ?, campaign_id = ?, ad_group_id = ?, keyword_id = ?, ad_id = ?,
         country = ?, click_date = ?, conversion_type = ?, claim_type = ?, token = NULL, attempts = ?, error = NULL, updated_at = ?, resolved_at = ?, test_attribution = ?
         WHERE app_id = ? AND install_id = ?`,
      )
      .bind(
        a.attribution ? 1 : 0,
        s(a.orgId),
        s(a.campaignId),
        s(a.adGroupId),
        s(a.keywordId),
        s(a.adId),
        a.countryOrRegion ?? null,
        a.clickDate ?? null,
        a.conversionType ?? null,
        a.claimType ?? null,
        attempts + 1,
        t,
        t,
        // Apple's AdServices test payload (development / TestFlight builds): still apple_ads for remote config.
        isTestAttribution(a.campaignId) ? 1 : 0,
        appId,
        installId,
      )
      .run();
    return;
  }
  const failed = "failed" in r || attempts + 1 >= MAX_ATTEMPTS;
  await db
    .prepare("UPDATE attributions SET status = ?, attempts = ?, error = ?, token = CASE WHEN ? THEN NULL ELSE token END, updated_at = ? WHERE app_id = ? AND install_id = ?")
    .bind(failed ? "failed" : "pending", attempts + 1, "failed" in r ? r.failed : r.error, failed ? 1 : 0, t, appId, installId)
    .run();
}

export interface SdkReport {
  sdkKey: string;
  installId: string;
  /** AdServices attribution token (AAAttribution.attributionToken()), sent once per install. */
  attributionToken?: string | null;
  /** Original transaction ids this install owns (StoreKit Transaction.all). */
  originalTransactionIds?: string[];
  appVersion?: string | null;
  /** Country of the request (Cloudflare's request.cf.country): the install's country when Apple gives none (organic). */
  country?: string | null;
  /** Install time the SDK persisted on the device (its first launch, ms since epoch): the LTV install time. */
  installedAt?: number | null;
  /**
   * The build (production / sandbox / xcode); missing = production. Kept from the install's first report, except that it
   * only moves toward production: a TestFlight / development install later reporting from the App Store build becomes
   * production (never the other way); rows from before it was sent get the next report's.
   */
  environment?: SdkEnvironment | null;
  /** "android" for RevflareKit Android (Google Play): orderIds / purchaseTokens / installReferrer instead of Apple's ids. */
  platform?: string | null;
  /** Android: Play order ids the install owns (renewal suffixes "..N" are stripped). */
  orderIds?: string[];
  /** Android: Play purchase tokens the install owns (matched to stored subscriptions). */
  purchaseTokens?: string[];
  /** Android: the Play Install Referrer (sent once). clickTs / installTs: seconds or milliseconds since epoch. */
  installReferrer?: { referrer: string; clickTs?: number | null; installTs?: number | null } | null;
}

/** Parsed Play Install Referrer: utm parameters and gclid (each at most 200 characters). */
export function parseInstallReferrer(raw: unknown): { utmSource: string | null; utmMedium: string | null; utmCampaign: string | null; gclid: string | null; clickAt: number | null; installAt: number | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { referrer?: unknown; clickTs?: unknown; installTs?: unknown };
  if (typeof r.referrer !== "string" || r.referrer.length > 4096) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(r.referrer.replace(/^\?/, ""));
  } catch {
    return null;
  }
  const v = (k: string) => {
    const x = params.get(k)?.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    return x ? x.slice(0, 200) : null;
  };
  const ts = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.round(x < 1e12 ? x * 1000 : x) : null);
  return { utmSource: v("utm_source"), utmMedium: v("utm_medium"), utmCampaign: v("utm_campaign"), gclid: v("gclid"), clickAt: ts(r.clickTs), installAt: ts(r.installTs) };
}

/** Base Play order id of an order id ("GPA.1234-5678-9012-34567..3" → "GPA.1234-5678-9012-34567"), or null. */
export function basePlayOrderId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const base = id.trim().replace(/\.\.\d+$/, "");
  return /^GPA\.\d{4}-\d{4}-\d{4}-\d{5}$/.test(base) ? base : null;
}

/** What /sdk/v1/report answers besides `ok` (status 200), or an error. */
export interface SdkReportResult {
  status: number;
  error?: string;
  attribution?: string | null;
  source?: InstallSource;
  campaignId?: string | null;
  adGroupId?: string | null;
  keywordId?: string | null;
}

/** How far before its first report an install time sent by the SDK is believed (LTV reads installs on created_at up to this after the install time). */
export const MAX_INSTALL_LEAD_MS = 30 * 86_400_000;

/** The SDK's install time, kept when it is at most MAX_INSTALL_LEAD_MS before the first report (device clocks can be wrong); never after it. */
function installTime(installedAt: number | null | undefined, firstReport: number): number | null {
  if (typeof installedAt !== "number" || !Number.isFinite(installedAt)) return null;
  if (installedAt < firstReport - MAX_INSTALL_LEAD_MS || installedAt > firstReport + 10 * 60_000) return null;
  return Math.min(Math.round(installedAt), firstReport);
}

interface ReportRow {
  status: string;
  attributed: number;
  referrer_source: string | null;
  campaign_id: string | null;
  ad_group_id: string | null;
  keyword_id: string | null;
  attempts: number;
  install_country: string | null;
  installed_at: number | null;
  created_at: number;
  environment: string | null;
}

const REPORT_ROW_SQL =
  "SELECT status, attributed, referrer_source, campaign_id, ad_group_id, keyword_id, attempts, install_country, installed_at, created_at, environment FROM attributions WHERE app_id = ? AND install_id = ?";

/** The report's answer from the install's row: its source and, for Apple Ads installs, the campaign / ad group / keyword. */
function reportAnswer(row: Pick<ReportRow, "status" | "attributed" | "referrer_source" | "campaign_id" | "ad_group_id" | "keyword_id"> | null): SdkReportResult {
  const source = installSource(row);
  const ads = source === "apple_ads";
  return {
    status: 200,
    attribution: row?.status ?? null,
    source,
    campaignId: ads ? (row!.campaign_id ?? null) : null,
    adGroupId: ads ? (row!.ad_group_id ?? null) : null,
    keywordId: ads ? (row!.keyword_id ?? null) : null,
  };
}

/**
 * POST /sdk/v1/report — records an install's token and transactions, resolves the token right away when possible, and
 * answers the install's source (remote config conditions by acquisition source). A re-report with nothing new (no
 * token, no transaction ids, or only ids already linked) reads the app and the install's row and writes nothing.
 * Xcode builds (StoreKit configuration file): no install links (their transaction ids are local) and no Apple call.
 */
export const recordSdkReport = defineDbFunction("recordSdkReport", async (db, r: SdkReport, env): Promise<SdkReportResult> => {
  if (!r.sdkKey || !isUuid(r.installId)) return { status: 400, error: "sdkKey and installId (UUID) are required" };
  const app = await db.prepare("SELECT id, workspace_id, platform FROM apps WHERE sdk_key = ?").bind(r.sdkKey).first<{ id: string; workspace_id: string; platform: string }>();
  if (!app) return { status: 404, error: "Unknown SDK key" };
  const android = app.platform === "android" || r.platform === "android";
  const installId = r.installId.toLowerCase();
  const t = now();
  const existing = await db.prepare(REPORT_ROW_SQL).bind(app.id, installId).first<ReportRow>();
  // The first report's environment is kept, but moves to production when a production build reports (never back);
  // installs recorded before it was sent take this report's.
  const reported: SdkEnvironment = r.environment ?? "production";
  const previous = existing ? (existing.environment as SdkEnvironment | null) : null;
  const environment: SdkEnvironment = !existing || previous === null ? reported : previous !== "production" && r.environment === "production" ? "production" : previous;
  const environmentChanged = !!existing && environment !== existing.environment;
  // LTV / attributed revenue count production installs (NULL included): their caches change when this does.
  const counted = (e: string | null) => e === null || e === "production";
  let bumpVersion = !!existing && counted(previous) !== counted(environment);
  // Xcode (StoreKit configuration) and debuggable Android builds: local / test purchases, nothing to link or resolve.
  const xcode = environment === "xcode" || environment === "debug";
  let otids: string[] = [];
  if (!xcode && android) {
    const fromOrders = [...(r.orderIds ?? []), ...(r.originalTransactionIds ?? [])].map(basePlayOrderId).filter((x): x is string => !!x);
    const tokens = [...new Set((r.purchaseTokens ?? []).filter((x) => typeof x === "string" && x.length > 10 && x.length < 512))].slice(0, 90);
    if (tokens.length) {
      const { results } = await db
        .prepare(`SELECT original_transaction_id FROM subscriptions WHERE app_id = ? AND purchase_token IN (${tokens.map(() => "?").join(",")})`)
        .bind(app.id, ...tokens)
        .all<{ original_transaction_id: string }>();
      fromOrders.push(...results.map((x) => x.original_transaction_id));
    }
    otids = [...new Set(fromOrders)].slice(0, 90);
  } else if (!xcode) otids = (r.originalTransactionIds ?? []).filter((x) => typeof x === "string" && /^\d{1,30}$/.test(x)).slice(0, 90);
  if (otids.length) {
    const results = await db.batch(
      otids.map((o) =>
        db.prepare("INSERT INTO install_links (app_id, original_transaction_id, install_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(app.id, o, installId, t),
      ),
    );
    // Revenue of these customers moves to their campaign: refresh the app's metrics cache (only when a link is new).
    if (results.some((x) => (x.meta?.changes ?? 0) > 0)) bumpVersion = true;
  }
  const rawToken = typeof r.attributionToken === "string" && r.attributionToken.length > 10 && r.attributionToken.length < 4096 ? r.attributionToken : null;
  // Xcode builds get no usable token from AdServices: never sent to Apple.
  const token = xcode || android ? null : rawToken;
  const country = typeof r.country === "string" && /^[A-Z]{2}$/.test(r.country) && r.country !== "XX" && r.country !== "T1" ? r.country : null;
  const referrer = android ? parseInstallReferrer(r.installReferrer) : null;
  let changed = false;
  if (referrer && existing?.referrer_source == null) {
    // Android: the source comes from the install referrer (no Apple token). A first report creates the row below.
    if (existing) {
      const source = referrerSource(referrer);
      await db
        .prepare(
          `UPDATE attributions SET referrer_source = ?, utm_source = ?, utm_medium = ?, utm_campaign = ?, gclid = ?, referrer_click_at = ?, status = 'resolved', error = NULL,
           installed_at = COALESCE(installed_at, ?), updated_at = ?, resolved_at = ? WHERE app_id = ? AND install_id = ?`,
        )
        .bind(source, referrer.utmSource, referrer.utmMedium, referrer.utmCampaign, referrer.gclid, referrer.clickAt, installTime(referrer.installAt, existing.created_at), t, t, app.id, installId)
        .run();
      if (source !== "organic") bumpVersion = true;
      changed = true;
    }
  }
  if (!existing) {
    await db
      .prepare(
        `INSERT INTO attributions (app_id, install_id, workspace_id, token, status, error, app_version, install_country, installed_at, environment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(app.id, installId, app.workspace_id, token, token ? "pending" : referrer ? "resolved" : "failed", xcode && rawToken ? "xcode build: not sent to Apple" : null, r.appVersion ?? null, country, installTime(r.installedAt ?? referrer?.installAt, t), environment, t, t)
      .run();
    if (referrer) {
      await db
        .prepare("UPDATE attributions SET referrer_source = ?, utm_source = ?, utm_medium = ?, utm_campaign = ?, gclid = ?, referrer_click_at = ?, resolved_at = ? WHERE app_id = ? AND install_id = ?")
        .bind(referrerSource(referrer), referrer.utmSource, referrer.utmMedium, referrer.utmCampaign, referrer.gclid, referrer.clickAt, t, app.id, installId)
        .run();
    }
    if (token) await resolveRow(db, app.id, installId, token, 0, env);
    changed = true;
  } else if (token && existing.status !== "resolved" && !android) {
    await db.prepare("UPDATE attributions SET token = ?, status = 'pending', updated_at = ? WHERE app_id = ? AND install_id = ?").bind(token, t, app.id, installId).run();
    await resolveRow(db, app.id, installId, token, existing.attempts, env);
    changed = true;
  }
  // Installs recorded before the country / install time were kept get them once, from their next report; the
  // environment changes at most twice (NULL → reported, then → production). A steady re-report writes nothing.
  const installedAt = existing && existing.installed_at === null ? installTime(r.installedAt, existing.created_at) : null;
  if (existing && ((!existing.install_country && country) || installedAt !== null || environmentChanged)) {
    await db
      .prepare("UPDATE attributions SET install_country = COALESCE(install_country, ?), installed_at = COALESCE(installed_at, ?), environment = ? WHERE app_id = ? AND install_id = ?")
      .bind(country, installedAt, environment, app.id, installId)
      .run();
  }
  if (bumpVersion) {
    await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(`data_version:${app.workspace_id}`, String(t)).run();
    // LTV's day cache of install bases too (an install moving in or out of production).
    if (counted(previous) !== counted(environment)) installsChanged(app.workspace_id);
  }
  if (!changed) return reportAnswer(existing);
  return reportAnswer(await db.prepare(REPORT_ROW_SQL).bind(app.id, installId).first<ReportRow>());
});

/** Cron: retry pending tokens (Apple may need a little while after install). */
export const retryAttributions = defineDbFunction("retryAttributions", async (db, args: { limit?: number }, env) => {
  const { results } = await db
    .prepare("SELECT app_id, install_id, token, attempts FROM attributions WHERE status = 'pending' AND token IS NOT NULL AND updated_at < ? ORDER BY updated_at LIMIT ?")
    .bind(now() - 60_000, args.limit ?? 20)
    .all<{ app_id: string; install_id: string; token: string; attempts: number }>();
  for (const r of results) {
    // Tokens expire after 24 hours.
    const age = await db.prepare("SELECT created_at FROM attributions WHERE app_id = ? AND install_id = ?").bind(r.app_id, r.install_id).first<{ created_at: number }>();
    if (age && age.created_at < now() - 23 * 3_600_000) {
      await db.prepare("UPDATE attributions SET status = 'failed', token = NULL, error = 'token expired' WHERE app_id = ? AND install_id = ?").bind(r.app_id, r.install_id).run();
      continue;
    }
    await resolveRow(db, r.app_id, r.install_id, r.token, r.attempts, env);
  }
  return { retried: results.length };
});

export interface AttributedRow {
  date: string;
  appId: string;
  appleAppId: string | null;
  campaignId: string;
  adGroupId: string | null;
  keywordId: string | null;
  campaignName: string | null;
  adGroupName: string | null;
  keywordName: string | null;
  /** Test data (only with includeTest): Apple's test attribution, a sandbox / Xcode build or a test device. */
  test?: boolean;
  revenue: number;
  proceeds: number;
  transactions: number;
  trials: number;
  installs: number;
  payers: number;
}

export interface AttributedCoverage {
  /** Installs that reported in the range (production, test devices and test attribution left out, unless includeTest). */
  installs: number;
  /** Of them, installs Apple attributed to Apple Ads (never test attribution). */
  attributed: number;
  /** Installs with Apple's test attribution in the range (hidden unless includeTest). */
  testInstalls: number;
}

/**
 * Revenue per day, app and Apple Ads campaign / ad group / keyword (USD), from installs Apple attributed, with the
 * stored names. Revenue is counted on the purchase day; installs on the day the SDK reported them; payers on the
 * customer's first paid day. Test data (Apple's test attribution, sandbox / Xcode installs, the apps' test devices, and
 * sandbox purchases) is left out unless includeTest; then its rows are flagged `test`.
 */
export const attributedRevenue = defineDbFunction(
  "attributedRevenue",
  async (db, args: { workspaceId: string; from: string; to: string; appIds?: string[] | null; includeTest?: boolean }): Promise<{ rows: AttributedRow[]; coverage: AttributedCoverage }> => {
    const t0 = dayStart(args.from);
    const t1 = dayStart(addDays(args.to, 1));
    const include = !!args.includeTest;
    // Test data: Apple's test attribution, non-production builds, test devices (worker/lib/test-data.ts).
    const testDevices = await workspaceTestInstalls(db, args.workspaceId);
    const devices = installsInSql("a.install_id", testDevices);
    const testSql = `(a.test_attribution = 1 OR NOT ${PRODUCTION_INSTALL("a")}${devices ? ` OR ${devices}` : ""})`;
    const appSql = args.appIds?.length ? ` AND a.app_id IN (${args.appIds.map(() => "?").join(",")})` : "";
    const appFilter = appSql + (include ? "" : ` AND NOT ${testSql}`);
    const txEnv = include ? "" : " AND t.environment = 'Production'";
    const testCol = include ? `CASE WHEN ${testSql} THEN 1 ELSE 0 END` : "0";
    // Sales and payers: a sandbox purchase is test data too, even from a production install.
    const txTestCol = include ? `CASE WHEN ${testSql} OR t.environment != 'Production' THEN 1 ELSE 0 END` : "0";
    const appParams = args.appIds ?? [];
    type Key = { day: string; app_id: string; campaign_id: string; ad_group_id: string | null; keyword_id: string | null; test: number };
    const key = (r: Key) => `${r.day}|${r.app_id}|${r.campaign_id}|${r.ad_group_id ?? ""}|${r.keyword_id ?? ""}|${r.test ? 1 : 0}`;
    const rows = new Map<string, AttributedRow>();
    const { results: apps } = await db.prepare("SELECT id, apple_app_id FROM apps WHERE workspace_id = ?").bind(args.workspaceId).all<{ id: string; apple_app_id: string | null }>();
    const appleId = new Map(apps.map((a) => [a.id, a.apple_app_id]));
    const row = (r: Key) => {
      const k = key(r);
      let x = rows.get(k);
      if (!x) {
        x = {
          date: r.day,
          appId: r.app_id,
          appleAppId: appleId.get(r.app_id) ?? null,
          campaignId: r.campaign_id,
          adGroupId: r.ad_group_id,
          keywordId: r.keyword_id,
          campaignName: null,
          adGroupName: null,
          keywordName: null,
          ...(include ? { test: !!r.test } : {}),
          revenue: 0,
          proceeds: 0,
          transactions: 0,
          trials: 0,
          installs: 0,
          payers: 0,
        };
        rows.set(k, x);
      }
      return x;
    };
    const { results: sales } = await db
      .prepare(
        `SELECT strftime('%Y-%m-%d', t.purchased_at / 1000, 'unixepoch') AS day, a.app_id, a.campaign_id, a.ad_group_id, a.keyword_id, ${txTestCol} AS test,
           SUM(t.gross_usd * ${keptShareSql()}) AS revenue, SUM(t.proceeds_usd * ${keptShareSql()}) AS proceeds,
           SUM(t.kind != 'trial') AS transactions, SUM(t.kind = 'trial') AS trials
         FROM attributions a JOIN install_links l ON l.app_id = a.app_id AND l.install_id = a.install_id
         JOIN transactions t ON t.app_id = l.app_id AND t.original_transaction_id = l.original_transaction_id
         WHERE a.workspace_id = ? AND a.attributed = 1${txEnv} AND t.purchased_at >= ? AND t.purchased_at < ?${appFilter}
         GROUP BY day, a.app_id, a.campaign_id, a.ad_group_id, a.keyword_id, test`,
      )
      .bind(args.workspaceId, t0, t1, ...appParams)
      .all<Key & { revenue: number; proceeds: number; transactions: number; trials: number }>();
    for (const s of sales) Object.assign(row(s), { revenue: s.revenue, proceeds: s.proceeds, transactions: s.transactions, trials: s.trials });
    const { results: installs } = await db
      .prepare(
        `SELECT strftime('%Y-%m-%d', a.created_at / 1000, 'unixepoch') AS day, a.app_id, a.campaign_id, a.ad_group_id, a.keyword_id, ${testCol} AS test, COUNT(*) AS n
         FROM attributions a WHERE a.workspace_id = ? AND a.attributed = 1 AND a.created_at >= ? AND a.created_at < ?${appFilter}
         GROUP BY day, a.app_id, a.campaign_id, a.ad_group_id, a.keyword_id, test`,
      )
      .bind(args.workspaceId, t0, t1, ...appParams)
      .all<Key & { n: number }>();
    for (const i of installs) row(i).installs = i.n;
    // First payment of each attributed install (any of its subscriptions / purchases).
    const { results: payers } = await db
      .prepare(
        `SELECT strftime('%Y-%m-%d', first / 1000, 'unixepoch') AS day, app_id, campaign_id, ad_group_id, keyword_id, test, COUNT(*) AS n FROM (
           SELECT a.app_id, a.campaign_id, a.ad_group_id, a.keyword_id, ${txTestCol} AS test, MIN(t.purchased_at) AS first
           FROM attributions a JOIN install_links l ON l.app_id = a.app_id AND l.install_id = a.install_id
           JOIN transactions t ON t.app_id = l.app_id AND t.original_transaction_id = l.original_transaction_id
           WHERE a.workspace_id = ? AND a.attributed = 1${txEnv} AND t.kind != 'trial' AND t.gross_usd > 0${appFilter}
           GROUP BY a.app_id, a.install_id, test)
         WHERE first >= ? AND first < ? GROUP BY day, app_id, campaign_id, ad_group_id, keyword_id, test`,
      )
      .bind(args.workspaceId, ...appParams, t0, t1)
      .all<Key & { n: number }>();
    for (const p of payers) row(p).payers = p.n;
    // Coverage: installs reporting in the range (test data only with includeTest), attributed ones (never test
    // attribution), and the test attribution installs (the "hidden" count).
    const cov = await db
      .prepare(
        `SELECT SUM(${include ? "1" : `NOT ${testSql}`}) AS installs, SUM(a.attributed = 1 AND a.test_attribution = 0${include ? "" : ` AND NOT ${testSql}`}) AS attributed,
           SUM(a.test_attribution = 1) AS test FROM attributions a WHERE a.workspace_id = ? AND a.created_at >= ? AND a.created_at < ?${appSql}`,
      )
      .bind(args.workspaceId, t0, t1, ...appParams)
      .first<{ installs: number | null; attributed: number | null; test: number | null }>();
    const list = [...rows.values()];
    const names = await lookupNames(db, args.workspaceId, { campaign: list.map((r) => r.campaignId), adgroup: list.map((r) => r.adGroupId), keyword: list.map((r) => r.keywordId) });
    for (const r of list) {
      r.campaignName = names.get(nameKey("campaign", r.campaignId)) ?? null;
      r.adGroupName = r.adGroupId ? (names.get(nameKey("adgroup", r.adGroupId)) ?? null) : null;
      r.keywordName = r.keywordId ? (names.get(nameKey("keyword", r.keywordId)) ?? null) : null;
    }
    return {
      rows: list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.revenue - a.revenue)),
      coverage: { installs: cov?.installs ?? 0, attributed: cov?.attributed ?? 0, testInstalls: cov?.test ?? 0 },
    };
  },
);

const OPTIONS_LIMIT = 200;

/**
 * GET /apps/:id/config/attribution-options: Apple Ads campaign / ad group / keyword ids of the app's production
 * installs Apple attributed in the last `days` days, with install counts (remote config condition pickers) and the
 * names stored by PUT /attribution/names (null when unknown). Cached until the data version or the UTC day changes.
 */
export const attributionOptions = cachedFn("attributionOptions", async (db, args: { workspaceId: string; appId: string; days: number; day: string }): Promise<AttributionOptions> => {
  const since = dayStart(addDays(args.day, -(args.days - 1)));
  const { results } = await db
    .prepare(
      `SELECT campaign_id, ad_group_id, keyword_id, COUNT(*) AS n FROM attributions a
       WHERE a.workspace_id = ? AND a.created_at >= ? AND a.app_id = ? AND a.attributed = 1 AND ${PRODUCTION_INSTALL("a")}
       GROUP BY campaign_id, ad_group_id, keyword_id`,
    )
    .bind(args.workspaceId, since, args.appId)
    .all<{ campaign_id: string | null; ad_group_id: string | null; keyword_id: string | null; n: number }>();
  const campaigns = new Map<string, AttributionOptions["campaigns"][number]>();
  const adGroups = new Map<string, AttributionOptions["adGroups"][number]>();
  const keywords = new Map<string, AttributionOptions["keywords"][number]>();
  const id = (v: string | null) => (v && /^\d{1,20}$/.test(v) ? v : null);
  for (const r of results) {
    const c = id(r.campaign_id);
    const g = id(r.ad_group_id);
    const k = id(r.keyword_id);
    if (c) {
      const x = campaigns.get(c) ?? { id: c, name: null, installs: 0 };
      x.installs += r.n;
      campaigns.set(c, x);
    }
    if (g) {
      const x = adGroups.get(g) ?? { id: g, campaignId: c, name: null, installs: 0 };
      x.installs += r.n;
      adGroups.set(g, x);
    }
    if (k) {
      const x = keywords.get(k) ?? { id: k, campaignId: c, adGroupId: g, name: null, installs: 0 };
      x.installs += r.n;
      keywords.set(k, x);
    }
  }
  const top = <T extends { id: string; installs: number }>(m: Map<string, T>) => [...m.values()].sort((a, b) => b.installs - a.installs || (a.id < b.id ? -1 : 1)).slice(0, OPTIONS_LIMIT);
  const out = { appId: args.appId, days: args.days, campaigns: top(campaigns), adGroups: top(adGroups), keywords: top(keywords) };
  const names = await lookupNames(db, args.workspaceId, { campaign: out.campaigns.map((x) => x.id), adgroup: out.adGroups.map((x) => x.id), keyword: out.keywords.map((x) => x.id) });
  for (const x of out.campaigns) x.name = names.get(nameKey("campaign", x.id)) ?? null;
  for (const x of out.adGroups) x.name = names.get(nameKey("adgroup", x.id)) ?? null;
  for (const x of out.keywords) x.name = names.get(nameKey("keyword", x.id)) ?? null;
  return out;
});
