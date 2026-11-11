// Push notifications to the Revflare iOS app (APNs, token auth): sales, renewals, refunds, alerts, summaries, plus
// silent widget refreshes and Live Activity ("today's revenue") updates. Texts are localized on the device
// (loc-key / loc-args, see ios/Revflare/Resources/*.lproj/Localizable.strings).

import { COUNTRY_NAMES, flag } from "../../shared/countries";
import { es256Jwt } from "./crypto";
import type { Db } from "./db";
import { FxCache, dayOf } from "./money";
import { now, parseJson } from "./util";

export interface DevicePrefs {
  sales: boolean;
  renewals: boolean;
  trials: boolean;
  refunds: boolean;
  cancellations: boolean;
  alerts: boolean;
  /** Event silence, funnel anomaly and release regression alerts (push kind "funnel"). */
  funnelAlerts: boolean;
  dailySummary: boolean;
  weeklySummary: boolean;
  /** Only sales worth at least this much (USD). */
  minUsd: number;
  /** Only these apps (ids); null = all. */
  apps: string[] | null;
  /** Per app (id): `muted` silences the app; a kind set here wins over the global one. */
  appOverrides: Record<string, AppPushOverride>;
  /** "cash" (cash register) or "default". */
  sound: "cash" | "default" | "none";
  /** Quiet hours in the device's time zone ("23:00"–"08:00"); null = off. */
  quietStart: string | null;
  quietEnd: string | null;
  timezone: string;
  locale: string;
  /**
   * The push texts (loc-keys) the device's app build knows, sent by the app with its preferences (0: builds before
   * funnel alerts, which display unknown loc-keys raw). Newer pushes only go to builds that can show them.
   */
  pushVersion: number;
}

/** pushVersion of the builds that know the funnel alert loc-keys and the summary's digest line (PUSH_*_DIGEST). */
export const PUSH_VERSION_FUNNEL = 1;
/** pushVersion of the builds that know the Apple Ads sale texts (PUSH_BODY_SALE_ADS, PUSH_BODY_TRIAL_ADS). */
export const PUSH_VERSION_ADS = 2;
/** pushVersion of the builds that know the Google Play alert texts (PUSH_BODY_ALERT_SILENT_PLAY). */
export const PUSH_VERSION_PLAY = 3;
/** pushVersion of the builds that know the goal texts (PUSH_TITLE_GOAL*, PUSH_BODY_GOAL_REACHED). */
export const PUSH_VERSION_GOALS = 4;

/** Kinds of sale / event notifications that can be turned off per app. */
export const APP_PUSH_KINDS = ["sales", "renewals", "trials", "refunds", "cancellations", "alerts", "funnelAlerts"] as const;
export type AppPushKind = (typeof APP_PUSH_KINDS)[number];
export type AppPushOverride = { muted?: boolean } & Partial<Record<AppPushKind, boolean>>;

export const DEFAULT_PREFS: DevicePrefs = {
  sales: true,
  renewals: true,
  trials: true,
  refunds: true,
  cancellations: false,
  alerts: true,
  funnelAlerts: true,
  dailySummary: true,
  weeklySummary: true,
  minUsd: 0,
  apps: null,
  appOverrides: {},
  sound: "cash",
  quietStart: null,
  quietEnd: null,
  timezone: "UTC",
  locale: "en",
  pushVersion: 0,
};

export function parsePrefs(json: string | null | undefined): DevicePrefs {
  return { ...DEFAULT_PREFS, ...parseJson<Partial<DevicePrefs>>(json, {}) };
}

export interface DeviceRow {
  id: string;
  apns_token: string;
  environment: string;
  activity_token: string | null;
  widget_token?: string | null;
  prefs: string;
}

export type PushKind = "sale" | "renewal" | "trial" | "conversion" | "refund" | "cancellation" | "alert" | "funnel" | "goal" | "summary" | "test";

