// Exact key events (docs/funnels.md#exact-key-events).
//
// Workers Analytics Engine samples an app's events at write time (per index value = app id), so funnels lose installs
// whenever one of their rows is dropped. "Key events" (BUILTIN_KEY_EVENTS plus up to 20 patterns per app) are therefore
// also stored in the database (`app_events`, WITHOUT ROWID, primary key (app_id, id) = dedupe by the client event id),
// and the readers that need exact per-install data (funnels, experiment exposures, funnel alerts, the digest, the events
// page) read them from there when the stored data covers their range. Everything else stays in Analytics Engine only.
//
// Ingest (POST /sdk/v1/events, after the response): the Worker picks the batch's key events with the app's cached
// patterns (no database work for a batch without key events) and makes one database call (storeKeyEvents) that:
//   - skips the day once it is incomplete (`app_event_days.capped`: 1 = the app's daily cap, 2 = the instance's daily
//     background budget, worker/lib/budget.ts, 3 = a store failed) — the Worker remembers that too and stops calling
//     for the day;
//   - caps each install at KEY_EVENT_LIMITS.perInstallPerDay key events a UTC day (anti-abuse only, approximate: a
//     counter in the database object's memory keyed by the UTC day of reception; an install it has no counter for —
//     first sight today, or after a restart — is counted once from the (app_id, install_id, ts) index by event time, so
//     events received today but sent from an offline queue count against yesterday's events, and the reverse);
//   - caps the app at its daily cap (default: min(50,000, background writes a day / 3 / 2), so on the Free plan key
//     events use at most about half the background write budget): over it, the rest of the day is Analytics Engine
//     only, the day is flagged and one `key_events_capped` alert is raised (key per app and day);
//   - INSERT OR IGNOREs the rows, 5 per statement (17 columns, ≤ 100 bound parameters), in one batch (RETURNING the
//     names actually inserted), adds them to the day's counter and to the per-name daily rollup `app_event_counts`
//     (one upsert row per distinct name; production and test builds counted apart); all of it metered against the
//     daily background budget.
// A failed store must not leave a day claiming exactness: the Worker retries once; if it fails again it remembers the
// (app, day) in the isolate (failedDays) and the next call for that app (storeKeyEvents) passes it in `markIncomplete`,
// which flags the day (capped = 3, readers fall back to sampled data). A failure the database object sees itself
// (an exception while writing) flags the day at once. (A failure followed by no other key event of the app in the same
// isolate is not flagged: best effort.)
// Coverage: `apps.key_events_since` is the first full UTC day stored: the day after the first stored key event received
// SDK_APP_TTL_MS earlier (other isolates may still use a config without storage for that long); a pattern added later
// covers its events from the day after (added + SDK_APP_TTL_MS), for the same reason; days older than the retention are
// gone. A read is exact when every event it needs is covered from the start of
// its range and no day of the range is incomplete; otherwise it uses Analytics Engine for the whole range (and says
// why in a note). Mixing exact and sampled days in one funnel would mix per-install histories of different quality.
// Events page (exactSummaryLocal): counts per name and UTC day of reception (like Analytics Engine) from the rollup
// `app_event_counts`; only unique installs scan app_events (COUNT(DISTINCT install_id)), and only when the range holds at
// most EXACT_SUMMARY_MAX_ROWS stored key events (else Analytics Engine, with a note). Test data: the rollup keeps
// production and test builds (sandbox / Xcode) apart, so `includeTest` adds both; the default view (production, the
// app's test devices left out) subtracts the test devices' production rows, read through the (app_id, install_id, ts)
// index (a few devices, at most perInstallPerDay rows a day each).
// Retention: pruneKeyEvents (cron, once a day, ≤ RETENTION_ROWS_PER_TICK rows a tick through the (app_id, name, ts) index).

import {
  BUILTIN_KEY_EVENTS,
  EVENT_LIMITS,
  EXPERIMENT_EXPOSURE_EVENT,
  KEY_EVENT_LIMITS,
  KEY_EVENT_PATTERN_RE,
  PROMOTED_PROPS,
  type FunnelBreakdown,
  type FunnelPropFilter,
  type KeyEventSettings,
  type SdkEnvironment,
} from "../../shared/types";
import { raiseAlert } from "./alert-store";
import { backgroundAllowed, budgets, metered } from "./budget";
import { defineDbFunction, type Db } from "./db";
import type { EventBatch } from "./events";
import type { StepHit } from "./funnels";
import { addDays, dayOf, dayStart } from "./money";
import { getSetting, setSetting } from "./settings";
import { excludeInstallsSql } from "./test-data";
import { errorMessage, now, parseJson } from "./util";

const DAY = 86_400_000;
/** Columns of app_events: rows per INSERT statement = floor(100 / columns). */
const INSERT_COLUMNS = ["app_id", "id", "install_id", "session_id", "name", "ts", "received_at", "app_version", "country", "environment", "props", ...PROMOTED_PROPS] as const;
export const ROWS_PER_INSERT = Math.floor(100 / INSERT_COLUMNS.length);
/** Exact reads give up (sampled data instead) when the range holds more stored key events than this. */
export const EXACT_MAX_ROWS = 1_000_000;
/** The events page's exact path (one COUNT(DISTINCT install_id) scan) gives up above this many stored key events. */
export const EXACT_SUMMARY_MAX_ROWS = 150_000;
/** How long an isolate keeps an app's key-event config (worker/lib/events.ts sdkApp). */
export const SDK_APP_TTL_MS = 5 * 60_000;
/** Rows written per stored key event (the row and its two index entries): sizes the default daily cap. */
export const WRITES_PER_KEY_EVENT = 3;
/** Rollup upsert rows per statement (6 columns, ≤ 100 bound parameters). */
const COUNT_ROWS_PER_UPSERT = 16;
/** Events are accepted up to 7 days after they happened and up to 1 hour ahead (EVENT_LIMITS). */
const MAX_AGE_MS = EVENT_LIMITS.maxAgeMs;
const MAX_FUTURE_MS = EVENT_LIMITS.maxFutureMs;
/** Retention: rows deleted per cron tick at most. */
export const RETENTION_ROWS_PER_TICK = 5_000;
/** Names listed per app by the events page (distinct names, one index seek each). */
const MAX_NAMES = 200;

