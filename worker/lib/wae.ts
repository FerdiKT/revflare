// Workers Analytics Engine SQL API client (events and funnels; ingest is worker/lib/events.ts).
//
//   POST https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/analytics_engine/sql
//   Authorization: Bearer {CF_ANALYTICS_TOKEN} (Account → Account Analytics → Read), body: the SQL text.
//
// The SQL API has no bind parameters, so every interpolated value goes through `sqlString` (strict allowlist regex, no
// quotes or backslashes possible) or `sqlInt` (finite integers), and every query is scoped by `index1 = <app id>`.
// Results are cached in the isolate (and in the data center's Cache API when a request origin is given) for 5 minutes,
// keyed by the SQL text; callers round time ranges to 5 minutes so repeated reads hit the cache.

import { COLUMNS, DEFAULT_EVENTS_DATASET, EVENTS_LAYOUT_VERSION, eventsBinding } from "./events";
import { sha256Hex } from "./util";
import { EVENT_NAME_RE, EVENT_PROP_KEY_RE, FUNNEL_FILTER_VALUE_RE, PROMOTED_PROPS, type FunnelBreakdown, type FunnelPropFilter } from "../../shared/types";

export const QUERY_TTL_MS = 5 * 60_000;
const DATASET_RE = /^[A-Za-z0-9_]{1,64}$/;
const APP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT_RE = /^[0-9a-f]{32}$/i;

export interface AnalyticsConfig {
  accountId: string;
  token: string;
  dataset: string;
}

export class AnalyticsError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 502,
    readonly code: "analytics_not_configured" | "analytics_query_failed",
  ) {
    super(message);
  }
}

export class SqlValueError extends Error {}

export function datasetName(env: Env): string {
  const d = env.EVENTS_DATASET?.trim() || DEFAULT_EVENTS_DATASET;
  if (!DATASET_RE.test(d)) throw new SqlValueError(`EVENTS_DATASET "${d}" is not a valid dataset name`);
  return d;
}

/** What is missing for events (binding) and their queries (account id, token), in words. */
export function analyticsMissing(env: Env): { ingest: boolean; query: boolean; missing: string[] } {
  const missing: string[] = [];
  const ingest = !!eventsBinding(env);
  if (!ingest) missing.push('The EVENTS Analytics Engine binding ("analytics_engine_datasets": [{ "binding": "EVENTS", "dataset": "revflare_events" }] in your wrangler config)');
  const account = env.CF_ACCOUNT_ID?.trim() ?? "";
  if (!account) missing.push("CF_ACCOUNT_ID (var): your Cloudflare account id");
  else if (!ACCOUNT_RE.test(account) && env.TEST_MODE !== "true") missing.push("CF_ACCOUNT_ID is not a Cloudflare account id (32 hex characters)");
  if (!env.CF_ANALYTICS_TOKEN?.trim()) missing.push("CF_ANALYTICS_TOKEN (secret): an API token with Account → Account Analytics → Read (wrangler secret put CF_ANALYTICS_TOKEN)");
  return { ingest, query: missing.every((m) => !m.startsWith("CF_")), missing };
}

export function analyticsConfig(env: Env): AnalyticsConfig {
  const { query } = analyticsMissing(env);
  if (!query) throw new AnalyticsError("Event queries are not configured: set CF_ACCOUNT_ID (var) and CF_ANALYTICS_TOKEN (secret, Account Analytics Read)", 409, "analytics_not_configured");
  return { accountId: env.CF_ACCOUNT_ID!.trim(), token: env.CF_ANALYTICS_TOKEN!.trim(), dataset: datasetName(env) };
}

// --- Safe SQL pieces ------------------------------------------------------------------------------------------------

