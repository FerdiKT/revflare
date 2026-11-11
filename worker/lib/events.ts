// App events from RevflareKit (POST /sdk/v1/events) → Workers Analytics Engine (binding EVENTS, dataset
// "revflare_events"). Only key events also touch the database (worker/lib/key-events.ts, after the response): the SDK
// key → app lookup is cached in the isolate (with negative caching), the "last event received" note is written at most
// every 10 minutes per isolate and app.
//
// Data point layout (one per event; docs/api.md and docs/funnels.md describe it too):
//   index1   app id (sampling is per index value, so each app is sampled on its own)
//   blob1    event name                 blob10  workspace id
//   blob2    install id (lowercase)     blob11  props JSON ({"key":"value"}, string values)
//   blob3    session id                 blob12  props.placement
//   blob4    app version                blob13  props.offering
//   blob5    app build                  blob14  props.product
//   blob6    OS version                 blob15  props.step
//   blob7    country (request.cf)       blob16  props.screen
//   blob8    locale                     blob17  props.variant
//   blob9    event id                   blob18  environment (production | sandbox | xcode; layout 2)
//   double1  event time (ms, device clock, checked against the server's)
//   double2  received time (ms, server)
//   double3  layout version (2; 1 = before blob18: those events have no environment, read as production)

import { EVENT_LIMITS, EVENT_NAME_RE, EVENT_PROP_KEY_RE, PROMOTED_PROPS } from "../../shared/types";
import type { SdkEnvironment } from "../../shared/types";
import type { Db } from "./db";
import { parseSdkEnvironment } from "./test-data";
import { parseKeyEventConfig, resetKeyEventsState, SDK_APP_TTL_MS, type KeyEventConfig } from "./key-events";

export const EVENTS_LAYOUT_VERSION = 2;
export const DEFAULT_EVENTS_DATASET = "revflare_events";

/** Column of each field (shared with the query side, worker/lib/wae.ts). */
export const COLUMNS = {
  name: "blob1",
  install: "blob2",
  session: "blob3",
  appVersion: "blob4",
  appBuild: "blob5",
  osVersion: "blob6",
  country: "blob7",
  locale: "blob8",
  eventId: "blob9",
  workspace: "blob10",
  props: "blob11",
  placement: "blob12",
  offering: "blob13",
  product: "blob14",
  step: "blob15",
  screen: "blob16",
  variant: "blob17",
  environment: "blob18",
  ts: "double1",
  receivedAt: "double2",
  layout: "double3",
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export interface SdkEvent {
  id: string;
  name: string;
  ts: number;
  sessionId: string;
  props: Record<string, string>;
}

export interface EventBatch {
  installId: string;
  appVersion: string;
  appBuild: string;
  osVersion: string;
  locale: string;
  /** The build (top-level `environment`); missing or invalid = production. */
  environment: SdkEnvironment;
  events: SdkEvent[];
  dropped: number;
}

const short = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "");

/** One event of a batch, or null (dropped). */
export function parseEvent(v: unknown, at: number): SdkEvent | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const e = v as Record<string, unknown>;
  if (typeof e.name !== "string" || !EVENT_NAME_RE.test(e.name)) return null;
  if (typeof e.id !== "string" || !ID_RE.test(e.id)) return null;
  const ts = typeof e.ts === "number" && Number.isFinite(e.ts) ? Math.round(e.ts) : null;
  if (ts === null || ts < at - EVENT_LIMITS.maxAgeMs || ts > at + EVENT_LIMITS.maxFutureMs) return null;
  let sessionId = "";
  if (e.sessionId !== undefined && e.sessionId !== null) {
    if (typeof e.sessionId !== "string" || !ID_RE.test(e.sessionId)) return null;
    sessionId = e.sessionId.toLowerCase();
  }
  const props: Record<string, string> = {};
  if (e.props !== undefined && e.props !== null) {
    if (typeof e.props !== "object" || Array.isArray(e.props)) return null;
    const entries = Object.entries(e.props as Record<string, unknown>).filter(([, x]) => x !== null && x !== undefined);
    if (entries.length > EVENT_LIMITS.propsPerEvent) return null;
    for (const [k, x] of entries) {
      if (!EVENT_PROP_KEY_RE.test(k)) return null;
      let s: string;
      if (typeof x === "string") s = x;
      else if (typeof x === "number" && Number.isFinite(x)) s = String(x);
      else if (typeof x === "boolean") s = x ? "true" : "false";
      else return null;
      if (s.length > EVENT_LIMITS.propValueChars) return null;
      props[k] = s;
    }
  }
  return { id: e.id.toLowerCase(), name: e.name, ts, sessionId, props };
}