export interface PushMessage {
  kind: PushKind;
  appId?: string | null;
  titleKey: string;
  titleArgs?: string[];
  bodyKey: string;
  bodyArgs?: string[];
  /** USD value for the min-amount filter. */
  amountUsd?: number;
  data?: Record<string, unknown>;
  /** Groups notifications in Notification Center. */
  threadId?: string;
  /** Another body for app builds whose pushVersion is at least `pushVersion` (older builds would show the key raw). */
  newer?: { pushVersion: number; bodyKey: string; bodyArgs: string[] };
}

/** The message as one device gets it: the newer body when its build knows the keys. */
export function messageFor(msg: PushMessage, prefs: DevicePrefs): PushMessage {
  const { newer, ...rest } = msg;
  if (!newer || !(prefs.pushVersion >= newer.pushVersion)) return rest;
  return { ...rest, bodyKey: newer.bodyKey, bodyArgs: newer.bodyArgs };
}

let jwtCache: { value: string; at: number } | null = null;

async function apnsJwt(env: Env): Promise<string | null> {
  if (!env.APNS_PRIVATE_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID) return null;
  // Apple wants the token refreshed at most every 20 minutes and at least every hour.
  if (jwtCache && jwtCache.at > Date.now() - 40 * 60_000) return jwtCache.value;
  const value = await es256Jwt(env.APNS_PRIVATE_KEY, { kid: env.APNS_KEY_ID }, { iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) });
  jwtCache = { value, at: Date.now() };
  return value;
}

export function apnsConfigured(env: Env): boolean {
  return !!(env.APNS_PRIVATE_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC);
}