// --- Settings -----------------------------------------------------------------------------------------------------------

export interface KeyEventPattern {
  /** The pattern as entered. */
  p: string;
  /** When it was added (ms): its events are covered from the next UTC day. */
  at: number;
}

export interface KeyEventConfig {
  patterns: KeyEventPattern[];
  /** null: the instance's default (defaultDailyCap). */
  dailyCap: number | null;
  retentionDays: number;
}

export const DEFAULT_KEY_EVENT_CONFIG: KeyEventConfig = { patterns: [], dailyCap: null, retentionDays: KEY_EVENT_LIMITS.defaultRetentionDays };

/**
 * Default daily cap of an app: KEY_EVENT_LIMITS.defaultDailyCap, but at most half the instance's daily background write
 * budget at WRITES_PER_KEY_EVENT rows an event (Free plan defaults: 55,000 / 3 / 2 = 9,166).
 */
export function defaultDailyCap(env: Env): number {
  return Math.max(0, Math.min(KEY_EVENT_LIMITS.defaultDailyCap, Math.floor(budgets(env).writes / WRITES_PER_KEY_EVENT / 2)));
}

export const effectiveDailyCap = (cfg: KeyEventConfig, env: Env) => cfg.dailyCap ?? defaultDailyCap(env);

const intIn = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** Stored JSON (apps.key_events) → config; invalid parts fall back to the defaults. */
export function parseKeyEventConfig(json: string | null | undefined): KeyEventConfig {
  const raw = parseJson<Record<string, unknown> | null>(json, null);
  if (!raw || typeof raw !== "object") return DEFAULT_KEY_EVENT_CONFIG;
  const patterns = Array.isArray(raw.patterns)
    ? raw.patterns
        .filter((x): x is KeyEventPattern => !!x && typeof x === "object" && typeof (x as KeyEventPattern).p === "string" && KEY_EVENT_PATTERN_RE.test((x as KeyEventPattern).p))
        .map((x) => ({ p: x.p, at: Number(x.at) || 0 }))
        .slice(0, KEY_EVENT_LIMITS.patterns)
    : [];
  return {
    patterns,
    dailyCap: intIn(raw.dailyCap, 0, KEY_EVENT_LIMITS.maxDailyCap) ? raw.dailyCap : null,
    retentionDays: intIn(raw.retentionDays, KEY_EVENT_LIMITS.minRetentionDays, KEY_EVENT_LIMITS.maxRetentionDays) ? raw.retentionDays : KEY_EVENT_LIMITS.defaultRetentionDays,
  };
}

/** Case-insensitive: `*suffix`, `prefix*` or an exact name. */
export function patternMatches(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  if (p.startsWith("*")) return n.endsWith(p.slice(1));
  if (p.endsWith("*")) return n.startsWith(p.slice(0, -1));
  return n === p;
}

export const isBuiltinKeyEvent = (name: string) => BUILTIN_KEY_EVENTS.some((p) => patternMatches(p, name));

export function isKeyEvent(cfg: KeyEventConfig, name: string): boolean {
  return cfg.dailyCap !== 0 && (isBuiltinKeyEvent(name) || cfg.patterns.some((x) => patternMatches(x.p, name)));
}

/** First UTC day from which every event named `name` is stored; null: not a key event, or nothing stored yet. */
export function coverageDay(cfg: KeyEventConfig, since: string | null, name: string, today: string): string | null {
  if (!since || cfg.dailyCap === 0) return null;
  let from = since;
  if (!isBuiltinKeyEvent(name)) {
    const added = cfg.patterns.filter((x) => patternMatches(x.p, name)).map((x) => x.at);
    if (!added.length) return null;
    // Isolates keep the previous patterns for up to SDK_APP_TTL_MS: the first full day is the one after that.
    const next = addDays(dayOf(Math.min(...added) + SDK_APP_TTL_MS), 1);
    if (next > from) from = next;
  }
  const kept = addDays(today, -cfg.retentionDays);
  return from > kept ? from : kept;
}

/** Validates a PUT body merged over the current config (patterns keep their `at` when unchanged). */
export function parseKeyEventUpdate(body: unknown, prev: KeyEventConfig, at = now()): KeyEventConfig | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Expected a JSON object { patterns?, dailyCap?, retentionDays? }" };
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !["patterns", "dailyCap", "retentionDays"].includes(k));
  if (unknown.length) return { error: `Unknown field ${unknown[0]} (patterns, dailyCap, retentionDays)` };
  let patterns = prev.patterns;
  if (b.patterns !== undefined) {
    if (!Array.isArray(b.patterns)) return { error: "patterns must be a list of event names or patterns" };
    const next: KeyEventPattern[] = [];
    for (const raw of b.patterns) {
      const p = typeof raw === "string" ? raw.trim() : "";
      if (!KEY_EVENT_PATTERN_RE.test(p))
        return { error: `${JSON.stringify(raw)} is not an event name or pattern (letters, digits, _ . : -, at most 64 characters, one * at the start or the end)` };
      if (next.some((x) => x.p.toLowerCase() === p.toLowerCase())) continue;
      next.push({ p, at: prev.patterns.find((x) => x.p.toLowerCase() === p.toLowerCase())?.at ?? at });
    }
    if (next.length > KEY_EVENT_LIMITS.patterns) return { error: `At most ${KEY_EVENT_LIMITS.patterns} patterns per app` };
    patterns = next;
  }
  let dailyCap = prev.dailyCap;
  if (b.dailyCap !== undefined) {
    if (b.dailyCap !== null && !intIn(b.dailyCap, 0, KEY_EVENT_LIMITS.maxDailyCap))
      return { error: `dailyCap must be an integer from 0 (store none) to ${KEY_EVENT_LIMITS.maxDailyCap}, or null (the instance's default)` };
    dailyCap = b.dailyCap;
  }
  let retentionDays = prev.retentionDays;
  if (b.retentionDays !== undefined) {
    if (!intIn(b.retentionDays, KEY_EVENT_LIMITS.minRetentionDays, KEY_EVENT_LIMITS.maxRetentionDays))
      return { error: `retentionDays must be an integer from ${KEY_EVENT_LIMITS.minRetentionDays} to ${KEY_EVENT_LIMITS.maxRetentionDays}` };
    retentionDays = b.retentionDays;
  }
  return { patterns, dailyCap, retentionDays };
}

