// Meta Ads (Facebook) integration: purchases go server-side to Meta's Conversions API as app events, so Meta can
// optimize on real trials, conversions and renewals (renewals included while the app is closed: they arrive as
// DID_RENEW notifications or through Notification History polling and become new ledger transactions).
//
//   RevflareKit → POST /sdk/v1/identifiers → install_identifiers (Facebook SDK anonymous id, IDFA, IDFV, ATT, device)
//   Ledger.upsert (new Apple transaction of an enabled app, ≤ 7 days old) → meta_events (one INSERT, no scan)
//   cron (own database call per tick) → sendMetaEvents: per app, due events in one batch request; skips recorded
//   with their reason in meta_deliveries (last 100 per app)
//
// The transaction's install comes from install_links (original transaction id; filled by appAccountToken = install
// id or by RevflareKit's transaction reports) or the transaction's appAccountToken. Identifiers and links can arrive
// minutes after the purchase: events wait up to 24 h (backing off) before they are skipped. event_id = order_id =
// `<transaction id>_<event type>`, so retries and Meta's deduplication are safe. Money is always USD (gross_usd).

import type { MetaDelivery, MetaIntegration } from "../../shared/types";
import { backgroundAllowed, metered } from "./budget";
import { decryptJson, encryptJson } from "./crypto";
import { appTestInstalls } from "./test-data";
import { defineDbFunction, type Db, type Stmt } from "./db";
import { errorMessage, now, parseJson, sha256Hex } from "./util";

/** Graph API version of every Conversions API request. */
export const GRAPH_VERSION = "v23.0";
export const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Meta only takes events up to 7 days old. */
export const META_WINDOW_MS = 7 * 86_400_000;
/** How long an event waits for its install (link or identifiers) before it is skipped. */
export const META_WAIT_MS = 24 * HOUR;
/** Delay before delivery retry n (429 / 5xx / network): 8 tries in all, then the event fails. */
export const META_RETRY_DELAYS = [MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR, 2 * HOUR, 4 * HOUR, 6 * HOUR];
/** Events per request (Meta accepts up to 1,000). */
const BATCH = 100;
/** Per cron tick: apps served and Conversions API requests made (the tick has its own subrequest budget). */
const MAX_APPS = 5;
const MAX_REQUESTS = 10;
/** Delivery log rows kept per app. */
export const META_LOG_SIZE = 100;
/** Backfill: transactions of the last 7 days, at most this many. */
const BACKFILL_LIMIT = 2_000;

export const META_EVENT_TYPES = ["trial_started", "initial_purchase", "trial_converted", "renewal", "non_subscription_purchase"] as const;
export type MetaEventType = (typeof META_EVENT_TYPES)[number];

export const META_DEFAULT_NAMES: Record<MetaEventType, string> = {
  trial_started: "StartTrial",
  initial_purchase: "Subscribe",
  trial_converted: "Subscribe",
  renewal: "Subscribe",
  non_subscription_purchase: "Purchase",
};

/** Ledger transaction kind → Meta event type. Refunds, cancellations and expirations are never sent. */
export const KIND_TO_EVENT: Record<string, MetaEventType> = {
  trial: "trial_started",
  new: "initial_purchase",
  conversion: "trial_converted",
  renewal: "renewal",
  one_time: "non_subscription_purchase",
};

export const ATT_STATUSES = ["authorized", "denied", "restricted", "notDetermined", "unavailable"] as const;
export type AttStatus = (typeof ATT_STATUSES)[number];

export interface MetaConfig {
  sendSandbox: boolean;
  sendWithoutAtt: boolean;
  events: Record<MetaEventType, { enabled: boolean; name: string }>;
}

/** Meta event names: letters, digits, _, - and spaces, at most 40 characters. */
export function validEventName(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9_\- ]{1,40}$/.test(s) && s.trim() === s;
}

/** The stored config with defaults for anything missing. */
export function parseMetaConfig(json: string | null | undefined): MetaConfig {
  const raw = parseJson<Partial<{ sendSandbox: unknown; sendWithoutAtt: unknown; events: Record<string, { enabled?: unknown; name?: unknown }> }>>(json, {});
  const events = {} as MetaConfig["events"];
  for (const t of META_EVENT_TYPES) {
    const e = raw.events?.[t];
    events[t] = { enabled: e?.enabled !== false, name: validEventName(e?.name) ? e.name : META_DEFAULT_NAMES[t] };
  }
  return { sendSandbox: raw.sendSandbox === true, sendWithoutAtt: raw.sendWithoutAtt === true, events };
}

// --- Install identifiers (POST /sdk/v1/identifiers) -----------------------------------------------------------------

