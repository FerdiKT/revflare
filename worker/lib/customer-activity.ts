// A customer's recent in-app activity (GET /customers/:id): the latest sessions of their linked RevflareKit installs,
// each with its events in order. Every event lives in Analytics Engine (90 days; app_open, screens, paywall, purchase...),
// read with one SQL query per customer view (cached 5 minutes in the isolate, worker/lib/wae.ts). Without event queries configured
// (or when the query fails) the exact key events stored in the database (app_events) stand in for them.

import type { CustomerActivity, CustomerSession, CustomerSessionEvent } from "../../shared/types";
import type { Db } from "./db";
import { COLUMNS } from "./events";
import { AnalyticsError, analyticsMissing, appScope, datasetName, num, runSql, sqlInt, sqlString } from "./wae";

/** Events read per customer (newest first) before they are grouped into sessions. */
export const ACTIVITY_EVENTS = 300;
/** Sessions returned, newest first. */
export const ACTIVITY_SESSIONS = 8;
/** Events kept per session (after folding repeats): the first ones and the last ones. */
export const SESSION_EVENTS = 40;
/** How far back Analytics Engine is read (its retention). */
const ACTIVITY_DAYS = 90;
/** Without a session id, events further apart than this start a new session. */
const SESSION_GAP_MS = 30 * 60_000;
const DAY = 86_400_000;
const INSTALL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface RawActivityEvent {
  name: string;
  ts: number;
  sessionId: string;
  installId: string;
  appVersion: string;
  environment: string;
  placement: string;
  offering: string;
  product: string;
  step: string;
  screen: string;
}