async function send(env: Env, db: Db, device: DeviceRow, pushType: "alert" | "background" | "liveactivity" | "widgets", payload: unknown, opts: { priority?: number; collapseId?: string; expiration?: number } = {}) {
  const jwt = await apnsJwt(env);
  if (!jwt || !env.APNS_TOPIC) return { ok: false, status: 0 };
  const token = pushType === "liveactivity" ? device.activity_token : pushType === "widgets" ? device.widget_token : device.apns_token;
  if (!token) return { ok: false, status: 0 };
  const topic = pushType === "liveactivity" ? `${env.APNS_TOPIC}.push-type.liveactivity` : pushType === "widgets" ? `${env.APNS_TOPIC}.push-type.widgets` : env.APNS_TOPIC;
  const host = device.environment === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  const res = await fetch(`https://${host}/3/device/${token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": topic,
      "apns-push-type": pushType,
      "apns-priority": String(opts.priority ?? (pushType === "alert" || pushType === "liveactivity" ? 10 : 5)),
      "apns-expiration": String(opts.expiration ?? Math.floor(Date.now() / 1000) + 3600),
      ...(opts.collapseId ? { "apns-collapse-id": opts.collapseId } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (res.status === 410 || res.status === 400) {
    const reason = ((await res.json().catch(() => ({}))) as { reason?: string }).reason;
    if (res.status === 410 || reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic") {
      // Only a dead alert token removes the device; Live Activity / widget tokens are just forgotten.
      if (pushType === "liveactivity") await db.prepare("UPDATE devices SET activity_token = NULL WHERE id = ?").bind(device.id).run();
      else if (pushType === "widgets") await db.prepare("UPDATE devices SET widget_token = NULL WHERE id = ?").bind(device.id).run();
      else if (pushType === "alert") await db.prepare("DELETE FROM devices WHERE id = ?").bind(device.id).run();
    }
    console.warn(JSON.stringify({ event: "apns_rejected", status: res.status, reason, pushType }));
  } else if (!res.ok) {
    console.warn(JSON.stringify({ event: "apns_failed", status: res.status, pushType, body: (await res.text()).slice(0, 200) }));
  }
  return { ok: res.ok, status: res.status };
}

function inQuietHours(prefs: DevicePrefs, at = new Date()): boolean {
  if (!prefs.quietStart || !prefs.quietEnd) return false;
  let hm: string;
  try {
    hm = at.toLocaleTimeString("en-GB", { timeZone: prefs.timezone || "UTC", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    hm = at.toISOString().slice(11, 16);
  }
  return prefs.quietStart <= prefs.quietEnd ? hm >= prefs.quietStart && hm < prefs.quietEnd : hm >= prefs.quietStart || hm < prefs.quietEnd;
}

const KIND_PREF: Record<PushKind, keyof DevicePrefs | null> = {
  sale: "sales",
  conversion: "sales",
  renewal: "renewals",
  trial: "trials",
  refund: "refunds",
  cancellation: "cancellations",
  alert: "alerts",
  funnel: "funnelAlerts",
  // Goal pushes are asked for per goal (goals.notify).
  goal: null,
  summary: null,
  test: null,
};

/** Devices of the workspace's members. */
async function workspaceDevices(db: Db, workspaceId: string): Promise<DeviceRow[]> {
  const { results } = await db
    .prepare(
      `SELECT d.id, d.apns_token, d.environment, d.activity_token, d.widget_token, d.prefs FROM devices d
       WHERE d.user_id IN (SELECT user_id FROM workspace_members WHERE workspace_id = ?)
          OR d.user_id IN (SELECT id FROM users WHERE is_admin = 1)`,
    )
    .bind(workspaceId)
    .all<DeviceRow>();
  return results;
}

function alertPayload(msg: PushMessage, prefs: DevicePrefs) {
  const quiet = inQuietHours(prefs);
  const sound = quiet || prefs.sound === "none" ? undefined : prefs.sound === "cash" && ["sale", "conversion", "renewal"].includes(msg.kind) ? "cash.caf" : "default";
  return {
    aps: {
      alert: { "title-loc-key": msg.titleKey, "title-loc-args": msg.titleArgs ?? [], "loc-key": msg.bodyKey, "loc-args": msg.bodyArgs ?? [] },
      ...(sound ? { sound } : {}),
      "thread-id": msg.threadId ?? msg.appId ?? msg.kind,
      "interruption-level": quiet ? "passive" : "active",
      "mutable-content": 1,
    },
    kind: msg.kind,
    ...(msg.appId ? { appId: msg.appId } : {}),
    ...(msg.data ?? {}),
  };
}

/** Whether a device's preferences want this message. */
export function wants(prefs: DevicePrefs, msg: PushMessage): boolean {
  // Older app builds have no texts for funnel alerts (and no setting to turn them off).
  if (msg.kind === "funnel" && !(prefs.pushVersion >= PUSH_VERSION_FUNNEL)) return false;
  if (msg.kind === "goal" && !(prefs.pushVersion >= PUSH_VERSION_GOALS)) return false;
  const pref = KIND_PREF[msg.kind];
  const app = msg.appId ? prefs.appOverrides?.[msg.appId] : undefined;
  if (app?.muted && pref) return false;
  const on = pref ? (app?.[pref as AppPushKind] ?? prefs[pref]) : true;
  if (!on) return false;
  if (msg.appId && prefs.apps && !prefs.apps.includes(msg.appId)) return false;
  if (msg.amountUsd !== undefined && ["sale", "renewal", "conversion"].includes(msg.kind) && msg.amountUsd < prefs.minUsd) return false;
  return true;
}

/**
 * Tests (TEST_MODE only): when `sink` is set, alert pushes are recorded here instead of going to APNs (the test Worker
 * has no APNs key).
 */
export const pushTestHooks: { sink: { deviceId: string; msg: PushMessage }[] | null } = { sink: null };
const testSink = (env: Env) => (env.TEST_MODE === "true" ? pushTestHooks.sink : null);

/** Sends one alert to one device (no preference check). */
export async function pushToDevice(env: Env, db: Db, device: DeviceRow, msg: PushMessage): Promise<boolean> {
  const sink = testSink(env);
  const prefs = parsePrefs(device.prefs);
  if (sink) {
    sink.push({ deviceId: device.id, msg: messageFor(msg, prefs) });
    return true;
  }
  if (!apnsConfigured(env)) return false;
  const r = await send(env, db, device, "alert", alertPayload(messageFor(msg, prefs), prefs));
  if (r.ok) await db.prepare("UPDATE devices SET last_push_at = ? WHERE id = ?").bind(now(), device.id).run();
  return r.ok;
}

/** The workspace's devices whose preferences want this message. */
export async function pushRecipients(db: Db, workspaceId: string, msg: PushMessage): Promise<DeviceRow[]> {
  return (await workspaceDevices(db, workspaceId)).filter((d) => wants(parsePrefs(d.prefs), msg));
}

/** A per-invocation cap on outbound requests (worker/lib/insights.ts TickBudget): one APNs request per device. */
export interface SendBudget {
  take(n?: number, kind?: "sql" | "email" | "push"): boolean;
}

/**
 * Sends one alert to every device of the workspace whose preferences want it. With a budget, each device takes one
 * request from it; devices beyond it get nothing (logged).
 */
export async function pushToWorkspace(env: Env, db: Db, workspaceId: string, msg: PushMessage, budget?: SendBudget): Promise<number> {
  const sink = testSink(env);
  if (!sink && !apnsConfigured(env)) return 0;
  const devices = await pushRecipients(db, workspaceId, msg);
  let sent = 0;
  let skipped = 0;
  for (const d of devices) {
    if (budget && !budget.take(1, "push")) {
      skipped++;
      continue;
    }
    const prefs = parsePrefs(d.prefs);
    if (sink) {
      sink.push({ deviceId: d.id, msg: messageFor(msg, prefs) });
      sent++;
      continue;
    }
    const r = await send(env, db, d, "alert", alertPayload(messageFor(msg, prefs), prefs));
    if (r.ok) sent++;
  }
  if (skipped) console.warn(JSON.stringify({ event: "push_budget_exhausted", kind: msg.kind, skipped }));
  if (sink) return sent;
  if (sent) await db.prepare("UPDATE devices SET last_push_at = ? WHERE user_id IN (SELECT user_id FROM workspace_members WHERE workspace_id = ?)").bind(now(), workspaceId).run();
  return sent;
}

/**
 * A web sign-in request (docs/app-login-spec.md) to every device of the user with push and a live session. No
 * preferences or quiet hours: the user just asked for it. Tapping opens the approval sheet (category WEB_LOGIN, no
 * actions: approving needs Face ID in the app). Returns the number of devices Apple accepted it for.
 */
export async function pushWebLogin(env: Env, db: Db, userId: string, req: { id: string; expiresAt: number; browser: string; os: string; place: string }): Promise<number> {
  if (!apnsConfigured(env)) return 0;
  const { results } = await db
    .prepare(
      `SELECT d.id, d.apns_token, d.environment, d.activity_token, d.prefs FROM devices d JOIN sessions s ON s.id = d.session_id
       WHERE d.user_id = ? AND s.kind = 'device' AND s.expires_at > ?`,
    )
    .bind(userId, now())
    .all<DeviceRow>();
  let sent = 0;
  for (const d of results.slice(0, 10)) {
    const payload = {
      aps: {
        alert: {
          "title-loc-key": "PUSH_TITLE_WEB_LOGIN",
          "loc-key": req.place ? "PUSH_BODY_WEB_LOGIN" : "PUSH_BODY_WEB_LOGIN_NO_PLACE",
          "loc-args": req.place ? [req.browser, req.os, req.place] : [req.browser, req.os],
        },
        sound: "default",
        category: "WEB_LOGIN",
        "thread-id": "web-login",
        "interruption-level": "time-sensitive",
      },
      type: "web_login",
      kind: "web_login",
      id: req.id,
    };
    const r = await send(env, db, d, "alert", payload, { priority: 10, expiration: Math.floor(req.expiresAt / 1000), collapseId: req.id.slice(0, 64) });
    if (r.ok) sent++;
  }
  return sent;
}

/** Today's totals for widgets and the Live Activity. */
async function todayState(db: Db, workspaceId: string) {
  const today = dayOf(now());
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(gross_usd), 0) AS revenue, COALESCE(SUM(proceeds_usd), 0) AS proceeds,
         COALESCE(SUM(new_subscriptions + renewals + one_time_purchases), 0) AS sales, COALESCE(SUM(mrr_usd), 0) AS mrr
       FROM daily_metrics WHERE workspace_id = ? AND day = ?`,
    )
    .bind(workspaceId, today)
    .first<{ revenue: number; proceeds: number; sales: number; mrr: number }>();
  return { day: today, revenueUsd: row?.revenue ?? 0, proceedsUsd: row?.proceeds ?? 0, sales: row?.sales ?? 0, mrrUsd: row?.mrr ?? 0 };
}