export interface InstallIdentifiers {
  fbAnonId: string | null;
  idfa: string | null;
  idfv: string | null;
  attStatus: AttStatus;
  bundleId: string | null;
  appVersion: string | null;
  appBuild: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  locale: string | null;
  timeZone: string | null;
  extinfo: string[] | null;
  ip: string | null;
  userAgent: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates and trims the SDK's body. Zeroed IDFA / IDFV count as missing. */
export function parseIdentifiers(body: Record<string, unknown>): { installId: string; ids: Omit<InstallIdentifiers, "ip" | "userAgent"> } | { error: string } {
  if (typeof body.installId !== "string" || !UUID.test(body.installId.trim())) return { error: "installId must be a UUID" };
  // RevflareKit Android: the advertising id is `gaid` (stored with IDFAs), ATT does not exist: limitAdTracking decides.
  const android = body.platform === "android";
  if (android) {
    if (body.idfa === undefined && body.gaid !== undefined) body = { ...body, idfa: body.gaid };
    if (typeof body.attStatus !== "string") body = { ...body, attStatus: body.limitAdTracking === true ? "denied" : "authorized" };
  }
  if (typeof body.attStatus !== "string" || !(ATT_STATUSES as readonly string[]).includes(body.attStatus)) return { error: `attStatus must be one of ${ATT_STATUSES.join(", ")}` };
  const text = (k: string, max: number): string | null | { error: string } => {
    const v = body[k];
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") return { error: `${k} must be a string` };
    const s = v.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (s.length > max) return { error: `${k} is too long (max ${max})` };
    return s || null;
  };
  const uuid = (k: string): string | null | { error: string } => {
    const v = text(k, 36);
    if (v === null || typeof v === "object") return v;
    if (!UUID.test(v)) return { error: `${k} must be a UUID` };
    return /^[0-]+$/.test(v) ? null : v.toUpperCase();
  };
  const fields = {
    fbAnonId: text("fbAnonId", 128),
    idfa: uuid("idfa"),
    idfv: android ? null : uuid("idfv"),
    bundleId: text("bundleId", 200),
    appVersion: text("appVersion", 32),
    appBuild: text("appBuild", 32),
    osVersion: text("osVersion", 32),
    deviceModel: text("deviceModel", 64),
    locale: text("locale", 35),
    timeZone: text("timeZone", 64),
  };
  for (const v of Object.values(fields)) if (v && typeof v === "object") return v;
  if (typeof fields.fbAnonId === "string" && !/^[\x21-\x7e]+$/.test(fields.fbAnonId)) return { error: "fbAnonId has invalid characters" };
  let extinfo: string[] | null = null;
  if (body.extinfo !== undefined && body.extinfo !== null) {
    if (!Array.isArray(body.extinfo) || body.extinfo.length !== 16) return { error: "extinfo must be an array of 16 strings" };
    extinfo = [];
    for (const x of body.extinfo) {
      if (x !== null && typeof x !== "string" && typeof x !== "number") return { error: "extinfo must be an array of 16 strings" };
      extinfo.push(String(x ?? "").trim().slice(0, 128));
    }
  }
  return { installId: (body.installId as string).trim().toLowerCase(), ids: { ...(fields as Record<keyof typeof fields, string | null>), attStatus: body.attStatus as AttStatus, extinfo } };
}

/** POST /sdk/v1/identifiers: upserts the install's identifiers (latest wins). */
export const recordInstallIdentifiers = defineDbFunction(
  "recordInstallIdentifiers",
  async (db, args: { sdkKey: string; installId: string; ids: Omit<InstallIdentifiers, "ip" | "userAgent">; ip: string | null; userAgent: string | null }): Promise<{ status: 200 | 400 | 404; error?: string }> => {
    if (!args.sdkKey) return { status: 400, error: "sdkKey is required" };
    const app = await db.prepare("SELECT id FROM apps WHERE sdk_key = ?").bind(args.sdkKey).first<{ id: string }>();
    if (!app) return { status: 404, error: "Unknown SDK key" };
    const i = args.ids;
    await db
      .prepare(
        `INSERT INTO install_identifiers (app_id, install_id, fb_anon_id, idfa, idfv, att_status, bundle_id, app_version, app_build, os_version, device_model, locale, time_zone, extinfo, ip, user_agent, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(app_id, install_id) DO UPDATE SET fb_anon_id = excluded.fb_anon_id, idfa = excluded.idfa, idfv = excluded.idfv, att_status = excluded.att_status,
           bundle_id = excluded.bundle_id, app_version = excluded.app_version, app_build = excluded.app_build, os_version = excluded.os_version, device_model = excluded.device_model,
           locale = excluded.locale, time_zone = excluded.time_zone, extinfo = excluded.extinfo, ip = excluded.ip, user_agent = excluded.user_agent, updated_at = excluded.updated_at`,
      )
      .bind(
        app.id,
        args.installId,
        i.fbAnonId,
        i.idfa,
        i.idfv,
        i.attStatus,
        i.bundleId,
        i.appVersion,
        i.appBuild,
        i.osVersion,
        i.deviceModel,
        i.locale,
        i.timeZone,
        i.extinfo ? JSON.stringify(i.extinfo) : null,
        args.ip?.slice(0, 64) ?? null,
        args.userAgent?.slice(0, 300) ?? null,
        now(),
      )
      .run();
    return { status: 200 };
  },
);

// --- Events ----------------------------------------------------------------------------------------------------------

/** What an event needs from the transaction. */
export interface MetaTx {
  transactionId: string;
  originalTransactionId: string;
  customerId: string | null;
  kind: string;
  productId: string;
  purchasedAt: number;
  grossUsd: number;
  refundedAt: number | null;
  environment: string;
}

export interface MetaEvent {
  event_name: string;
  event_time: number;
  action_source: "app";
  event_id: string;
  user_data: { anon_id?: string; madid?: string; external_id: string; client_ip_address?: string; client_user_agent?: string };
  app_data: { advertiser_tracking_enabled: 0 | 1; application_tracking_enabled: 1; vendor_id?: string; extinfo: string[] };
  custom_data: { currency: "USD"; value: number; order_id: string; content_type: "product"; content_ids: string[]; contents: { id: string; quantity: number }[] };
}

export const metaEventId = (transactionId: string, type: MetaEventType) => `${transactionId}_${type}`;

/** Meta's 16-field extinfo: the SDK's own array, else built from the device info (blanks / zeros for unknowns); version "a2" on Android. */
export function buildExtinfo(ids: Pick<InstallIdentifiers, "extinfo" | "bundleId" | "appVersion" | "appBuild" | "osVersion" | "deviceModel" | "locale" | "timeZone">, platform = "ios"): string[] {
  if (ids.extinfo?.length === 16) return ids.extinfo;
  return [platform === "android" ? "a2" : "i2", ids.bundleId ?? "", ids.appVersion ?? "", ids.appBuild ?? "", ids.osVersion ?? "", ids.deviceModel ?? "", ids.locale ?? "", "", "", "0", "0", "0", "0", "0", "0", ids.timeZone ?? ""];
}

export async function buildMetaEvent(tx: MetaTx, ids: InstallIdentifiers, type: MetaEventType, name: string, platform = "ios"): Promise<MetaEvent> {
  const id = metaEventId(tx.transactionId, type);
  const user_data: MetaEvent["user_data"] = { external_id: await sha256Hex(tx.customerId ?? tx.originalTransactionId) };
  if (ids.fbAnonId) user_data.anon_id = ids.fbAnonId;
  if (ids.idfa) user_data.madid = ids.idfa;
  if (ids.ip) user_data.client_ip_address = ids.ip;
  if (ids.userAgent) user_data.client_user_agent = ids.userAgent;
  const app_data: MetaEvent["app_data"] = { advertiser_tracking_enabled: ids.attStatus === "authorized" ? 1 : 0, application_tracking_enabled: 1, extinfo: buildExtinfo(ids, platform) };
  // Android has no vendor id (IDFV).
  if (ids.idfv && platform !== "android") app_data.vendor_id = ids.idfv;
  const value = type === "trial_started" ? 0 : Math.round(tx.grossUsd * 100) / 100;
  return {
    event_name: name,
    event_time: Math.floor(tx.purchasedAt / 1000),
    action_source: "app",
    event_id: id,
    user_data,
    app_data,
    custom_data: { currency: "USD", value, order_id: id, content_type: "product", content_ids: [tx.productId], contents: [{ id: tx.productId, quantity: 1 }] },
  };
}

export type MetaPlan =
  | { action: "send"; type: MetaEventType; name: string; event: MetaEvent }
  | { action: "skip"; type: MetaEventType | null; name: string | null; reason: string }
  | { action: "wait"; reason: string; until?: number };

/**
 * What to do with a queued transaction now. `linked`: an install is known for it; `ids`: that install's identifiers
 * (null when it sent none); `queuedAt`: when it was queued (the 24 h wait counts from there).
 */
export async function planMetaEvent(p: {
  tx: MetaTx;
  linked: boolean;
  ids: InstallIdentifiers | null;
  config: MetaConfig;
  enabled: boolean;
  queuedAt: number;
  now: number;
  /** The linked install is test data (its build: sandbox / xcode, "test device" or "test attribution"): sent only with Sandbox sending on. */
  testInstall?: string | null;
  /** The app's platform (ios | android): extinfo version and vendor id. */
  platform?: string;
}): Promise<MetaPlan> {
  const type = KIND_TO_EVENT[p.tx.kind] ?? null;
  const name = type ? p.config.events[type].name : null;
  const skip = (reason: string): MetaPlan => ({ action: "skip", type, name, reason });
  if (!p.enabled) return skip("Integration disabled");
  if (!type) return skip(`Transaction kind ${p.tx.kind} is not sent`);
  if (p.tx.refundedAt) return skip("Refunded");
  if (!p.config.events[type].enabled) return skip(`${type} events are turned off`);
  if (p.tx.environment !== "Production" && !p.config.sendSandbox) return skip(`${p.tx.environment} transaction (Sandbox sending is off)`);
  if (p.testInstall && !p.config.sendSandbox) return skip(`Test install (${p.testInstall}; Sandbox sending is off)`);
  if (p.tx.purchasedAt < p.now - META_WINDOW_MS) return skip("Older than Meta's 7-day window");
  // Renewals Apple announces ahead of their period start: send once that time has come.
  if (p.tx.purchasedAt > p.now) return { action: "wait", reason: "Purchase time is in the future", until: p.tx.purchasedAt };
  const waiting = p.queuedAt > p.now - META_WAIT_MS;
  if (!p.linked) {
    return waiting
      ? { action: "wait", reason: "Waiting for the install (appAccountToken or RevflareKit's transaction report)" }
      : skip("No install linked to this purchase within 24 h (buy with appAccountToken = Revflare.installId, or keep RevflareKit's transaction reports on)");
  }
  if (!p.ids) return waiting ? { action: "wait", reason: "Waiting for the install's identifiers" } : skip("The install sent no identifiers within 24 h (RevflareKit: POST /sdk/v1/identifiers)");
  if (p.ids.attStatus !== "authorized" && !p.config.sendWithoutAtt) return skip(`ATT not authorized (${p.ids.attStatus})`);
  if (!p.ids.fbAnonId && !p.ids.idfa) return skip("No anon_id (Facebook SDK) and no IDFA for this install");
  return { action: "send", type: type, name: name!, event: await buildMetaEvent(p.tx, p.ids, type, name!, p.platform) };
}

// --- Queue -----------------------------------------------------------------------------------------------------------

/** Called by the ledger for each new Apple transaction: queues it when the app's Meta integration is on. */
export async function queueMetaEvent(db: Db, app: { id: string; meta_enabled?: number | null }, tx: { transactionId: string; purchasedAt: number }) {
  const t = now();
  // History imports bring old transactions: Meta would refuse them anyway.
  if (!app.meta_enabled || tx.purchasedAt < t - META_WINDOW_MS) return;
  await db
    .prepare("INSERT INTO meta_events (app_id, transaction_id, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .bind(app.id, tx.transactionId, t, t, t)
    .run();
}

/**
 * Queues the app's transactions of the last 7 days (indexed range on (app_id, purchased_at), capped); failed and
 * skipped ones go back to pending, sent ones are never sent again. Metered as background work.
 */
export const backfillMetaEvents = defineDbFunction("backfillMetaEvents", async (db, args: { appId: string }, env): Promise<{ queued: number } | { budget: true }> => {
  if (!(await backgroundAllowed(db, env))) return { budget: true };
  return metered(db, async () => {
    const t = now();
    const row = await db.prepare("SELECT config FROM meta_integrations WHERE app_id = ?").bind(args.appId).first<{ config: string }>();
    const sandbox = parseMetaConfig(row?.config).sendSandbox ? 1 : 0;
    const r = await db
      .prepare(
        `INSERT INTO meta_events (app_id, transaction_id, next_attempt_at, created_at, updated_at)
         SELECT app_id, transaction_id, ?, ?, ? FROM transactions
         WHERE app_id = ? AND purchased_at >= ? AND purchased_at <= ? AND source IN ('apple', 'google_play') AND (environment = 'Production' OR ? = 1)
         ORDER BY purchased_at DESC LIMIT ?
         ON CONFLICT(app_id, transaction_id) DO UPDATE SET status = 'pending', attempts = 0, waits = 0, solo = 0, error = NULL,
           next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at
         WHERE meta_events.status IN ('failed', 'skipped')`,
      )
      .bind(t, t, t, args.appId, t - META_WINDOW_MS, t, sandbox, BACKFILL_LIMIT)
      .run();
    await db.prepare("UPDATE meta_integrations SET backfilled_at = ? WHERE app_id = ?").bind(t, args.appId).run();
    return { queued: r.meta.changes };
  });
});

// --- Settings --------------------------------------------------------------------------------------------------------

interface IntegrationRow {
  app_id: string;
  enabled: number;
  dataset_id: string | null;
  token: string | null;
  test_event_code: string | null;
  config: string;
  sent_count: number;
  skipped_count: number;
  failed_count: number;
  last_sent_at: number | null;
  last_error: string | null;
  backfilled_at: number | null;
}

export async function metaIntegrationView(db: Db, appId: string): Promise<MetaIntegration> {
  const [row, pending] = await Promise.all([
    db.prepare("SELECT * FROM meta_integrations WHERE app_id = ?").bind(appId).first<IntegrationRow>(),
    db.prepare("SELECT COUNT(*) AS n FROM meta_events WHERE app_id = ? AND status = 'pending'").bind(appId).first<{ n: number }>(),
  ]);
  const config = parseMetaConfig(row?.config);
  const events = {} as MetaIntegration["events"];
  for (const t of META_EVENT_TYPES) events[t] = { ...config.events[t], defaultName: META_DEFAULT_NAMES[t] };
  return {
    enabled: !!row?.enabled,
    datasetId: row?.dataset_id ?? null,
    accessTokenSet: !!row?.token,
    testEventCode: row?.test_event_code ?? null,
    sendSandbox: config.sendSandbox,
    sendWithoutAtt: config.sendWithoutAtt,
    events,
    stats: { pending: pending?.n ?? 0, sent: row?.sent_count ?? 0, skipped: row?.skipped_count ?? 0, failed: row?.failed_count ?? 0 },
    lastSentAt: row?.last_sent_at ?? null,
    lastError: row?.last_error ?? null,
    backfilledAt: row?.backfilled_at ?? null,
  };
}

export interface MetaUpdate {
  enabled?: boolean;
  datasetId?: string | null;
  accessToken?: string | null;
  testEventCode?: string | null;
  sendSandbox?: boolean;
  sendWithoutAtt?: boolean;
  /** name null = back to the default. */
  events?: Partial<Record<MetaEventType, { enabled?: boolean; name?: string | null }>>;
}

/** Validates a PUT body (undefined = unchanged; null or "" clears dataset id, token and test code). */
export function parseMetaUpdate(body: Record<string, unknown>): MetaUpdate | { error: string } {
  const out: MetaUpdate = {};
  const clearable = (v: unknown) => (v === null || v === "" ? null : typeof v === "string" ? v.trim() || null : undefined);
  for (const k of ["enabled", "sendSandbox", "sendWithoutAtt"] as const) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== "boolean") return { error: `${k} must be true or false` };
    out[k] = body[k];
  }
  if (body.datasetId !== undefined) {
    const v = clearable(body.datasetId);
    if (v === undefined || (v !== null && !/^\d{5,30}$/.test(v))) return { error: "datasetId must be the numeric Meta dataset (pixel) id" };
    out.datasetId = v;
  }
  if (body.accessToken !== undefined) {
    const v = clearable(body.accessToken);
    if (v === undefined || (v !== null && !/^[A-Za-z0-9_\-]{20,1000}$/.test(v))) return { error: "accessToken looks wrong (Events Manager → dataset → Settings → Conversions API → Generate access token)" };
    out.accessToken = v;
  }
  if (body.testEventCode !== undefined) {
    const v = clearable(body.testEventCode);
    if (v === undefined || (v !== null && !/^[A-Za-z0-9_\-]{1,64}$/.test(v))) return { error: "testEventCode must be Meta's test code (letters and digits, e.g. TEST12345)" };
    out.testEventCode = v;
  }
  if (body.events !== undefined) {
    if (!body.events || typeof body.events !== "object" || Array.isArray(body.events)) return { error: "events must be an object keyed by event type" };
    out.events = {};
    for (const [k, v] of Object.entries(body.events as Record<string, unknown>)) {
      if (!(META_EVENT_TYPES as readonly string[]).includes(k)) return { error: `Unknown event type ${k} (${META_EVENT_TYPES.join(", ")})` };
      if (!v || typeof v !== "object") return { error: `events.${k} must be { enabled?, name? }` };
      const e = v as { enabled?: unknown; name?: unknown };
      const ev: { enabled?: boolean; name?: string | null } = {};
      if (e.enabled !== undefined) {
        if (typeof e.enabled !== "boolean") return { error: `events.${k}.enabled must be true or false` };
        ev.enabled = e.enabled;
      }
      if (e.name !== undefined) {
        const name = e.name === null ? null : typeof e.name === "string" ? e.name.trim() || null : undefined;
        if (name === undefined || (name !== null && !validEventName(name))) return { error: `events.${k}.name: letters, digits, _, - and spaces, at most 40 characters` };
        ev.name = name;
      }
      out.events[k as MetaEventType] = ev;
    }
  }
  return out;
}