/** Promoted properties in words: "screen settings · product pro_yearly". */
export function eventDetail(e: Pick<RawActivityEvent, "placement" | "offering" | "product" | "step" | "screen">): string | null {
  const parts: string[] = [];
  if (e.screen) parts.push(`screen ${e.screen}`);
  if (e.step) parts.push(`step ${e.step}`);
  if (e.placement) parts.push(`placement ${e.placement}`);
  if (e.offering) parts.push(`offering ${e.offering}`);
  if (e.product) parts.push(`product ${e.product}`);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * Groups events (any order) into sessions: by session id, else by install and 30-minute gaps. Sessions newest first,
 * events oldest first; consecutive repeats (same name and detail) are folded with a count.
 */
export function groupActivity(raw: RawActivityEvent[], source: CustomerActivity["source"], now: number, truncatedRead = false): CustomerActivity {
  const events = raw.filter((e) => e.name && Number.isFinite(e.ts) && e.ts > 0).map((e) => ({ ...e, ts: Math.min(e.ts, now) }));
  events.sort((a, b) => a.ts - b.ts);
  const groups: { key: string; events: RawActivityEvent[] }[] = [];
  const byKey = new Map<string, { key: string; events: RawActivityEvent[] }>();
  const lastNoSession = new Map<string, { key: string; events: RawActivityEvent[] }>();
  for (const e of events) {
    let g: { key: string; events: RawActivityEvent[] } | undefined;
    if (e.sessionId) {
      const key = `${e.installId}|${e.sessionId}`;
      g = byKey.get(key);
      if (!g) {
        g = { key, events: [] };
        byKey.set(key, g);
        groups.push(g);
      }
    } else {
      const prev = lastNoSession.get(e.installId);
      if (prev && e.ts - prev.events[prev.events.length - 1].ts <= SESSION_GAP_MS) g = prev;
      else {
        g = { key: `${e.installId}|@${e.ts}`, events: [] };
        groups.push(g);
        lastNoSession.set(e.installId, g);
      }
    }
    g.events.push(e);
  }
  const sessions: CustomerSession[] = groups.map((g) => {
    const first = g.events[0];
    const folded: CustomerSessionEvent[] = [];
    for (const e of g.events) {
      const detail = eventDetail(e);
      const prev = folded[folded.length - 1];
      if (prev && prev.name === e.name && prev.detail === detail) prev.count++;
      else folded.push({ name: e.name, ts: e.ts, detail, count: 1 });
    }
    const kept = folded.length > SESSION_EVENTS ? [...folded.slice(0, SESSION_EVENTS / 2), ...folded.slice(-SESSION_EVENTS / 2)] : folded;
    const latest = g.events[g.events.length - 1];
    return {
      sessionId: first.sessionId,
      installId: first.installId,
      startedAt: first.ts,
      endedAt: latest.ts,
      appVersion: latest.appVersion || null,
      environment: latest.environment || null,
      events: kept,
    };
  });
  sessions.sort((a, b) => b.endedAt - a.endedAt);
  return {
    source,
    lastEventAt: events.length ? events[events.length - 1].ts : null,
    sessions: sessions.slice(0, ACTIVITY_SESSIONS),
    truncated: truncatedRead || sessions.length > ACTIVITY_SESSIONS,
  };
}

/** The installs' latest events from the database's exact key events (bounded: ACTIVITY_EVENTS per install). */
export async function keyEventActivity(db: Db, appId: string, installIds: string[], now: number): Promise<CustomerActivity | null> {
  if (!installIds.length) return null;
  const raw: RawActivityEvent[] = [];
  let truncated = false;
  for (const id of installIds) {
    const { results } = await db
      .prepare(
        `SELECT name, ts, session_id, install_id, app_version, environment, placement, offering, product, step, screen
         FROM app_events WHERE app_id = ? AND install_id = ? ORDER BY ts DESC LIMIT ?`,
      )
      .bind(appId, id, ACTIVITY_EVENTS)
      .all<{ name: string; ts: number; session_id: string; install_id: string; app_version: string; environment: string; placement: string; offering: string; product: string; step: string; screen: string }>();
    if (results.length >= ACTIVITY_EVENTS) truncated = true;
    for (const r of results)
      raw.push({
        name: r.name,
        ts: r.ts,
        sessionId: r.session_id,
        installId: r.install_id,
        appVersion: r.app_version,
        environment: r.environment,
        placement: r.placement,
        offering: r.offering,
        product: r.product,
        step: r.step,
        screen: r.screen,
      });
  }
  raw.sort((a, b) => b.ts - a.ts);
  return groupActivity(raw.slice(0, ACTIVITY_EVENTS), "key_events", now, truncated || raw.length > ACTIVITY_EVENTS);
}

/** SQL of the installs' latest events (all environments: this is one customer's own devices). */
export function activitySql(dataset: string, appId: string, installIds: string[], now: number): string {
  // Rounded to 5 minutes so repeated views hit the query cache.
  const to = Math.ceil(now / 300_000) * 300_000 + 300_000;
  const ids = installIds.map((id) => sqlString(id, INSTALL_RE)).join(", ");
  const c = COLUMNS;
  return (
    `SELECT ${c.name} AS name, ${c.ts} AS ts, ${c.session} AS session, ${c.install} AS install, ${c.appVersion} AS app_version, ${c.environment} AS environment, ` +
    `${c.placement} AS placement, ${c.offering} AS offering, ${c.product} AS product, ${c.step} AS step, ${c.screen} AS screen ` +
    `FROM ${dataset} WHERE ${appScope(appId, to - ACTIVITY_DAYS * DAY, to, { includeTest: true })} AND ${c.install} IN (${ids}) ` +
    `ORDER BY ${c.ts} DESC LIMIT ${sqlInt(ACTIVITY_EVENTS)}`
  );
}

/**
 * Every recent event of the installs (Analytics Engine). null when event queries are not configured or the query
 * failed: the caller keeps the key-event activity.
 */
export async function analyticsActivity(env: Env, appId: string, installIds: string[], now: number): Promise<CustomerActivity | null> {
  const ids = installIds.filter((id) => INSTALL_RE.test(id));
  if (!ids.length || !analyticsMissing(env).query) return null;
  try {
    // The isolate's 5-minute cache only (no Cache API copy): customer views are occasional and must show fresh activity.
    const rows = await runSql(env, activitySql(datasetName(env), appId, ids, now));
    const raw: RawActivityEvent[] = rows.map((r) => ({
      name: String(r.name ?? ""),
      ts: num(r.ts),
      sessionId: String(r.session ?? ""),
      installId: String(r.install ?? ""),
      appVersion: String(r.app_version ?? ""),
      environment: String(r.environment ?? ""),
      placement: String(r.placement ?? ""),
      offering: String(r.offering ?? ""),
      product: String(r.product ?? ""),
      step: String(r.step ?? ""),
      screen: String(r.screen ?? ""),
    }));
    if (!raw.length) return null;
    return groupActivity(raw, "events", now, raw.length >= ACTIVITY_EVENTS);
  } catch (err) {
    if (err instanceof AnalyticsError) {
      console.warn(JSON.stringify({ event: "customer_activity_failed", app: appId, error: err.message }));
      return null;
    }
    throw err;
  }
}