interface AppKeyRow {
  id: string;
  key_events: string | null;
  key_events_since: string | null;
}

async function appKeyRow(db: Db, appId: string): Promise<AppKeyRow | null> {
  return db.prepare("SELECT id, key_events, key_events_since FROM apps WHERE id = ?").bind(appId).first<AppKeyRow>();
}

export async function keyEventSettings(env: Env, db: Db, appId: string, at = now()): Promise<KeyEventSettings | null> {
  const row = await appKeyRow(db, appId);
  if (!row) return null;
  const cfg = parseKeyEventConfig(row.key_events);
  const dailyCap = effectiveDailyCap(cfg, env);
  const today = dayOf(at);
  const day = await db.prepare("SELECT count, capped FROM app_event_days WHERE app_id = ? AND day = ?").bind(appId, today).first<{ count: number; capped: number }>();
  return {
    appId,
    builtin: [...BUILTIN_KEY_EVENTS],
    patterns: cfg.patterns.map((x) => x.p),
    dailyCap,
    dailyCapIsDefault: cfg.dailyCap === null,
    defaultDailyCap: defaultDailyCap(env),
    backgroundWritesPerDay: budgets(env).writes,
    writesPerEvent: WRITES_PER_KEY_EVENT,
    retentionDays: cfg.retentionDays,
    since: dailyCap > 0 ? row.key_events_since : null,
    today: { date: today, count: day?.count ?? 0, capped: !!day?.capped },
    limits: {
      patterns: KEY_EVENT_LIMITS.patterns,
      maxDailyCap: KEY_EVENT_LIMITS.maxDailyCap,
      minRetentionDays: KEY_EVENT_LIMITS.minRetentionDays,
      maxRetentionDays: KEY_EVENT_LIMITS.maxRetentionDays,
      perInstallPerDay: KEY_EVENT_LIMITS.perInstallPerDay,
    },
  };
}

/**
 * PUT /apps/:id/key-events. Turning storage back on (dailyCap from 0) restarts the coverage: the days in between were
 * not stored. Raising the cap does not reopen today once it is flagged (the day stays sampled).
 */
export async function updateKeyEventSettings(env: Env, db: Db, appId: string, body: unknown, at = now()): Promise<KeyEventSettings | { error: string; status: 400 | 404 }> {
  const row = await appKeyRow(db, appId);
  if (!row) return { error: "Not found", status: 404 };
  const prev = parseKeyEventConfig(row.key_events);
  const next = parseKeyEventUpdate(body, prev, at);
  if ("error" in next) return { error: next.error, status: 400 };
  const restart = prev.dailyCap === 0 && next.dailyCap !== 0;
  await db
    .prepare(`UPDATE apps SET key_events = ?${restart ? ", key_events_since = NULL" : ""} WHERE id = ?`)
    .bind(JSON.stringify(next), appId)
    .run();
  return (await keyEventSettings(env, db, appId, at))!;
}

// --- Ingest (Worker side) -------------------------------------------------------------------------------------------------

export interface KeyEventRow {
  id: string;
  name: string;
  ts: number;
  sessionId: string;
  props: string;
  promoted: string[];
}

export interface StoreArgs {
  appId: string;
  workspaceId: string;
  installId: string;
  environment: SdkEnvironment;
  appVersion: string;
  country: string;
  receivedAt: number;
  /** null: the instance's default (resolved in the database object). */
  dailyCap: number | null;
  events: KeyEventRow[];
  /** Earlier UTC days whose store failed in this isolate: flagged incomplete (capped = 3) before anything else. */
  markIncomplete?: string[];
}

export interface StoreResult {
  stored: number;
  /** The day is incomplete (cap or background budget): later batches today are not sent. */
  dayClosed: boolean;
  /** Events left out by the per-install cap. */
  installCapped: number;
}

// Days this isolate knows are closed (app → UTC day), and installs it knows are over their cap (app:install → day).
const closedDays = new Map<string, string>();
const fullInstalls = new Map<string, string>();
const MAX_TRACKED = 20_000;
// Days whose store failed (twice) in this isolate, per app: sent in the next call's markIncomplete.
const failedDays = new Map<string, Set<string>>();
const MAX_FAILED_DAYS = 7;

function remember(map: Map<string, string>, key: string, day: string) {
  if (!map.has(key) && map.size >= MAX_TRACKED) map.delete(map.keys().next().value!);
  map.set(key, day);
}

/** The batch's key events as rows for storeKeyEvents; null: nothing to store (no database call). */
export function keyEventArgs(app: { id: string; workspaceId: string; keyEvents: KeyEventConfig }, batch: EventBatch, country: string, receivedAt: number): StoreArgs | null {
  const cfg = app.keyEvents;
  if (cfg.dailyCap === 0) return null;
  const day = dayOf(receivedAt);
  const failed = failedDays.get(app.id);
  const markIncomplete = failed?.size ? [...failed] : undefined;
  // With failed days to flag the call is made anyway (with no events when this day or install is closed).
  const closed = closedDays.get(app.id) === day || fullInstalls.get(`${app.id}:${batch.installId}`) === day;
  if (closed && !markIncomplete) return null;
  const events: KeyEventRow[] = [];
  if (!closed)
    for (const e of batch.events) {
      if (!isKeyEvent(cfg, e.name)) continue;
      events.push({ id: e.id, name: e.name, ts: e.ts, sessionId: e.sessionId, props: JSON.stringify(e.props), promoted: PROMOTED_PROPS.map((k) => e.props[k] ?? "") });
    }
  if (!events.length && !markIncomplete) return null;
  return {
    appId: app.id,
    workspaceId: app.workspaceId,
    installId: batch.installId,
    environment: batch.environment,
    appVersion: batch.appVersion,
    country,
    receivedAt,
    dailyCap: cfg.dailyCap,
    events,
    ...(markIncomplete ? { markIncomplete } : {}),
  };
}