/** Validates a request body. Invalid events are dropped (counted); a bad envelope is an error. */
export function parseBatch(body: unknown, at: number): EventBatch | { error: string; status: 400 | 413 } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Expected a JSON object { installId, events: [...] }", status: 400 };
  const b = body as Record<string, unknown>;
  if (typeof b.installId !== "string" || !UUID_RE.test(b.installId)) return { error: "installId (UUID) is required", status: 400 };
  if (!Array.isArray(b.events)) return { error: "events must be a list", status: 400 };
  if (b.events.length > EVENT_LIMITS.eventsPerRequest) return { error: `At most ${EVENT_LIMITS.eventsPerRequest} events per request`, status: 413 };
  const events: SdkEvent[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of b.events) {
    const e = parseEvent(raw, at);
    if (!e || seen.has(e.id)) {
      dropped++;
      continue;
    }
    seen.add(e.id);
    events.push(e);
  }
  return {
    installId: b.installId.toLowerCase(),
    appVersion: short(b.appVersion, 32),
    appBuild: short(b.appBuild, 32),
    osVersion: short(b.osVersion, 32),
    locale: short(b.locale, 16),
    environment: parseSdkEnvironment(b.environment),
    events,
    dropped,
  };
}

/** The Analytics Engine data point of one event (layout at the top of this file). */
export function dataPoint(app: { id: string; workspaceId: string }, batch: EventBatch, e: SdkEvent, country: string, receivedAt: number): AnalyticsEngineDataPoint {
  const promoted = PROMOTED_PROPS.map((k) => e.props[k] ?? "");
  return {
    indexes: [app.id],
    blobs: [e.name, batch.installId, e.sessionId, batch.appVersion, batch.appBuild, batch.osVersion, country, batch.locale, e.id, app.workspaceId, JSON.stringify(e.props), ...promoted, batch.environment],
    doubles: [e.ts, receivedAt, EVENTS_LAYOUT_VERSION],
  };
}

// --- SDK key → app (isolate cache) -----------------------------------------------------------------------------------

export interface SdkApp {
  id: string;
  workspaceId: string;
  /** Key-event patterns, daily cap and retention (worker/lib/key-events.ts); changes reach other isolates within 5 minutes. */
  keyEvents: KeyEventConfig;
}

const APP_TTL_MS = SDK_APP_TTL_MS;
const UNKNOWN_TTL_MS = 60_000;
const MAX_KEYS = 1_000;
const apps = new Map<string, { value: SdkApp | null; expires: number }>();

/** Counters for tests. */
export const sdkAppStats = { memory: 0, database: 0 };

/** The app of an SDK key (null: unknown). One indexed read per key and isolate every 5 minutes (unknown keys: 1 minute). */
export async function sdkApp(db: Db, sdkKey: string): Promise<SdkApp | null> {
  const hit = apps.get(sdkKey);
  if (hit && hit.expires > Date.now()) {
    sdkAppStats.memory++;
    return hit.value;
  }
  sdkAppStats.database++;
  const row = await db.prepare("SELECT id, workspace_id, key_events FROM apps WHERE sdk_key = ?").bind(sdkKey).first<{ id: string; workspace_id: string; key_events: string | null }>();
  const value = row ? { id: row.id, workspaceId: row.workspace_id, keyEvents: parseKeyEventConfig(row.key_events) } : null;
  if (apps.size >= MAX_KEYS) apps.delete(apps.keys().next().value!);
  apps.set(sdkKey, { value, expires: Date.now() + (value ? APP_TTL_MS : UNKNOWN_TTL_MS) });
  return value;
}

