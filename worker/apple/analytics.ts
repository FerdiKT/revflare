// App Store acquisition from Apple's App Analytics reports (Analytics Reports API): impressions, product page views,
// downloads and purchases per app, day, source type (App Store search / browse, web / app referrer...), referrer and
// campaign token (`ct=` in App Store links).
//
// Flow: one ONGOING report request per app (POST /v1/analyticsReportRequests, Admin role) → Apple produces reports
// daily (the first after 1–2 days) → for each report we use, its DAILY instances (one per processing date) → their
// segments (gzip'd TSV, signed URLs valid 5 minutes) → aggregated into `acquisition_daily`.
//
// Reports: the Standard ones (complete counts by source type) and the Detailed ones (add Source Info = referrer and
// Campaign; Apple leaves out rows with fewer than 5 users and adds a little noise). Both are kept apart (`detailed`):
// totals and source types come from Standard, referrers and campaigns from Detailed.
//
// An instance can hold several days (late events); a newer processing date replaces those days (Apple: "use the
// latest instance"), so instances are imported oldest first and each one replaces the days it contains.
// https://developer.apple.com/documentation/analytics-reports/data-completeness-corrections

import { backgroundAllowed, metered } from "../lib/budget";
import { reportCredentials, type Credential } from "../lib/credentials";
import { defineDbFunction, type Db } from "../lib/db";
import { errorMessage, now, parseJson } from "../lib/util";
import { AppStoreConnectApi, AscError, responseLines } from "./connect";

const HOUR = 3_600_000;

export type ReportKind = "engagement" | "engagement_detailed" | "downloads" | "downloads_detailed" | "purchases" | "purchases_detailed";
export const REPORT_KINDS: ReportKind[] = ["downloads", "engagement", "purchases", "downloads_detailed", "engagement_detailed", "purchases_detailed"];
export type Report = "engagement" | "downloads" | "purchases";

/** Apple's report names → our kinds ("App Downloads Standard", "App Store Discovery and Engagement Detailed", ...). */
export function reportKind(name: string): ReportKind | null {
  const n = name.toLowerCase().replace(/\s+/g, " ").trim();
  const level = n.endsWith(" detailed") ? "_detailed" : n.endsWith(" standard") ? "" : null;
  if (level === null) return null;
  const base: Report | null = n.startsWith("app store discovery and engagement")
    ? "engagement"
    : n.startsWith("app downloads") || n.startsWith("app store downloads")
      ? "downloads"
      : n.startsWith("app store purchases")
        ? "purchases"
        : null;
  return base ? (`${base}${level}` as ReportKind) : null;
}

const splitKind = (k: ReportKind): { report: Report; detailed: 0 | 1 } => ({ report: k.replace("_detailed", "") as Report, detailed: k.endsWith("_detailed") ? 1 : 0 });

// Parsing ------------------------------------------------------------------------------------------------------------

export interface AcquisitionAgg {
  day: string;
  sourceType: string;
  sourceInfo: string;
  campaign: string;
  impressions: number;
  impressionsUnique: number;
  pageViews: number;
  pageViewsUnique: number;
  downloads: number;
  redownloads: number;
  purchases: number;
  proceedsUsd: number;
  salesUsd: number;
}