/** Notes the database's answer in this isolate (closed day, install over its cap, failed days now flagged). */
export function noteStoreResult(args: StoreArgs, r: StoreResult) {
  const day = dayOf(args.receivedAt);
  if (r.dayClosed) remember(closedDays, args.appId, day);
  if (r.installCapped) remember(fullInstalls, `${args.appId}:${args.installId}`, day);
  const failed = failedDays.get(args.appId);
  if (failed && args.markIncomplete) {
    for (const d of args.markIncomplete) failed.delete(d);
    if (!failed.size) failedDays.delete(args.appId);
  }
}

function noteStoreFailure(args: StoreArgs) {
  let set = failedDays.get(args.appId);
  if (!set) {
    if (failedDays.size >= MAX_TRACKED) failedDays.delete(failedDays.keys().next().value!);
    failedDays.set(args.appId, (set = new Set()));
  }
  set.add(dayOf(args.receivedAt));
  for (const d of args.markIncomplete ?? []) set.add(d);
  // Oldest days first out (they are past the readers' interest sooner).
  while (set.size > MAX_FAILED_DAYS) set.delete([...set].sort()[0]!);
}

/** Tests: forget the isolate's state (both sides: this runs in the database object too in tests). */
export function resetKeyEventsState() {
  closedDays.clear();
  fullInstalls.clear();
  failedDays.clear();
  installCounts.clear();
}

/**
 * Tests: `failStore` = how many of the next store calls fail before reaching the database (Infinity: all);
 * `failWrite`: the next write inside the database object throws (a failure the object sees itself).
 */
export const keyEventsTestHooks: { failStore: number; failWrite: boolean } = { failStore: 0, failWrite: false };

// --- Ingest (inside the database object) ----------------------------------------------------------------------------------

/**
 * Per install and UTC day of reception: key events stored (in the database object's memory; see the top of this file).
 * Anti-abuse only: approximate (seeded by event time after a restart, forgotten on eviction).
 */
const installCounts = new Map<string, { day: string; n: number }>();
const MAX_INSTALL_COUNTS = 100_000;

async function installCount(db: Db, appId: string, installId: string, day: string): Promise<number> {
  const key = `${appId}:${installId}`;
  const hit = installCounts.get(key);
  if (hit && hit.day === day) return hit.n;
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM app_events WHERE app_id = ? AND install_id = ? AND ts >= ?")
    .bind(appId, installId, dayStart(day))
    .first<{ n: number }>();
  const n = row?.n ?? 0;
  if (!hit && installCounts.size >= MAX_INSTALL_COUNTS) installCounts.delete(installCounts.keys().next().value!);
  installCounts.set(key, { day, n });
  return n;
}

const INSERT_SQL = (rows: number) =>
  `INSERT OR IGNORE INTO app_events (${INSERT_COLUMNS.join(", ")}) VALUES ${Array.from({ length: rows }, () => `(${INSERT_COLUMNS.map(() => "?").join(", ")})`).join(", ")}`;

/** Why a day is incomplete (app_event_days.capped). */
export const INCOMPLETE = { cap: 1, budget: 2, storeFailed: 3 } as const;

async function closeDay(env: Env, db: Db, args: StoreArgs, day: string, reason: 1 | 2 | 3, dailyCap = 0) {
  const r = await db
    .prepare(
      `INSERT INTO app_event_days (app_id, day, count, capped) VALUES (?, ?, 0, ?)
       ON CONFLICT(app_id, day) DO UPDATE SET capped = excluded.capped WHERE app_event_days.capped = 0`,
    )
    .bind(args.appId, day, reason)
    .run();
  if (!r.meta.changes) return;
  const app = await db.prepare("SELECT name FROM apps WHERE id = ?").bind(args.appId).first<{ name: string }>();
  const name = app?.name ?? args.appId;
  // No push: the iOS app has no texts for it (loc-keys); the alert shows in Alerts, the web app and the MCP / CLI.
  await raiseAlert(env, db, {
    workspaceId: args.workspaceId,
    appId: args.appId,
    key: `key_events_capped:${args.appId}:${day}`,
    kind: "key_events_capped",
    severity: "warning",
    title: reason === 3 ? `Key events incomplete for ${name} on ${day}` : `Key events capped for ${name} today`,
    body:
      reason === 1
        ? `${name} reached its daily cap of ${dailyCap.toLocaleString("en-US")} stored key events on ${day} (UTC). The rest of the day is kept in Analytics Engine only, so funnels, experiments and the events page use sampled data for ranges including ${day}. Raise the cap in the app's Key events settings if this is normal traffic.`
        : reason === 2
          ? `The instance's daily background budget (database rows) was used up on ${day} (UTC): ${name}'s key events are kept in Analytics Engine only for the rest of the day, and reads including ${day} use sampled data.`
          : `Storing ${name}'s key events failed on ${day} (UTC) (database restart, deploy or error): some of that day's key events are only in Analytics Engine, so reads including ${day} use sampled data.`,
  });
}

const COUNTS_SQL = (rows: number) =>
  `INSERT INTO app_event_counts (app_id, day, name, count, test_count, last) VALUES ${Array.from({ length: rows }, () => "(?, ?, ?, ?, ?, ?)").join(", ")}
   ON CONFLICT(app_id, day, name) DO UPDATE SET count = app_event_counts.count + excluded.count, test_count = app_event_counts.test_count + excluded.test_count,
   last = MAX(app_event_counts.last, excluded.last)`;