/** A string literal, only when `value` matches `re` and has no quote, backslash or control character. */
export function sqlString(value: unknown, re: RegExp): string {
  if (typeof value !== "string" || !re.test(value) || /['"\\\u0000-\u001f\u007f]/.test(value)) throw new SqlValueError(`Invalid value ${JSON.stringify(value)}`);
  return `'${value}'`;
}

/** Same for a value that may contain double quotes but nothing else unsafe (props JSON needles). */
function sqlNeedle(value: string): string {
  if (/['\\\u0000-\u001f\u007f]/.test(value)) throw new SqlValueError(`Invalid value ${JSON.stringify(value)}`);
  return `'${value}'`;
}

/** A finite integer literal. */
export function sqlInt(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new SqlValueError(`Invalid number ${String(value)}`);
  return String(Math.trunc(value));
}

const sec = (ms: number) => sqlInt(Math.floor(ms / 1000));

const INSTALL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Test data of a read (worker/lib/test-data.ts). */
export interface TestFilter {
  /** Count sandbox / Xcode builds and the test devices too. */
  includeTest?: boolean;
  /** The app's test devices (install ids), left out unless includeTest. */
  excludedInstalls?: readonly string[];
}

/**
 * Production events from other devices than the test ones: blob18 (environment) is production, or the event was stored
 * before layout 2 (double3 < 2: it predates the environment and counts as production). '' with includeTest.
 */
export function testFilterSql(test: TestFilter = {}): string {
  if (test.includeTest) return "";
  const ids = (test.excludedInstalls ?? []).map((id) => sqlString(id, INSTALL_RE));
  return ` AND (${COLUMNS.environment} = 'production' OR ${COLUMNS.layout} < ${EVENTS_LAYOUT_VERSION})${ids.length ? ` AND ${COLUMNS.install} NOT IN (${ids.join(", ")})` : ""}`;
}

/**
 * WHERE clause of every query: the app, a receive-time range (`timestamp`, the dataset's time column) and the test data
 * filter (production only by default, see testFilterSql).
 */
export function appScope(appId: string, receivedFromMs: number, receivedToMs: number, test: TestFilter = {}): string {
  return `index1 = ${sqlString(appId, APP_ID_RE)} AND timestamp >= toDateTime(${sec(receivedFromMs)}) AND timestamp < toDateTime(${sec(receivedToMs)})${testFilterSql(test)}`;
}

const BREAKDOWN_COLUMNS: Record<FunnelBreakdown, string> = {
  app_version: COLUMNS.appVersion,
  os_version: COLUMNS.osVersion,
  country: COLUMNS.country,
  locale: COLUMNS.locale,
  placement: COLUMNS.placement,
  offering: COLUMNS.offering,
  product: COLUMNS.product,
  step: COLUMNS.step,
  screen: COLUMNS.screen,
  variant: COLUMNS.variant,
};

export function breakdownColumn(b: FunnelBreakdown): string {
  const col = BREAKDOWN_COLUMNS[b];
  if (!col) throw new SqlValueError(`Unknown breakdown ${String(b)}`);
  return col;
}

/** A property filter: equality on a promoted column, or the `"key":"value"` pair inside the props JSON. */
export function filterSql(f: FunnelPropFilter): string {
  if (typeof f?.key !== "string" || !EVENT_PROP_KEY_RE.test(f.key)) throw new SqlValueError(`Invalid property ${JSON.stringify(f?.key)}`);
  const value = sqlString(f.value, FUNNEL_FILTER_VALUE_RE);
  if ((PROMOTED_PROPS as readonly string[]).includes(f.key)) return `${COLUMNS[f.key as keyof typeof COLUMNS]} = ${value}`;
  return `position(${sqlNeedle(JSON.stringify(f.key) + ":" + JSON.stringify(f.value))} IN ${COLUMNS.props}) > 0`;
}

// --- Queries --------------------------------------------------------------------------------------------------------

export interface SummaryQueries {
  top: string;
  daily: string;
  totals: string;
}

/** Events explorer: top events, per-day counts per event, totals (receive time, UTC days). */
/** Rows of the events page's daily query at most (the summary notices when it hits it). */
export const SUMMARY_DAILY_LIMIT = 10_000;

export function summarySql(dataset: string, appId: string, fromMs: number, toMs: number, test: TestFilter = {}, topLimit = 50): SummaryQueries {
  if (!DATASET_RE.test(dataset)) throw new SqlValueError("Invalid dataset");
  const where = appScope(appId, fromMs, toMs, test);
  const n = COLUMNS.name;
  const i = COLUMNS.install;
  return {
    top: `SELECT ${n} AS name, sum(_sample_interval) AS events, count(DISTINCT ${i}) AS installs, max(_sample_interval) AS si, max(${COLUMNS.receivedAt}) AS last FROM ${dataset} WHERE ${where} GROUP BY name ORDER BY events DESC LIMIT ${sqlInt(topLimit)}`,
    daily: `SELECT toStartOfDay(timestamp) AS day, ${n} AS name, sum(_sample_interval) AS events FROM ${dataset} WHERE ${where} GROUP BY day, name ORDER BY day ASC LIMIT ${SUMMARY_DAILY_LIMIT}`,
    totals: `SELECT sum(_sample_interval) AS events, count(DISTINCT ${i}) AS installs, max(_sample_interval) AS si FROM ${dataset} WHERE ${where}`,
  };
}

/** Daily digest events, the only query spanning several apps: per app, UTC receive day and event name (production data, test devices of these apps left out). */
export const DIGEST_EVENTS = ["first_open", "paywall_view"] as const;

export function digestSql(dataset: string, appIds: string[], fromMs: number, toMs: number, excludedInstalls: readonly string[] = []): string {
  if (!DATASET_RE.test(dataset)) throw new SqlValueError("Invalid dataset");
  if (!appIds.length) throw new SqlValueError("No apps");
  const apps = appIds.map((id) => sqlString(id, APP_ID_RE)).join(", ");
  const names = DIGEST_EVENTS.map((n) => sqlString(n, EVENT_NAME_RE)).join(", ");
  return `SELECT index1 AS app, toStartOfDay(timestamp) AS day, ${COLUMNS.name} AS name, sum(_sample_interval) AS events FROM ${dataset} WHERE index1 IN (${apps}) AND timestamp >= toDateTime(${sec(fromMs)}) AND timestamp < toDateTime(${sec(toMs)}) AND ${COLUMNS.name} IN (${names})${testFilterSql({ excludedInstalls })} GROUP BY app, day, name LIMIT 10000`;
}

export interface StepQuery {
  appId: string;
  name: string;
  filters?: FunnelPropFilter[];
  /** Event time range (double1, ms). */
  fromMs: number;
  toMs: number;
  breakdown?: FunnelBreakdown | null;
  limit: number;
  /** Production data only by default. */
  test?: TestFilter;
}

/** Per install: first and last time of an event step in the range, how many times, sample interval, breakdown value at the first time. */
export function stepSql(dataset: string, q: StepQuery): string {
  if (!DATASET_RE.test(dataset)) throw new SqlValueError("Invalid dataset");
  const ts = COLUMNS.ts;
  // Events are received after they happen (offline queue: up to 7 days later), devices may run up to 1 h ahead.
  const where = [
    appScope(q.appId, q.fromMs - 3_600_000, q.toMs + 8 * 86_400_000, q.test),
    `${COLUMNS.name} = ${sqlString(q.name, EVENT_NAME_RE)}`,
    `${ts} >= ${sqlInt(q.fromMs)}`,
    `${ts} < ${sqlInt(q.toMs)}`,
    ...(q.filters ?? []).map(filterSql),
  ].join(" AND ");
  const extra = q.breakdown ? `, argMin(${breakdownColumn(q.breakdown)}, ${ts}) AS b` : "";
  return `SELECT ${COLUMNS.install} AS install, min(${ts}) AS first, max(${ts}) AS last, count() AS n, max(_sample_interval) AS si${extra} FROM ${dataset} WHERE ${where} GROUP BY install ORDER BY first ASC LIMIT ${sqlInt(q.limit)}`;
}

// --- Running ---------------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
const memory = new Map<string, { rows: Row[]; expires: number }>();
const MAX_CACHED = 300;

/** Counters for tests. */
export const waeStats = { requests: 0, memory: 0, cache: 0 };

export function resetWaeCache() {
  memory.clear();
  waeStats.requests = waeStats.memory = waeStats.cache = 0;
}

function cacheApi(): Cache | null {
  try {
    return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default ?? null;
  } catch {
    return null;
  }
}

/** Runs a query (cached 5 minutes by SQL text). `origin`: the request's, to use the Cache API too. */
export async function runSql(env: Env, sql: string, opts: { origin?: string } = {}): Promise<Row[]> {
  const cfg = analyticsConfig(env);
  const key = `${cfg.accountId}\n${sql}`;
  const hit = memory.get(key);
  if (hit && hit.expires > Date.now()) {
    waeStats.memory++;
    return hit.rows;
  }
  const cache = opts.origin ? cacheApi() : null;
  const cacheUrl = cache ? `${opts.origin}/__revflare/wae/${await sha256Hex(key)}` : "";
  if (cache) {
    const res = await cache.match(cacheUrl).catch(() => undefined);
    if (res) {
      const rows = (await res.json().catch(() => null)) as Row[] | null;
      if (Array.isArray(rows)) {
        waeStats.cache++;
        remember(key, rows);
        return rows;
      }
    }
  }
  waeStats.requests++;
  let res: Response;
  try {
    res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.accountId)}/analytics_engine/sql`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "text/plain" },
      body: sql,
    });
  } catch (err) {
    throw new AnalyticsError(`Analytics Engine SQL API unreachable: ${(err as Error).message}`, 502, "analytics_query_failed");
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { errors?: { message?: string }[] };
      if (j.errors?.[0]?.message) detail = j.errors[0].message;
    } catch {}
    const hint = res.status === 401 || res.status === 403 ? " (check CF_ACCOUNT_ID and that CF_ANALYTICS_TOKEN has Account Analytics Read)" : "";
    throw new AnalyticsError(`Analytics Engine SQL API answered ${res.status}: ${detail}${hint}`, 502, "analytics_query_failed");
  }
  let rows: Row[];
  try {
    const j = JSON.parse(text) as { data?: Row[] };
    rows = Array.isArray(j.data) ? j.data : [];
  } catch {
    throw new AnalyticsError("Analytics Engine SQL API: unexpected response (not JSON)", 502, "analytics_query_failed");
  }
  remember(key, rows);
  if (cache) {
    await cache.put(cacheUrl, new Response(JSON.stringify(rows), { headers: { "content-type": "application/json", "cache-control": `max-age=${QUERY_TTL_MS / 1000}` } })).catch(() => undefined);
  }
  return rows;
}

function remember(key: string, rows: Row[]) {
  if (memory.size >= MAX_CACHED) memory.delete(memory.keys().next().value!);
  memory.set(key, { rows, expires: Date.now() + QUERY_TTL_MS });
}

/** Numbers come back as numbers or strings (64-bit integers) depending on the column type. */
export const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