/** After a key rotation or a key-events settings change (this isolate; others expire within 5 minutes). */
export function forgetSdkApp(sdkKey: string | null | undefined) {
  if (sdkKey) apps.delete(sdkKey);
}

// --- Rate limits (in-isolate token buckets, counted in events) ------------------------------------------------------

interface Bucket {
  tokens: number;
  at: number;
}

export const RATE_LIMITS = {
  install: { capacity: 1_000, perSecond: 2 },
  app: { capacity: 50_000, perSecond: 1_000 },
};
const MAX_BUCKETS = 20_000;
const buckets = new Map<string, Bucket>();

function bucket(key: string, limit: { capacity: number; perSecond: number }, at: number): Bucket {
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_BUCKETS) buckets.delete(buckets.keys().next().value!);
    b = { tokens: limit.capacity, at };
    buckets.set(key, b);
  } else {
    b.tokens = Math.min(limit.capacity, b.tokens + ((at - b.at) / 1000) * limit.perSecond);
    b.at = at;
  }
  return b;
}

/** Takes `n` events from the install's and the app's buckets. Returns the seconds to wait when over the limit. */
export function takeTokens(appId: string, installId: string, n: number, at = Date.now()): { ok: true } | { ok: false; retryAfter: number } {
  const i = bucket(`i:${appId}:${installId}`, RATE_LIMITS.install, at);
  const a = bucket(`a:${appId}`, RATE_LIMITS.app, at);
  const need = Math.max(n, 1);
  for (const [b, limit] of [
    [i, RATE_LIMITS.install],
    [a, RATE_LIMITS.app],
  ] as const) {
    if (b.tokens < need) {
      const missing = Math.min(need, limit.capacity) - b.tokens;
      return { ok: false, retryAfter: Math.max(1, Math.ceil(missing / limit.perSecond)) };
    }
  }
  i.tokens -= need;
  a.tokens -= need;
  return { ok: true };
}

/** Tests: empty buckets and caches. */
export function resetEventsState() {
  buckets.clear();
  apps.clear();
  lastNoted.clear();
  warnedNoBinding = false;
  sdkAppStats.memory = sdkAppStats.database = 0;
  resetKeyEventsState();
}

// --- Binding and "last event received" ------------------------------------------------------------------------------

/** Tests replace the binding (honoured only with TEST_MODE). */
export const eventsTestHooks: { binding: AnalyticsEngineDataset | null } = { binding: null };

export function eventsBinding(env: Env): AnalyticsEngineDataset | null {
  if (env.TEST_MODE === "true" && eventsTestHooks.binding) return eventsTestHooks.binding;
  return (env as Partial<Pick<Env, "EVENTS">>).EVENTS ?? null;
}

let warnedNoBinding = false;
export function warnNoBinding() {
  if (warnedNoBinding) return;
  warnedNoBinding = true;
  console.warn("POST /sdk/v1/events: no EVENTS Analytics Engine binding, events are dropped (see README, Events and funnels)");
}

const NOTE_EVERY_MS = 10 * 60_000;
const lastNoted = new Map<string, number>();
export const lastEventKey = (appId: string) => `events_last:${appId}`;
/** Last event from a sandbox / Xcode build: shown by the setup status, never read by the event-silence alert (production only). */
export const lastTestEventKey = (appId: string) => `events_last_test:${appId}`;

/** Writes the app's "last event received" note (production or test builds) when this isolate has not written it for 10 minutes. */
export async function noteEventsReceived(db: Db, appId: string, at = Date.now(), test = false): Promise<boolean> {
  const key = test ? lastTestEventKey(appId) : lastEventKey(appId);
  const prev = lastNoted.get(key) ?? 0;
  if (at - prev < NOTE_EVERY_MS) return false;
  if (lastNoted.size >= MAX_KEYS) lastNoted.delete(lastNoted.keys().next().value!);
  lastNoted.set(key, at);
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, String(at))
    .run();
  return true;
}