const EMPTY = new Set(["", "null", "(null)", "-", "none", "n/a"]);
const clean = (v: string | undefined) => {
  const s = (v ?? "").trim().replace(/^"(.*)"$/, "$1").trim();
  return EMPTY.has(s.toLowerCase()) ? "" : s;
};
const num = (v: string | undefined) => {
  const n = Number(clean(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/** "2024-03-30", "2024-03-30T00:00:00Z" or "03/30/2024" → "2024-03-30" (null otherwise). */
export function reportDay(v: string | undefined): string | null {
  const s = clean(v);
  let m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

/**
 * Sums a report's rows by day, source type, referrer (Source Info) and campaign: devices, OS versions, territories,
 * page types and titles are aggregated away. Engagement: Event "Impression" / "Page view" (Counts, Unique Counts);
 * downloads: Download Type "First-time download" / "Redownload" (updates and restores are left out); purchases:
 * Purchases (refunds negative), Proceeds in USD, Sales in USD. Unique counts are summed over rows (an approximation).
 */
export class ReportAggregator {
  private head: string[] | null = null;
  private readonly rows = new Map<string, AcquisitionAgg>();
  lines = 0;

  constructor(readonly report: Report) {}

  /** The next file (segment) starts with its own header line. */
  newFile() {
    this.head = null;
  }

  addLine(line: string) {
    if (!line.trim()) return;
    const cells = line.split("\t");
    if (!this.head) {
      this.head = cells.map((h) => clean(h).toLowerCase());
      return;
    }
    this.lines++;
    const r: Record<string, string> = {};
    this.head.forEach((h, i) => (r[h] = cells[i] ?? ""));
    this.add(r);
  }

  /** One row keyed by lower-case column names. */
  add(r: Record<string, string>) {
    const day = reportDay(r["date"]);
    if (!day) return;
    const sourceType = clean(r["source type"]) || "Unavailable";
    const sourceInfo = clean(r["source info"]);
    const campaign = clean(r["campaign"]);
    const key = `${day}\u0000${sourceType}\u0000${sourceInfo}\u0000${campaign}`;
    let a = this.rows.get(key);
    const fresh = () => ({ day, sourceType, sourceInfo, campaign, impressions: 0, impressionsUnique: 0, pageViews: 0, pageViewsUnique: 0, downloads: 0, redownloads: 0, purchases: 0, proceedsUsd: 0, salesUsd: 0 });
    if (this.report === "engagement") {
      const event = clean(r["event"]).toLowerCase();
      const counts = num(r["counts"]);
      const unique = num(r["unique counts"]);
      if (event === "impression") {
        a ??= this.rows.set(key, fresh()).get(key)!;
        a.impressions += counts;
        a.impressionsUnique += unique;
      } else if (event === "page view") {
        a ??= this.rows.set(key, fresh()).get(key)!;
        a.pageViews += counts;
        a.pageViewsUnique += unique;
      }
    } else if (this.report === "downloads") {
      const type = clean(r["download type"]).toLowerCase().replace(/[^a-z]/g, "");
      const counts = num(r["counts"]);
      if (type.startsWith("firsttime")) {
        a ??= this.rows.set(key, fresh()).get(key)!;
        a.downloads += counts;
      } else if (type === "redownload") {
        a ??= this.rows.set(key, fresh()).get(key)!;
        a.redownloads += counts;
      }
    } else {
      const purchases = num(r["purchases"]);
      const proceeds = num(r["proceeds in usd"]);
      const sales = num(r["sales in usd"]);
      if (!purchases && !proceeds && !sales) return;
      a ??= this.rows.set(key, fresh()).get(key)!;
      a.purchases += purchases;
      a.proceedsUsd += proceeds;
      a.salesUsd += sales;
    }
  }

  result(): AcquisitionAgg[] {
    return [...this.rows.values()];
  }
}

/** Parses a whole TSV text (tests, small files). */
export function aggregateTsv(report: Report, text: string): AcquisitionAgg[] {
  const agg = new ReportAggregator(report);
  for (const l of text.split(/\r?\n/)) agg.addLine(l);
  return agg.result();
}

// Storage ------------------------------------------------------------------------------------------------------------

/** Replaces the app's rows of this report for every day in `rows` and records the instance (one transaction). */
export async function storeInstance(
  db: Db,
  a: { workspaceId: string; appId: string; kind: ReportKind; instanceId: string; processingDate: string; rows: AcquisitionAgg[] },
): Promise<{ days: number; rows: number }> {
  const { report, detailed } = splitKind(a.kind);
  const days = [...new Set(a.rows.map((r) => r.day))];
  const stmts = days.map((d) => db.prepare("DELETE FROM acquisition_daily WHERE app_id = ? AND report = ? AND detailed = ? AND day = ?").bind(a.appId, report, detailed, d));
  for (const r of a.rows) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO acquisition_daily (workspace_id, app_id, day, report, detailed, source_type, source_info, campaign, impressions, impressions_unique,
             page_views, page_views_unique, downloads, redownloads, purchases, proceeds_usd, sales_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          a.workspaceId,
          a.appId,
          r.day,
          report,
          detailed,
          r.sourceType,
          r.sourceInfo,
          r.campaign,
          r.impressions,
          r.impressionsUnique,
          r.pageViews,
          r.pageViewsUnique,
          r.downloads,
          r.redownloads,
          r.purchases,
          r.proceedsUsd,
          r.salesUsd,
        ),
    );
  }
  stmts.push(
    db
      .prepare(
        `INSERT INTO acquisition_instances (instance_id, workspace_id, app_id, report, processing_date, rows, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET rows = excluded.rows, imported_at = excluded.imported_at`,
      )
      .bind(a.instanceId, a.workspaceId, a.appId, a.kind, a.processingDate, a.rows.length, now()),
  );
  await db.batch(stmts);
  return { days: days.length, rows: a.rows.length };
}

// Report requests ----------------------------------------------------------------------------------------------------

interface RequestRow {
  app_id: string;
  workspace_id: string;
  request_id: string | null;
  state: "requested" | "producing" | "stopped" | "failed";
  error: string | null;
  reports: string;
  created_at: number;
  updated_at: number;
  checked_at: number | null;
}

/** Runs `fn` with the reports key, then the main key when Apple refuses the first (401/403: role). */
async function withKeys<T>(creds: Credential[], fn: (api: AppStoreConnectApi) => Promise<T>, fetcher?: typeof fetch): Promise<T> {
  let last: unknown = null;
  for (const c of creds) {
    try {
      return await fn(new AppStoreConnectApi(c, fetcher));
    } catch (err) {
      last = err;
      if (!(err instanceof AscError && (err.status === 401 || err.status === 403))) throw err;
    }
  }
  throw last ?? new Error("Add an App Store Connect API key (Admin role to request reports, Sales role to read them)");
}

const roleHint = (err: unknown) =>
  err instanceof AscError && err.status === 403
    ? `${errorMessage(err)} (requesting App Analytics reports needs an App Store Connect API key with the Admin role; reading them works with Sales)`
    : errorMessage(err);

async function upsertRequest(db: Db, appId: string, workspaceId: string, patch: { requestId?: string | null; state: RequestRow["state"]; error?: string | null; reports?: string }) {
  const t = now();
  await db
    .prepare(
      `INSERT INTO acquisition_requests (app_id, workspace_id, request_id, state, error, reports, created_at, updated_at) VALUES (?, ?, ?, ?, ?, COALESCE(?, '{}'), ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET request_id = COALESCE(excluded.request_id, acquisition_requests.request_id), state = excluded.state, error = excluded.error,
         reports = COALESCE(?, acquisition_requests.reports), updated_at = excluded.updated_at,
         created_at = CASE WHEN excluded.request_id IS NOT NULL AND excluded.request_id IS NOT acquisition_requests.request_id THEN excluded.created_at ELSE acquisition_requests.created_at END`,
    )
    .bind(appId, workspaceId, patch.requestId ?? null, patch.state, patch.error ?? null, patch.reports ?? null, t, t, patch.reports ?? null)
    .run();
}

export interface EnsureResult {
  created: { appId: string; name: string }[];
  existing: { appId: string; name: string }[];
  failed: { appId: string; name: string; error: string }[];
  /** Apps still to do (call again). */
  remaining: number;
  error?: string;
}

/**
 * Makes sure every non-archived app with an App Store id has an ONGOING report request: reuses Apple's (one per app)
 * or creates it. Apps already requested are skipped; failed / stopped ones are retried when `retry` (or after a day).
 */
export const ensureAcquisitionRequests = defineDbFunction(
  "ensureAcquisitionRequests",
  async (db, args: { workspaceId: string; appIds?: string[] | null; limit?: number; retry?: boolean }, env): Promise<EnsureResult> => {
    const out: EnsureResult = { created: [], existing: [], failed: [], remaining: 0 };
    const creds = await reportCredentials(env, db, args.workspaceId);
    if (!creds.length) return { ...out, error: "Add an App Store Connect API key first (Settings → Credentials)" };
    const ids = args.appIds?.length ? args.appIds.slice(0, 90) : null;
    const { results: apps } = await db
      .prepare(
        `SELECT a.id, a.name, a.apple_app_id FROM apps a LEFT JOIN acquisition_requests r ON r.app_id = a.id
         WHERE a.workspace_id = ? AND a.archived = 0 AND a.apple_app_id IS NOT NULL${ids ? ` AND a.id IN (${ids.map(() => "?").join(",")})` : ""}
           AND (r.app_id IS NULL OR (r.state IN ('failed', 'stopped') AND r.updated_at < ?))
         ORDER BY a.name`,
      )
      // retry: failed / stopped apps again, except those that just failed (so repeated calls move on).
      .bind(args.workspaceId, ...(ids ?? []), now() - (args.retry ? 60_000 : 20 * HOUR))
      .all<{ id: string; name: string; apple_app_id: string }>();
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 100);
    out.remaining = Math.max(apps.length - limit, 0);
    for (const app of apps.slice(0, limit)) {
      try {
        const existing = (await withKeys(creds, (api) => api.listAnalyticsReportRequests(app.apple_app_id))).find((r) => r.accessType === "ONGOING" && !r.stopped);
        if (existing) {
          await upsertRequest(db, app.id, args.workspaceId, { requestId: existing.id, state: "requested" });
          out.existing.push({ appId: app.id, name: app.name });
          continue;
        }
        const id = await withKeys(creds, (api) => api.createAnalyticsReportRequest(app.apple_app_id));
        await upsertRequest(db, app.id, args.workspaceId, { requestId: id, state: "requested", reports: "{}" });
        out.created.push({ appId: app.id, name: app.name });
      } catch (err) {
        const msg = roleHint(err);
        await upsertRequest(db, app.id, args.workspaceId, { state: "failed", error: msg });
        out.failed.push({ appId: app.id, name: app.name, error: msg });
        // Rate limited: stop here, the rest waits for the next call.
        if (err instanceof AscError && err.status === 429) {
          out.remaining += apps.slice(0, limit).length - out.created.length - out.existing.length - out.failed.length;
          break;
        }
      }
    }
    return out;
  },
);

// Import ---------------------------------------------------------------------------------------------------------------

export interface SyncResult {
  apps: number;
  requests: number;
  instances: number;
  rows: number;
  /** More instances are waiting (the request budget ran out). */
  more: boolean;
  budget?: boolean;
  /** Apple answered 429: wait a minute. */
  rateLimited?: boolean;
  errors: { appId: string; error: string }[];
}

/** One app: finds its reports, then imports new daily instances (oldest first) until `maxRequests` Apple calls. */
async function syncApp(env: Env, db: Db, req: RequestRow, creds: Credential[], maxRequests: number, fetcher?: typeof fetch): Promise<{ requests: number; instances: number; rows: number; more: boolean }> {
  let requests = 0;
  let instances = 0;
  let rows = 0;
  let more = false;
  const t = now();
  let reports = parseJson<Partial<Record<ReportKind, string>>>(req.reports, {});
  const call = <T>(fn: (api: AppStoreConnectApi) => Promise<T>) => {
    requests++;
    return withKeys(creds, fn, fetcher);
  };

  // Reports appear 1–2 days after the request; look again until all six are there (at most every 6 hours).
  if (REPORT_KINDS.some((k) => !reports[k])) {
    const list = await call((api) => api.listAnalyticsReports(req.request_id!));
    if (list === null) {
      await upsertRequest(db, req.app_id, req.workspace_id, { state: "stopped", error: "Apple no longer has this report request: a new one is made" });
      return { requests, instances, rows, more };
    }
    const found: Partial<Record<ReportKind, string>> = {};
    for (const r of list) {
      const k = reportKind(r.name);
      if (k) found[k] = r.id;
    }
    reports = { ...reports, ...found };
  }
  const kinds = REPORT_KINDS.filter((k) => reports[k]);
  if (!kinds.length) {
    await db.prepare("UPDATE acquisition_requests SET checked_at = ?, error = NULL WHERE app_id = ?").bind(t, req.app_id).run();
    return { requests, instances, rows, more };
  }

  for (const kind of kinds) {
    if (requests >= maxRequests) {
      more = true;
      break;
    }
    const last = await db
      .prepare("SELECT MAX(processing_date) AS d FROM acquisition_instances WHERE app_id = ? AND report = ?")
      .bind(req.app_id, kind)
      .first<{ d: string | null }>();
    const listed = await call((api) => api.listAnalyticsInstances(reports[kind]!));
    // Newer processing dates replace older ones: only instances from the newest imported date on can matter.
    const candidates = listed.filter((i) => !last?.d || i.processingDate >= last.d);
    const done = new Set<string>();
    for (let i = 0; i < candidates.length; i += 90) {
      const chunk = candidates.slice(i, i + 90).map((c) => c.id);
      const { results } = await db
        .prepare(`SELECT instance_id FROM acquisition_instances WHERE instance_id IN (${chunk.map(() => "?").join(",")})`)
        .bind(...chunk)
        .all<{ instance_id: string }>();
      for (const r of results) done.add(r.instance_id);
    }
    const todo = candidates.filter((c) => !done.has(c.id)).sort((a, b) => a.processingDate.localeCompare(b.processingDate) || a.id.localeCompare(b.id));
    for (const inst of todo) {
      if (requests + 2 > maxRequests || !(await backgroundAllowed(db, env))) {
        more = true;
        break;
      }
      const segments = await call((api) => api.listAnalyticsSegments(inst.id));
      const agg = new ReportAggregator(splitKind(kind).report);
      for (const seg of segments) {
        requests++;
        const res = await new AppStoreConnectApi(creds[0], fetcher).downloadSegment(seg.url);
        agg.newFile();
        for await (const line of responseLines(res)) agg.addLine(line);
      }
      const stored = await metered(db, () => storeInstance(db, { workspaceId: req.workspace_id, appId: req.app_id, kind, instanceId: inst.id, processingDate: inst.processingDate, rows: agg.result() }));
      instances++;
      rows += stored.rows;
    }
  }
  // Nothing new for 4 days: Apple may have stopped the request (stoppedDueToInactivity); a stopped one is replaced.
  if (!instances && !more && requests < maxRequests) {
    const newest = await db.prepare("SELECT MAX(processing_date) AS d FROM acquisition_instances WHERE app_id = ? AND report = 'downloads'").bind(req.app_id).first<{ d: string | null }>();
    const since = newest?.d ? Date.parse(newest.d) : req.created_at;
    if (since < t - 4 * 24 * HOUR) {
      const r = await call((api) => api.getAnalyticsReportRequest(req.request_id!));
      if (!r || r.stopped) {
        await upsertRequest(db, req.app_id, req.workspace_id, { state: "stopped", error: "Apple stopped the report request (inactivity): a new one is made", reports: JSON.stringify(reports) });
        return { requests, instances, rows, more };
      }
    }
  }
  // With instances left over the app keeps its place at the front of the queue (checked_at unchanged).
  await db
    .prepare("UPDATE acquisition_requests SET state = 'producing', error = NULL, reports = ?, checked_at = CASE WHEN ? THEN checked_at ELSE ? END, updated_at = ? WHERE app_id = ?")
    .bind(JSON.stringify(reports), more ? 1 : 0, t, t, req.app_id)
    .run();
  return { requests, instances, rows, more };
}

/**
 * Imports new report instances for apps whose request is producing (or waiting for its first reports), the least
 * recently checked first, within `maxRequests` App Store Connect calls. Apps checked in the last `minAgeMs` (or since
 * `checkedBefore`) are skipped; an app with instances left over stays first in line.
 */
export const syncAcquisition = defineDbFunction(
  "syncAcquisition",
  async (db, args: { workspaceId?: string | null; appIds?: string[] | null; maxRequests?: number; maxApps?: number; minAgeMs?: number; checkedBefore?: number }, env): Promise<SyncResult> => {
    return syncAcquisitionLocal(env, db, args);
  },
);

export async function syncAcquisitionLocal(
  env: Env,
  db: Db,
  args: { workspaceId?: string | null; appIds?: string[] | null; maxRequests?: number; maxApps?: number; minAgeMs?: number; checkedBefore?: number },
  fetcher?: typeof fetch,
): Promise<SyncResult> {
  const out: SyncResult = { apps: 0, requests: 0, instances: 0, rows: 0, more: false, errors: [] };
  if (!(await backgroundAllowed(db, env))) return { ...out, budget: true, more: true };
  const ids = args.appIds?.length ? args.appIds.slice(0, 90) : null;
  const { results } = await db
    .prepare(
      `SELECT r.* FROM acquisition_requests r JOIN apps a ON a.id = r.app_id WHERE a.archived = 0 AND r.state IN ('requested', 'producing') AND r.request_id IS NOT NULL
         ${args.workspaceId ? "AND r.workspace_id = ?" : ""}${ids ? ` AND r.app_id IN (${ids.map(() => "?").join(",")})` : ""} AND COALESCE(r.checked_at, 0) < ?
       ORDER BY COALESCE(r.checked_at, 0) LIMIT ?`,
    )
    .bind(...(args.workspaceId ? [args.workspaceId] : []), ...(ids ?? []), args.checkedBefore ?? now() - (args.minAgeMs ?? 0), args.maxApps ?? 5)
    .all<RequestRow>();
  const maxRequests = args.maxRequests ?? 40;
  const credsByWs = new Map<string, Credential[]>();
  const touched = new Set<string>();
  for (const req of results) {
    if (out.requests >= maxRequests) {
      out.more = true;
      break;
    }
    let creds = credsByWs.get(req.workspace_id);
    if (!creds) credsByWs.set(req.workspace_id, (creds = await reportCredentials(env, db, req.workspace_id)));
    if (!creds.length) continue;
    out.apps++;
    try {
      const r = await syncApp(env, db, req, creds, maxRequests - out.requests, fetcher);
      out.requests += r.requests;
      out.instances += r.instances;
      out.rows += r.rows;
      out.more ||= r.more;
      if (r.instances) touched.add(req.workspace_id);
    } catch (err) {
      out.requests++;
      // Rate limited: stop here; the app keeps its place (checked_at unchanged).
      if (err instanceof AscError && err.status === 429) {
        out.rateLimited = true;
        out.more = true;
        break;
      }
      const msg = roleHint(err);
      out.errors.push({ appId: req.app_id, error: msg });
      await db.prepare("UPDATE acquisition_requests SET error = ?, checked_at = ? WHERE app_id = ?").bind(msg, now(), req.app_id).run();
    }
  }
  for (const ws of touched) {
    await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(`data_version:${ws}`, String(now())).run();
  }
  if (!(await backgroundAllowed(db, env))) out.budget = true;
  return out;
}