async function storeLocal(env: Env, db: Db, args: StoreArgs): Promise<StoreResult> {
  const day = dayOf(args.receivedAt);
  // Days whose store failed in the Worker: flagged first (readers fall back to sampled data for them).
  for (const d of (args.markIncomplete ?? []).slice(0, MAX_FAILED_DAYS)) if (/^\d{4}-\d{2}-\d{2}$/.test(d)) await closeDay(env, db, args, d, INCOMPLETE.storeFailed);
  const dayRow = await db.prepare("SELECT count, capped FROM app_event_days WHERE app_id = ? AND day = ?").bind(args.appId, day).first<{ count: number; capped: number }>();
  if (dayRow?.capped) return { stored: 0, dayClosed: true, installCapped: 0 };
  if (!args.events.length) return { stored: 0, dayClosed: false, installCapped: 0 };
  if (!(await backgroundAllowed(db, env))) {
    await closeDay(env, db, args, day, INCOMPLETE.budget);
    return { stored: 0, dayClosed: true, installCapped: 0 };
  }
  const dailyCap = args.dailyCap ?? defaultDailyCap(env);
  try {
    return await metered(
      db,
      async () => {
        const perInstall = Math.max(0, KEY_EVENT_LIMITS.perInstallPerDay - (await installCount(db, args.appId, args.installId, day)));
        const perDay = Math.max(0, dailyCap - (dayRow?.count ?? 0));
        const take = Math.min(args.events.length, perInstall, perDay);
        const rows = args.events.slice(0, take);
        let stored = 0;
        if (rows.length) {
          if (env.TEST_MODE === "true" && keyEventsTestHooks.failWrite) {
            keyEventsTestHooks.failWrite = false;
            throw new Error("Simulated write failure (test)");
          }
          const stmts = [];
          for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
            const chunk = rows.slice(i, i + ROWS_PER_INSERT);
            const params: (string | number)[] = [];
            for (const e of chunk)
              params.push(args.appId, e.id, args.installId, e.sessionId, e.name, e.ts, args.receivedAt, args.appVersion, args.country, args.environment, e.props, ...e.promoted);
            stmts.push(db.prepare(`${INSERT_SQL(chunk.length)} RETURNING name`).bind(...params));
          }
          // RETURNING: only the rows actually inserted (a retried batch returns none), for the per-name rollup.
          const results = await db.batch<{ name: string }>(stmts);
          const perName = new Map<string, number>();
          for (const r of results) for (const x of r.results) perName.set(x.name, (perName.get(x.name) ?? 0) + 1);
          stored = [...perName.values()].reduce((a, b) => a + b, 0);
          const c = installCounts.get(`${args.appId}:${args.installId}`);
          if (c && c.day === day) c.n += stored;
          if (stored) {
            const test = args.environment !== "production";
            const counts = [...perName.entries()];
            const upserts = [
              db
                .prepare(
                  `INSERT INTO app_event_days (app_id, day, count, capped) VALUES (?, ?, ?, 0)
                   ON CONFLICT(app_id, day) DO UPDATE SET count = app_event_days.count + excluded.count`,
                )
                .bind(args.appId, day, stored),
            ];
            for (let i = 0; i < counts.length; i += COUNT_ROWS_PER_UPSERT) {
              const chunk = counts.slice(i, i + COUNT_ROWS_PER_UPSERT);
              upserts.push(db.prepare(COUNTS_SQL(chunk.length)).bind(...chunk.flatMap(([name, n]) => [args.appId, day, name, test ? 0 : n, test ? n : 0, args.receivedAt])));
            }
            await db.batch(upserts);
          }
        }
        // The app's first stored key event: its coverage starts with the first full day after other isolates picked the
        // config up (they keep the previous one for up to SDK_APP_TTL_MS).
        if (stored && !dayRow)
          await db
            .prepare("UPDATE apps SET key_events_since = ? WHERE id = ? AND key_events_since IS NULL")
            .bind(addDays(dayOf(args.receivedAt + SDK_APP_TTL_MS), 1), args.appId)
            .run();
        // The day's cap (not the install's) is what stopped the batch: close the day.
        const dayCapped = perDay < args.events.length && perDay <= perInstall;
        if (dayCapped) await closeDay(env, db, args, day, INCOMPLETE.cap, dailyCap);
        return { stored, dayClosed: dayCapped, installCapped: !dayCapped && perInstall < args.events.length ? args.events.length - perInstall : 0 };
      },
      { prune: false },
    );
  } catch (err) {
    // A failed write here: the day is incomplete (flagged if the database still answers; else the Worker remembers it).
    console.error("key events store failed in the database", errorMessage(err));
    await closeDay(env, db, args, day, INCOMPLETE.storeFailed);
    return { stored: 0, dayClosed: true, installCapped: 0 };
  }
}

const storeRemote = defineDbFunction("keyEvents.store", async (db, args: StoreArgs, env): Promise<StoreResult> => storeLocal(env, db, args));

async function storeOnce(env: Env, args: StoreArgs): Promise<StoreResult> {
  if (env.TEST_MODE === "true" && keyEventsTestHooks.failStore > 0) {
    keyEventsTestHooks.failStore--;
    throw new Error("Simulated database failure (test)");
  }
  return storeRemote(env, args);
}

/**
 * One database call per request with key events (see the top of this file), retried once. A second failure (database
 * object restarting after a deploy, "Unknown database function" while the previous code still runs, eviction) is
 * remembered: the next call for the app flags the day incomplete. Notes the answer in the isolate (noteStoreResult).
 */
export async function storeKeyEvents(env: Env, args: StoreArgs): Promise<StoreResult> {
  let r: StoreResult;
  try {
    r = await storeOnce(env, args);
  } catch (first) {
    console.error("key events store failed, retrying", errorMessage(first));
    try {
      r = await storeOnce(env, args);
    } catch (err) {
      noteStoreFailure(args);
      throw err;
    }
  }
  noteStoreResult(args, r);
  return r;
}

// --- Retention ------------------------------------------------------------------------------------------------------------