/** Applies a validated update. Returns whether this turned the integration on for the first time (then backfill). */
export async function saveMetaIntegration(env: Env, db: Db, appId: string, u: MetaUpdate): Promise<{ error?: string; firstEnabled: boolean }> {
  const row = await db.prepare("SELECT * FROM meta_integrations WHERE app_id = ?").bind(appId).first<IntegrationRow>();
  const config = parseMetaConfig(row?.config);
  if (u.sendSandbox !== undefined) config.sendSandbox = u.sendSandbox;
  if (u.sendWithoutAtt !== undefined) config.sendWithoutAtt = u.sendWithoutAtt;
  for (const [k, e] of Object.entries(u.events ?? {}) as [MetaEventType, { enabled?: boolean; name?: string | null }][]) {
    if (e.enabled !== undefined) config.events[k].enabled = e.enabled;
    if (e.name !== undefined) config.events[k].name = e.name ?? META_DEFAULT_NAMES[k];
  }
  const datasetId = u.datasetId !== undefined ? u.datasetId : (row?.dataset_id ?? null);
  const token = u.accessToken !== undefined ? (u.accessToken ? await encryptJson(env, db, { token: u.accessToken }) : null) : (row?.token ?? null);
  const testCode = u.testEventCode !== undefined ? u.testEventCode : (row?.test_event_code ?? null);
  const enabled = u.enabled !== undefined ? u.enabled : !!row?.enabled;
  if (enabled && (!datasetId || !token)) return { error: "Set the dataset id and the Conversions API access token before turning the integration on", firstEnabled: false };
  const t = now();
  await db
    .prepare(
      `INSERT INTO meta_integrations (app_id, enabled, dataset_id, token, test_event_code, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET enabled = excluded.enabled, dataset_id = excluded.dataset_id, token = excluded.token,
         test_event_code = excluded.test_event_code, config = excluded.config, updated_at = excluded.updated_at`,
    )
    .bind(appId, enabled ? 1 : 0, datasetId, token, testCode, JSON.stringify(config), t, t)
    .run();
  return { firstEnabled: enabled && !row?.enabled && !row?.backfilled_at };
}