/**
 * After new revenue: refresh widgets (background) and running Live Activities. The Live Activity content state is in
 * the workspace currency: { revenue, proceeds, sales, mrr, currency, lastAppName, lastAmount, lastProductName,
 * updatedAt (unix seconds) } (ios/Revflare/Core/LiveActivity.swift decodes it).
 */
export async function pushLiveUpdates(env: Env, db: Db, workspaceId: string, last?: { appName: string; amountUsd: number; productName: string }) {
  if (!apnsConfigured(env)) return;
  const devices = await workspaceDevices(db, workspaceId);
  if (!devices.length) return;
  const state = await todayState(db, workspaceId);
  const ws = await db.prepare("SELECT currency FROM workspaces WHERE id = ?").bind(workspaceId).first<{ currency: string }>();
  const currency = ws?.currency ?? "USD";
  const rate = await new FxCache(db).perUsd(currency, state.day);
  const ts = Math.floor(Date.now() / 1000);
  const r2 = (n: number) => Math.round(n * rate * 100) / 100;
  for (const d of devices) {
    if (d.widget_token) await send(env, db, d, "widgets", { aps: { "content-changed": true } }, { priority: 5, collapseId: "widgets" });
    if (d.activity_token) {
      await send(env, db, d, "liveactivity", {
        aps: {
          timestamp: ts,
          event: "update",
          "content-state": {
            revenue: r2(state.revenueUsd),
            proceeds: r2(state.proceedsUsd),
            sales: state.sales,
            mrr: r2(state.mrrUsd),
            currency,
            lastAppName: last?.appName ?? null,
            lastAmount: last ? r2(last.amountUsd) : null,
            lastProductName: last?.productName ?? null,
            updatedAt: ts,
          },
        },
      });
    }
  }
}

/** Formats "🇩🇪 Germany" for push arguments. */
export function countryLabel(alpha2: string | null): string {
  if (!alpha2) return "";
  return `${flag(alpha2)} ${COUNTRY_NAMES[alpha2] ?? alpha2}`;
}

/** "$4.99" — amounts in pushes are USD converted to the workspace currency. */
export function formatMoney(amount: number, currency: string, locale = "en"): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Local time ("09:05"), weekday ("Mon") and day (YYYY-MM-DD) in a time zone (UTC when it is unknown). */
export function localParts(timezone: string, at: number): { hm: string; weekday: string; day: string } {
  try {
    const d = new Date(at);
    const hm = d.toLocaleTimeString("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false });
    const weekday = d.toLocaleDateString("en-US", { timeZone: timezone, weekday: "short" });
    const day = d.toLocaleDateString("en-CA", { timeZone: timezone });
    return { hm, weekday, day };
  } catch {
    const iso = new Date(at).toISOString();
    return { hm: iso.slice(11, 16), weekday: new Date(at).toUTCString().slice(0, 3), day: iso.slice(0, 10) };
  }
}