/**
 * Deletes key events older than each app's retention, at most `maxRows` per call, through the (app_id, name, ts) index
 * (the names of an app are found with one index seek each). Runs from the cron until a pass finishes the day
 * (settings `key_events_pruned` = the UTC day): one settings read per tick afterwards.
 */
export async function pruneKeyEvents(db: Db, at: number, maxRows = RETENTION_ROWS_PER_TICK): Promise<{ deleted: number; done: boolean } | null> {
  const today = dayOf(at);
  if ((await getSetting(db, "key_events_pruned")) === today) return null;
  return metered(db, async () => {
    const { results: apps } = await db.prepare("SELECT id, key_events FROM apps WHERE key_events_since IS NOT NULL ORDER BY id").all<{ id: string; key_events: string | null }>();
    let left = maxRows;
    for (const a of apps) {
      const cfg = parseKeyEventConfig(a.key_events);
      const cutoffDay = addDays(today, -cfg.retentionDays);
      const cutoff = dayStart(cutoffDay);
      let name = "";
      for (let n = 0; n < MAX_NAMES * 5; n++) {
        const next = await db.prepare("SELECT name FROM app_events WHERE app_id = ? AND name > ? ORDER BY name LIMIT 1").bind(a.id, name).first<{ name: string }>();
        if (!next) break;
        name = next.name;
        while (left > 0) {
          const limit = Math.min(left, 1_000);
          const r = await db
            .prepare("DELETE FROM app_events WHERE app_id = ? AND id IN (SELECT id FROM app_events WHERE app_id = ? AND name = ? AND ts < ? LIMIT ?)")
            .bind(a.id, a.id, name, cutoff, limit)
            .run();
          left -= r.meta.changes;
          if (r.meta.changes < limit) break;
        }
        if (left <= 0) return { deleted: maxRows - left, done: false };
      }
      await db.prepare("DELETE FROM app_event_days WHERE app_id = ? AND day < ?").bind(a.id, cutoffDay).run();
      await db.prepare("DELETE FROM app_event_counts WHERE app_id = ? AND day < ?").bind(a.id, cutoffDay).run();
    }
    await setSetting(db, "key_events_pruned", today);
    return { deleted: maxRows - left, done: true };
  });
}

// --- Exact reads (inside the database object) -----------------------------------------------------------------------------

export interface ExactTest {
  /** Count sandbox / Xcode builds and the test devices too. */
  includeTest?: boolean;
  excludedInstalls?: readonly string[];
}

const testSql = (test: ExactTest = {}) => (test.includeTest ? "" : ` AND environment = 'production'${excludeInstallsSql("install_id", test.excludedInstalls ?? [])}`);

export type Plan = { exact: true } | { exact: false; note: string | null };

/**
 * No incomplete day in fromDay..toDay and at most `maxRows` stored key events in sizeFrom..toDay (≤ 1 row read per
 * day); else why not.
 */
async function daysProblem(db: Db, appId: string, fromDay: string, toDay: string, maxRows = EXACT_MAX_ROWS, sizeFrom = fromDay): Promise<string | null> {
  const { results } = await db
    .prepare("SELECT day, count, capped FROM app_event_days WHERE app_id = ? AND day >= ? AND day <= ?")
    .bind(appId, sizeFrom < fromDay ? sizeFrom : fromDay, toDay)
    .all<{ day: string; count: number; capped: number }>();
  const capped = results.filter((r) => r.capped && r.day >= fromDay).map((r) => r.day);
  if (capped.length) return `Key events are incomplete on ${capped.slice(0, 3).join(", ")}${capped.length > 3 ? "…" : ""} (daily cap, background budget or a failed write): this range uses sampled data.`;
  if (results.filter((r) => r.day >= sizeFrom).reduce((s, r) => s + r.count, 0) > maxRows)
    return `More than ${maxRows.toLocaleString("en-US")} key events in this range: sampled data is used.`;
  return null;
}

/**
 * Whether these event names can be read exactly for the UTC days fromDay..toDay: every name covered since fromDay, no
 * incomplete day, at most EXACT_MAX_ROWS stored key events in the range. Reads the app row and ≤ 1 row per day.
 */
export async function exactPlan(db: Db, appId: string, names: string[], fromDay: string, toDay: string, at = now()): Promise<Plan> {
  const row = await appKeyRow(db, appId);
  if (!row) return { exact: false, note: null };
  const cfg = parseKeyEventConfig(row.key_events);
  const today = dayOf(at);
  let start: string | null = null;
  for (const n of names) {
    const d = coverageDay(cfg, row.key_events_since, n, today);
    if (!d) return { exact: false, note: null };
    if (!start || d > start) start = d;
  }
  if (start && start > fromDay) return { exact: false, note: `Exact data starts ${start}; earlier days are sampled, so this range uses sampled data.` };
  const problem = await daysProblem(db, appId, fromDay, toDay);
  return problem ? { exact: false, note: problem } : { exact: true };
}

/** Breakdowns with a column in app_events (os_version and locale are only in Analytics Engine). */
const BREAKDOWN_COLUMNS: Partial<Record<FunnelBreakdown, string>> = {
  app_version: "app_version",
  country: "country",
  placement: "placement",
  offering: "offering",
  product: "product",
  step: "step",
  screen: "screen",
  variant: "variant",
};
export const exactBreakdown = (b: FunnelBreakdown | null | undefined) => !b || !!BREAKDOWN_COLUMNS[b];

function filterSql(filters: FunnelPropFilter[] = []): { sql: string; params: string[] } {
  let sql = "";
  const params: string[] = [];
  for (const f of filters) {
    if ((PROMOTED_PROPS as readonly string[]).includes(f.key)) {
      sql += ` AND ${f.key} = ?`;
      params.push(f.value);
    } else {
      sql += " AND json_extract(props, ?) = ?";
      params.push(`$."${f.key}"`, f.value);
    }
  }
  return { sql, params };
}