export async function metaDeliveryLog(db: Db, appId: string, limit = META_LOG_SIZE): Promise<MetaDelivery[]> {
  const { results } = await db
    .prepare("SELECT * FROM meta_deliveries WHERE app_id = ? ORDER BY id DESC LIMIT ?")
    .bind(appId, Math.min(Math.max(1, limit), META_LOG_SIZE))
    .all<{ id: number; created_at: number; transaction_id: string; event_type: MetaEventType | null; event_name: string | null; event_id: string | null; status: MetaDelivery["status"]; http_status: number | null; response: string | null; reason: string | null }>();
  return results.map((r) => ({
    id: r.id,
    at: r.created_at,
    transactionId: r.transaction_id,
    eventType: r.event_type,
    eventName: r.event_name,
    eventId: r.event_id,
    status: r.status,
    httpStatus: r.http_status,
    response: r.response,
    reason: r.reason,
  }));
}

// --- Delivery --------------------------------------------------------------------------------------------------------

export type PostResult = { ok: true; status: number; response: string } | { ok: false; status: number; response: string; retry: boolean; auth: boolean; message: string };

/** One Conversions API request (token in the body, never in the URL). */
export async function postMetaEvents(datasetId: string, token: string, data: unknown[], opts: { testEventCode?: string | null; ip?: string | null } = {}): Promise<PostResult> {
  const body: Record<string, unknown> = { data, partner_agent: "revflare", access_token: token };
  if (opts.testEventCode) body.test_event_code = opts.testEventCode;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.ip) headers["x-forwarded-for"] = opts.ip;
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${GRAPH_URL}/${encodeURIComponent(datasetId)}/events`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    text = await res.text();
  } catch (err) {
    return { ok: false, status: 0, response: errorMessage(err).slice(0, 500), retry: true, auth: false, message: `Network error: ${errorMessage(err)}` };
  }
  const response = text.slice(0, 500);
  if (res.ok) return { ok: true, status: res.status, response };
  const j = parseJson<{ error?: { message?: string; error_user_msg?: string; code?: number; type?: string } }>(text, {});
  const e = j.error ?? {};
  const message = `${res.status} ${e.error_user_msg || e.message || text.slice(0, 200)}`.trim().slice(0, 300);
  // Invalid / expired token or missing permission: every event of the dataset fails the same way.
  const auth = res.status === 401 || res.status === 403 || e.code === 190 || e.code === 10 || (e.code !== undefined && e.code >= 200 && e.code < 300);
  return { ok: false, status: res.status, response, retry: res.status === 429 || res.status >= 500, auth, message };
}

type QueueRow = {
  transaction_id: string;
  attempts: number;
  waits: number;
  solo: number;
  created_at: number;
  original_transaction_id: string;
  customer_id: string | null;
  kind: string;
  product_id: string;
  purchased_at: number;
  gross_usd: number;
  refunded_at: number | null;
  environment: string;
  install_id: string | null;
  /** The linked install's build (attributions.environment; NULL: production or unknown). */
  install_env: string | null;
  /** attributions.test_attribution: Apple's AdServices test payload. */
  install_test: number | null;
  has_ids: string | null;
  fb_anon_id: string | null;
  idfa: string | null;
  idfv: string | null;
  att_status: AttStatus | null;
  bundle_id: string | null;
  app_version: string | null;
  app_build: string | null;
  os_version: string | null;
  device_model: string | null;
  locale: string | null;
  time_zone: string | null;
  extinfo: string | null;
  ip: string | null;
  user_agent: string | null;
};

const logStmt = (db: Db, appId: string, transactionId: string, d: { type: MetaEventType | null; name: string | null; eventId: string | null; status: string; http?: number | null; response?: string | null; reason?: string | null }, t: number) =>
  db
    .prepare("INSERT INTO meta_deliveries (app_id, transaction_id, event_type, event_name, event_id, status, http_status, response, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(appId, transactionId, d.type, d.name, d.eventId, d.status, d.http ?? null, d.response ?? null, d.reason ?? null, t);

const finishStmt = (db: Db, appId: string, transactionId: string, status: "sent" | "skipped" | "failed", error: string | null, t: number) =>
  db.prepare("UPDATE meta_events SET status = ?, error = ?, attempts = attempts + ?, updated_at = ? WHERE app_id = ? AND transaction_id = ?").bind(status, error, status === "skipped" ? 0 : 1, t, appId, transactionId);

/** Sends one app's due events (at most `maxRequests` requests). */
async function processApp(db: Db, env: Env, appId: string, maxRequests: number, t: number) {
  const out = { requests: 0, sent: 0, skipped: 0, failed: 0, retrying: 0, waiting: 0 };
  const integration = await db.prepare("SELECT * FROM meta_integrations WHERE app_id = ?").bind(appId).first<IntegrationRow>();
  const config = parseMetaConfig(integration?.config);
  const enabled = !!(integration?.enabled && integration.dataset_id && integration.token);
  const { results: rows } = await db
    .prepare(
      `SELECT e.transaction_id, e.attempts, e.waits, e.solo, e.created_at, t.original_transaction_id, t.customer_id, t.kind, t.product_id, t.purchased_at, t.gross_usd,
         t.refunded_at, t.environment, COALESCE(l.install_id, lower(t.app_account_token)) AS install_id, i.install_id AS has_ids, i.fb_anon_id, i.idfa, i.idfv, i.att_status,
         i.bundle_id, i.app_version, i.app_build, i.os_version, i.device_model, i.locale, i.time_zone, i.extinfo, i.ip, i.user_agent, at.environment AS install_env, at.test_attribution AS install_test
       FROM meta_events e
       JOIN transactions t ON t.app_id = e.app_id AND t.transaction_id = e.transaction_id
       LEFT JOIN install_links l ON l.app_id = t.app_id AND l.original_transaction_id = t.original_transaction_id
       LEFT JOIN install_identifiers i ON i.app_id = t.app_id AND i.install_id = COALESCE(l.install_id, lower(t.app_account_token))
       LEFT JOIN attributions at ON at.app_id = t.app_id AND at.install_id = COALESCE(l.install_id, lower(t.app_account_token))
       WHERE e.app_id = ? AND e.status = 'pending' AND e.next_attempt_at <= ? ORDER BY e.next_attempt_at LIMIT ?`,
    )
    .bind(appId, t, BATCH)
    .all<QueueRow>();
  // Due rows whose transaction is gone (deleted workspace data) would keep the app selected: drop them.
  if (!rows.length) {
    await db
      .prepare(
        `DELETE FROM meta_events WHERE app_id = ? AND status = 'pending' AND next_attempt_at <= ?
           AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.app_id = meta_events.app_id AND t.transaction_id = meta_events.transaction_id)`,
      )
      .bind(appId, t)
      .run();
    return out;
  }
  const stmts: Stmt[] = [];
  const toSend: { row: QueueRow; plan: Extract<MetaPlan, { action: "send" }>; ip: string | null }[] = [];
  const testDevices = new Set(await appTestInstalls(db, appId));
  const platform = (await db.prepare("SELECT platform FROM apps WHERE id = ?").bind(appId).first<{ platform: string }>())?.platform ?? "ios";
  for (const r of rows) {
    const ids: InstallIdentifiers | null = r.has_ids
      ? {
          fbAnonId: r.fb_anon_id,
          idfa: r.idfa,
          idfv: r.idfv,
          attStatus: r.att_status ?? "notDetermined",
          bundleId: r.bundle_id,
          appVersion: r.app_version,
          appBuild: r.app_build,
          osVersion: r.os_version,
          deviceModel: r.device_model,
          locale: r.locale,
          timeZone: r.time_zone,
          extinfo: r.extinfo ? parseJson<string[] | null>(r.extinfo, null) : null,
          ip: r.ip,
          userAgent: r.user_agent,
        }
      : null;
    const tx: MetaTx = {
      transactionId: r.transaction_id,
      originalTransactionId: r.original_transaction_id,
      customerId: r.customer_id,
      kind: r.kind,
      productId: r.product_id,
      purchasedAt: r.purchased_at,
      grossUsd: r.gross_usd,
      refundedAt: r.refunded_at,
      environment: r.environment,
    };
    const testInstall =
      r.install_env && r.install_env !== "production" ? r.install_env : r.install_id && testDevices.has(r.install_id) ? "test device" : r.install_test ? "test attribution" : null;
    const plan = await planMetaEvent({ tx, linked: !!r.install_id, ids, config, enabled, queuedAt: r.created_at, now: t, testInstall, platform });
    if (plan.action === "wait") {
      // Back off while waiting: 2, 4, 8 ... minutes, then hourly.
      const next = plan.until ?? t + Math.min(HOUR, 2 * MINUTE * 2 ** Math.min(r.waits, 10));
      stmts.push(
        db
          .prepare("UPDATE meta_events SET waits = waits + ?, next_attempt_at = ?, error = ?, updated_at = ? WHERE app_id = ? AND transaction_id = ?")
          .bind(plan.until ? 0 : 1, next, plan.reason, t, appId, r.transaction_id),
      );
      out.waiting++;
    } else if (plan.action === "skip") {
      stmts.push(finishStmt(db, appId, r.transaction_id, "skipped", plan.reason, t));
      stmts.push(logStmt(db, appId, r.transaction_id, { type: plan.type, name: plan.name, eventId: plan.type ? metaEventId(r.transaction_id, plan.type) : null, status: "skipped", reason: plan.reason }, t));
      out.skipped++;
    } else toSend.push({ row: r, plan, ip: ids?.ip ?? null });
  }

  let lastError: string | null | undefined;
  if (toSend.length && enabled) {
    const { token } = await decryptJson<{ token: string }>(env, db, integration!.token!);
    const groups: (typeof toSend)[] = [];
    const batch = toSend.filter((s) => !s.row.solo);
    if (batch.length) groups.push(batch);
    for (const s of toSend.filter((s) => s.row.solo)) groups.push([s]);
    for (const group of groups) {
      if (out.requests >= maxRequests) break;
      out.requests++;
      const ips = new Set(group.map((s) => s.ip).filter(Boolean));
      const r = await postMetaEvents(integration!.dataset_id!, token, group.map((s) => s.plan.event), { testEventCode: integration!.test_event_code, ip: ips.size === 1 ? [...ips][0] : null });
      for (const s of group) {
        const log = { type: s.plan.type, name: s.plan.name, eventId: s.plan.event.event_id, http: r.status, response: r.response };
        const id = s.row.transaction_id;
        if (r.ok) {
          stmts.push(finishStmt(db, appId, id, "sent", null, t), logStmt(db, appId, id, { ...log, status: "sent" }, t));
          out.sent++;
        } else if (r.retry && s.row.attempts < META_RETRY_DELAYS.length) {
          stmts.push(
            db
              .prepare("UPDATE meta_events SET attempts = attempts + 1, next_attempt_at = ?, error = ?, updated_at = ? WHERE app_id = ? AND transaction_id = ?")
              .bind(t + META_RETRY_DELAYS[s.row.attempts], r.message, t, appId, id),
          );
          out.retrying++;
        } else if (!r.retry && !r.auth && group.length > 1) {
          // Meta rejects the whole batch for one bad event: send these one by one to find it.
          stmts.push(db.prepare("UPDATE meta_events SET solo = 1, error = ?, updated_at = ? WHERE app_id = ? AND transaction_id = ?").bind(r.message, t, appId, id));
          out.retrying++;
        } else {
          stmts.push(finishStmt(db, appId, id, "failed", r.message, t), logStmt(db, appId, id, { ...log, status: "failed", reason: r.message }, t));
          out.failed++;
        }
      }
      lastError = r.ok ? (lastError ?? null) : r.message;
    }
  }
  if (stmts.length) await db.batch(stmts);
  if (out.sent || out.skipped || out.failed) {
    // Keep the last META_LOG_SIZE rows of this app's log (index on (app_id, id)).
    await db
      .prepare("DELETE FROM meta_deliveries WHERE app_id = ? AND id <= (SELECT id FROM meta_deliveries WHERE app_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)")
      .bind(appId, appId, META_LOG_SIZE)
      .run();
  }
  if (integration && (out.sent || out.skipped || out.failed || lastError !== undefined)) {
    await db
      .prepare(
        `UPDATE meta_integrations SET sent_count = sent_count + ?, skipped_count = skipped_count + ?, failed_count = failed_count + ?,
           last_sent_at = CASE WHEN ? > 0 THEN ? ELSE last_sent_at END, last_error = CASE WHEN ? THEN ? ELSE last_error END WHERE app_id = ?`,
      )
      .bind(out.sent, out.skipped, out.failed, out.sent, t, lastError !== undefined ? 1 : 0, lastError ?? null, appId)
      .run();
  }
  return out;
}

/** Cron (its own database call each tick): sends due events of a few apps, at most MAX_REQUESTS requests. */
export const sendMetaEvents = defineDbFunction("sendMetaEvents", async (db, args: { maxApps?: number; maxRequests?: number; at?: number }, env) => {
  const t = args.at ?? now();
  // Finished rows only guard against queueing a transaction twice; nothing older than 7 days is queued again.
  await db.prepare("DELETE FROM meta_events WHERE created_at < ? AND status != 'pending'").bind(t - META_WINDOW_MS - 86_400_000).run();
  const { results: apps } = await db
    .prepare("SELECT app_id FROM meta_events WHERE status = 'pending' AND next_attempt_at <= ? GROUP BY app_id ORDER BY MIN(next_attempt_at) LIMIT ?")
    .bind(t, args.maxApps ?? MAX_APPS)
    .all<{ app_id: string }>();
  const log: Record<string, unknown> = {};
  let budget = args.maxRequests ?? MAX_REQUESTS;
  for (const a of apps) {
    try {
      const r = await processApp(db, env, a.app_id, budget, t);
      budget -= r.requests;
      log[a.app_id] = r;
    } catch (err) {
      log[a.app_id] = { error: errorMessage(err) };
    }
  }
  return log;
});

/** Sends one test event with the app's test event code (it shows under Test events in Events Manager). */
export const sendMetaTestEvent = defineDbFunction("sendMetaTestEvent", async (db, args: { appId: string; ip?: string | null; userAgent?: string | null }, env): Promise<{ error: string; status?: number; response?: unknown } | { ok: true; status: number; response: unknown }> => {
  const row = await db.prepare("SELECT * FROM meta_integrations WHERE app_id = ?").bind(args.appId).first<IntegrationRow>();
  if (!row?.dataset_id || !row.token) return { error: "Set the dataset id and the Conversions API access token first" };
  if (!row.test_event_code) return { error: "Set a test event code first (Events Manager → dataset → Test events)" };
  const app = await db.prepare("SELECT bundle_id, platform FROM apps WHERE id = ?").bind(args.appId).first<{ bundle_id: string | null; platform: string }>();
  const android = app?.platform === "android";
  const { token } = await decryptJson<{ token: string }>(env, db, row.token);
  const config = parseMetaConfig(row.config);
  const t = now();
  const event = await buildMetaEvent(
    { transactionId: `revflare_test_${t}`, originalTransactionId: `revflare_test_${t}`, customerId: "revflare-test", kind: "new", productId: "revflare.test", purchasedAt: t, grossUsd: 0.99, refundedAt: null, environment: "Production" },
    {
      fbAnonId: `XZrevflare-test-${t}`,
      idfa: null,
      idfv: null,
      attStatus: "denied",
      bundleId: app?.bundle_id ?? null,
      appVersion: "1.0",
      appBuild: "1",
      osVersion: android ? "15" : "18.0",
      deviceModel: android ? "Pixel" : "iPhone",
      locale: "en_US",
      timeZone: "UTC",
      extinfo: null,
      ip: args.ip ?? null,
      userAgent: args.userAgent ?? null,
    },
    "initial_purchase",
    config.events.initial_purchase.name,
    app?.platform,
  );
  const r = await postMetaEvents(row.dataset_id, token, [event], { testEventCode: row.test_event_code, ip: args.ip });
  const response = parseJson<unknown>(r.response, r.response);
  return r.ok ? { ok: true, status: r.status, response } : { error: `Meta: ${r.message}`, status: r.status, response };
});