export interface ExactStepQuery {
  appId: string;
  name: string;
  filters?: FunnelPropFilter[];
  /** Event time range (ts, ms). */
  fromMs: number;
  toMs: number;
  breakdown?: FunnelBreakdown | null;
  limit: number;
  test?: ExactTest;
}

/**
 * Per install: first / last time of an event step in the range, how many times and (breakdown) the value at the first
 * time — the shape of Analytics Engine's step data. Reads the step's rows through (app_id, name, ts), plus one index
 * probe per install for a breakdown. First `limit` installs by first time.
 */
export async function exactStepData(db: Db, q: ExactStepQuery): Promise<[string, StepHit][]> {
  const f = filterSql(q.filters);
  const col = q.breakdown ? BREAKDOWN_COLUMNS[q.breakdown] : undefined;
  if (q.breakdown && !col) throw new Error(`No exact breakdown by ${q.breakdown}`);
  const where = `app_id = ? AND name = ? AND ts >= ? AND ts < ?${testSql(q.test)}${f.sql}`;
  // The value at the first time of the step: the same filters and test clause as the outer query (unqualified columns
  // resolve to e), so a filtered-out event at the same time is never picked.
  const b = col ? `, (SELECT e.${col} FROM app_events e WHERE e.app_id = ? AND e.install_id = g.install AND e.ts = g.first AND e.name = ?${testSql(q.test)}${f.sql} LIMIT 1) AS b` : "";
  const { results } = await db
    .prepare(
      `SELECT g.install, g.first, g.last, g.n${b} FROM (SELECT install_id AS install, MIN(ts) AS first, MAX(ts) AS last, COUNT(*) AS n FROM app_events WHERE ${where}
       GROUP BY install_id ORDER BY first LIMIT ?) g ORDER BY g.first`,
    )
    .bind(...(col ? [q.appId, q.name, ...f.params] : []), q.appId, q.name, q.fromMs, q.toMs, ...f.params, q.limit)
    .all<{ install: string; first: number; last: number; n: number; b?: string | null }>();
  return results.map((r) => [r.install, { first: r.first, last: r.last, n: r.n, ...(col ? { b: r.b || "(none)" } : {}) }]);
}

export interface FunnelStepsArgs {
  appId: string;
  /** Event steps (null: revenue step). */
  steps: (Omit<ExactStepQuery, "appId" | "limit" | "test"> | null)[];
  /** Days the reads touch (entry day to the last event day). */
  fromDay: string;
  toDay: string;
  limit: number;
  test?: ExactTest;
  breakdown?: FunnelBreakdown | null;
}

export type FunnelStepsResult = { exact: true; steps: ([string, StepHit][] | null)[] } | { exact: false; note: string | null };

/** Event step data of a funnel from app_events, or why not (then the caller uses Analytics Engine). */
export async function exactFunnelSteps(db: Db, args: FunnelStepsArgs): Promise<FunnelStepsResult> {
  const names = args.steps.filter((s): s is NonNullable<typeof s> => !!s).map((s) => s.name);
  const plan = await exactPlan(db, args.appId, names, args.fromDay, args.toDay);
  if (!plan.exact) return plan;
  if (!exactBreakdown(args.breakdown)) return { exact: false, note: `The ${args.breakdown} breakdown is only in Analytics Engine: this report uses sampled data.` };
  const steps: ([string, StepHit][] | null)[] = [];
  for (const s of args.steps) steps.push(s ? await exactStepData(db, { ...s, appId: args.appId, limit: args.limit, test: args.test }) : null);
  return { exact: true, steps };
}

export const funnelStepsExact = defineDbFunction("keyEvents.funnel", async (db, args: FunnelStepsArgs) => exactFunnelSteps(db, args));

/**
 * Exposed installs per variant (first exposure, event time), production data from other devices than the test ones;
 * null when experiment_exposure is not exact for the window. One read of the window's exposure events.
 */
export async function exactExposures(
  db: Db,
  args: { appId: string; experimentId: string; variants: string[]; fromMs: number; toMs: number; graceMs: number; excludedInstalls: readonly string[]; cap: number },
  at = now(),
): Promise<{ lists: Record<string, [string, number][]>; over: string[] } | null> {
  const plan = await exactPlan(db, args.appId, [EXPERIMENT_EXPOSURE_EVENT], dayOf(args.fromMs - args.graceMs), dayOf(Math.max(args.fromMs, args.toMs - 1)), at);
  if (!plan.exact) return null;
  const values = args.variants.map((v) => `${args.experimentId}:${v}`);
  const { results } = await db
    .prepare(
      `SELECT variant, install_id AS install, MIN(ts) AS first FROM app_events WHERE app_id = ? AND name = ? AND ts >= ? AND ts < ? AND variant IN (${values.map(() => "?").join(", ")})${testSql({ excludedInstalls: args.excludedInstalls })}
       GROUP BY variant, install_id ORDER BY first`,
    )
    .bind(args.appId, EXPERIMENT_EXPOSURE_EVENT, args.fromMs - args.graceMs, args.toMs, ...values)
    .all<{ variant: string; install: string; first: number }>();
  const lists: Record<string, [string, number][]> = Object.fromEntries(args.variants.map((v) => [v, []]));
  const over = new Set<string>();
  for (const r of results) {
    const v = r.variant.split(":")[1] ?? "";
    const list = lists[v];
    if (!list) continue;
    if (list.length >= args.cap) over.add(v);
    else list.push([r.install, r.first]);
  }
  return { lists, over: [...over] };
}

export interface SummaryRow {
  name: string;
  count: number;
  installs: number;
  last: number | null;
  /** UTC day of reception (like Analytics Engine) → count. */
  daily: Record<string, number>;
}

export interface ExactSummaryResult {
  rows: SummaryRow[];
  /** Why the exact path was not used (Analytics Engine for every event then); null: used, or nothing stored. */
  note: string | null;
}

/**
 * Events page: exact counts, unique installs and per-day counts (UTC days of reception, like Analytics Engine) of the
 * app's key events received in the range, for the names covered since its first day (see the top of this file).
 * Reads: the day rows, the rollup (names × days), the test devices' rows (default view) and one COUNT(DISTINCT
 * install_id) over the covered names' rows, capped at EXACT_SUMMARY_MAX_ROWS (counted over the range plus the 7 days
 * before it the scan goes through: events are received up to 7 days after they happen).
 */
export async function exactSummaryLocal(db: Db, args: { appId: string; fromMs: number; toMs: number; test?: ExactTest }, at = now()): Promise<ExactSummaryResult> {
  const row = await appKeyRow(db, args.appId);
  if (!row?.key_events_since) return { rows: [], note: null };
  const fromDay = dayOf(args.fromMs);
  const toDay = dayOf(Math.max(args.fromMs, args.toMs - 1));
  // Index range of the event time the rows received in the range can have.
  const tsFrom = args.fromMs - MAX_AGE_MS;
  const tsTo = args.toMs + MAX_FUTURE_MS;
  const problem = await daysProblem(db, args.appId, fromDay, toDay, EXACT_SUMMARY_MAX_ROWS, dayOf(tsFrom));
  if (problem) return { rows: [], note: problem };
  const { results: counts } = await db
    .prepare("SELECT day, name, count, test_count, last FROM app_event_counts WHERE app_id = ? AND day >= ? AND day <= ?")
    .bind(args.appId, fromDay, toDay)
    .all<{ day: string; name: string; count: number; test_count: number; last: number }>();
  const cfg = parseKeyEventConfig(row.key_events);
  const today = dayOf(at);
  const coveredCache = new Map<string, boolean>();
  const covered = (n: string) => {
    let v = coveredCache.get(n);
    if (v === undefined) {
      const d = coverageDay(cfg, row.key_events_since, n, today);
      coveredCache.set(n, (v = !!d && d <= fromDay));
    }
    return v;
  };
  const out = new Map<string, SummaryRow>();
  for (const r of counts) {
    if (!covered(r.name)) continue;
    let s = out.get(r.name);
    if (!s) {
      if (out.size >= MAX_NAMES) continue;
      out.set(r.name, (s = { name: r.name, count: 0, installs: 0, last: null, daily: {} }));
    }
    const n = Number(r.count) + (args.test?.includeTest ? Number(r.test_count) : 0);
    s.count += n;
    s.daily[r.day] = (s.daily[r.day] ?? 0) + n;
    if (n > 0) s.last = Math.max(s.last ?? 0, Number(r.last) || 0) || null;
  }
  if (!out.size) return { rows: [], note: null };
  const names = [...out.keys()];
  // Default view: the test devices' production rows are in the rollup's production counts; subtract them.
  const excluded = args.test?.includeTest ? [] : [...new Set(args.test?.excludedInstalls ?? [])];
  for (let i = 0; i < excluded.length; i += 80) {
    const chunk = excluded.slice(i, i + 80);
    const { results } = await db
      .prepare(
        `SELECT name, received_at / ${DAY} AS d, COUNT(*) AS n FROM app_events WHERE app_id = ? AND install_id IN (${chunk.map(() => "?").join(", ")})
         AND ts >= ? AND ts < ? AND received_at >= ? AND received_at < ? AND environment = 'production' GROUP BY name, d`,
      )
      .bind(args.appId, ...chunk, tsFrom, tsTo, args.fromMs, args.toMs)
      .all<{ name: string; d: number; n: number }>();
    for (const r of results) {
      const s = out.get(r.name);
      if (!s) continue;
      const date = dayOf(Number(r.d) * DAY);
      const n = Math.min(Number(r.n) || 0, s.daily[date] ?? 0);
      s.count -= n;
      s.daily[date] = (s.daily[date] ?? 0) - n;
    }
  }
  for (let i = 0; i < names.length; i += 90) {
    const chunk = names.slice(i, i + 90);
    const { results } = await db
      .prepare(
        `SELECT name, COUNT(DISTINCT install_id) AS installs FROM app_events WHERE app_id = ? AND name IN (${chunk.map(() => "?").join(", ")})
         AND ts >= ? AND ts < ? AND received_at >= ? AND received_at < ?${testSql(args.test)} GROUP BY name`,
      )
      .bind(args.appId, ...chunk, tsFrom, tsTo, args.fromMs, args.toMs)
      .all<{ name: string; installs: number }>();
    for (const r of results) out.get(r.name)!.installs = Number(r.installs) || 0;
  }
  return { rows: [...out.values()], note: null };
}

export const exactSummary = defineDbFunction("keyEvents.summary", async (db, args: { appId: string; fromMs: number; toMs: number; test?: ExactTest }) => exactSummaryLocal(db, args));

/**
 * Digest rows (first_open, paywall_view per app and UTC day, event time) for the apps whose key events cover the
 * range; the others are left to Analytics Engine.
 */
export async function exactDigestRows(
  db: Db,
  apps: { id: string; test_installs: string[] }[],
  names: readonly string[],
  fromMs: number,
  toMs: number,
  at = now(),
): Promise<{ rows: Record<string, unknown>[]; exactApps: string[] }> {
  const rows: Record<string, unknown>[] = [];
  const exactApps: string[] = [];
  for (const a of apps) {
    try {
      const plan = await exactPlan(db, a.id, [...names], dayOf(fromMs), dayOf(toMs - 1), at);
      if (!plan.exact) continue;
      const { results } = await db
        .prepare(
          `SELECT name, ts / ${DAY} AS d, COUNT(*) AS n FROM app_events WHERE app_id = ? AND name IN (${names.map(() => "?").join(", ")}) AND ts >= ? AND ts < ?${testSql({ excludedInstalls: a.test_installs })} GROUP BY name, d`,
        )
        .bind(a.id, ...names, fromMs, toMs)
        .all<{ name: string; d: number; n: number }>();
      for (const r of results) rows.push({ app: a.id, day: dayOf(Number(r.d) * DAY), name: r.name, events: r.n });
      exactApps.push(a.id);
    } catch (err) {
      console.error("exact digest rows failed", a.id, errorMessage(err));
    }
  }
  return { rows, exactApps };
}
