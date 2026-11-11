// Refund requests: when a customer asks Apple for a refund, the App Store sends a CONSUMPTION_REQUEST notification and
// accepts consumption information for 12 hours (App Store Server API, Send Consumption Information v2:
// PUT /inApps/v2/transactions/consumption/{transactionId}, body ConsumptionRequest). Apple uses it, among other
// factors, to decide the refund.
//
//   ingestNotification (webhook, also when Revflare forwards it to another server) → consumption_requests (pending)
//   syncNotificationHistory (apps whose notifications go to another server: requests still inside Apple's window)
//   route → waitUntil(sendConsumptionInfo { appId }) tries at once; the cron drains due rows every tick (few requests)
//
// Forwarded and polled requests are answered too: another server (RevenueCat) only answers when it is set up to, and
// an unanswered request costs the sale (Apple sends it again every ~8 hours, then decides alone). Every row is also
// the log (the last 100 per app are shown). A request that cannot be answered (off, no attestation, Apple refused,
// window passed, setup missing) raises a refund_request_unanswered alert (Overview) and, when configured, a note in
// Studioflare (worker/lib/studioflare.ts).
//
// Settings per app (refund_settings), else the workspace defaults (refund_defaults), else off; turning it on needs the
// developer's attestation that they obtained their customers' consent (Apple requires it; customerConsented is always
// true when Revflare answers).
// A customer can withdraw consent (customers.refund_data_consent = 0): their requests are skipped.
// deliveryStatus is always DELIVERED (Revflare cannot know about delivery problems); consumptionPercentage is never
// sent for auto-renewable subscriptions (Apple computes it from the elapsed time).

import type { RefundPolicy, RefundRequestDefaults, RefundRequestLogItem, RefundRequestSettings, RefundRequestSettingsUpdate } from "../../shared/types";
import { AppStoreServerApi, AppleApiError, type ConsumptionRequestBody, type ServerEnvironment } from "../apple/api";
import type { AppleEvent } from "../apple/types";
import { raiseAlert, resolveAlerts } from "./alert-store";
import { getCredential } from "./credentials";
import { defineDbFunction, type Db } from "./db";
import { txFromApple } from "./ledger";
import { dayOf } from "./money";
import { postStudioflareNote } from "./studioflare";
import { errorMessage, now, parseJson } from "./util";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Apple accepts consumption information for 12 hours after the CONSUMPTION_REQUEST. */
export const CONSUMPTION_WINDOW_MS = 12 * HOUR;
/** Delay before retry n (429 / 5xx / network / missing key or bundle id; a 429's Retry-After when longer); a retry that would land after the deadline expires the request. */
export const CONSUMPTION_RETRY_DELAYS = [MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 4 * HOUR];
/** Per run: Apple requests made and rows looked at. */
const MAX_REQUESTS = 5;
const MAX_ROWS = 20;
/** A row being sent is held this long, so two runs never send it twice. */
const LEASE_MS = 2 * MINUTE;
export const REFUND_LOG_SIZE = 100;
/** Finished rows are kept this long. */
const RETENTION_MS = 180 * DAY;

export const REFUND_POLICIES: RefundPolicy[] = ["none", "decline", "decline_if_delivered_after_days", "grant_prorated", "grant_full"];

export interface RefundConfig {
  enabled: boolean;
  consentAttested: boolean;
  policy: RefundPolicy;
  declineAfterDays: number | null;
  sampleContentProvided: boolean;
  /** 0-100, null = not sent. */
  consumptionPercent: number | null;
}

interface SettingsRow {
  app_id: string;
  enabled: number;
  consent_attested_at: number | null;
  consent_attested_by: string | null;
  policy: string;
  decline_after_days: number | null;
  sample_content_provided: number;
  consumption_percent: number | null;
}

function configOf(row: Partial<SettingsRow> | null | undefined): RefundConfig {
  const policy = (REFUND_POLICIES as string[]).includes(row?.policy ?? "") ? (row!.policy as RefundPolicy) : "none";
  return {
    enabled: !!row?.enabled,
    consentAttested: !!row?.consent_attested_at,
    policy,
    declineAfterDays: row?.decline_after_days ?? null,
    sampleContentProvided: !!row?.sample_content_provided,
    consumptionPercent: row?.consumption_percent ?? null,
  };
}

// --- Plan ------------------------------------------------------------------------------------------------------------

/** skip.alert: the request goes unanswered because of the app's settings (an alert), not the customer or a test environment. */
export type ConsumptionPlan = { action: "send"; body: ConsumptionRequestBody } | { action: "skip"; reason: string; alert: boolean } | { action: "expire"; reason: string };

/**
 * What to do with a pending request now. `productType`: the ledger's (auto_renewable, consumable, ...); `startedAt`:
 * the purchase, or for a subscription its original purchase (the decline policy measures the age from there).
 */
export function planConsumption(p: { config: RefundConfig; productType: string | null; startedAt: number | null; environment: string; customerConsent: boolean; now: number; dueAt: number }): ConsumptionPlan {
  const c = p.config;
  if (p.environment !== "Production" && p.environment !== "Sandbox") return { action: "skip", reason: `${p.environment} environment: Apple's server does not take answers for it`, alert: false };
  if (!c.enabled) return { action: "skip", reason: "Answering refund requests is off for this app", alert: p.environment === "Production" };
  if (!c.consentAttested) return { action: "skip", reason: "Customer consent not confirmed in the app's refund request settings", alert: p.environment === "Production" };
  if (!p.customerConsent) return { action: "skip", reason: "The customer withdrew their consent to share consumption data with Apple", alert: false };
  if (p.now >= p.dueAt) return { action: "expire", reason: "Apple's 12-hour window has passed" };
  const auto = p.productType === "auto_renewable";
  const body: ConsumptionRequestBody = { customerConsented: true, deliveryStatus: "DELIVERED", sampleContentProvided: c.sampleContentProvided };
  // Never for auto-renewable subscriptions (Apple answers 400); 0-100 % in milliunits.
  const pct = !auto && c.consumptionPercent !== null ? Math.round(Math.min(100, Math.max(0, c.consumptionPercent)) * 1000) : null;
  if (pct !== null) body.consumptionPercentage = pct;
  if (c.policy === "grant_full") body.refundPreference = "GRANT_FULL";
  else if (c.policy === "decline") body.refundPreference = "DECLINE";
  else if (c.policy === "grant_prorated") {
    // Other products need a consumption percentage strictly between 0 and 100 % with GRANT_PRORATED.
    if (auto || (pct !== null && pct > 0 && pct < 100_000)) body.refundPreference = "GRANT_PRORATED";
  } else if (c.policy === "decline_if_delivered_after_days" && c.declineAfterDays !== null && p.startedAt !== null) {
    if (p.now - p.startedAt >= c.declineAfterDays * DAY) body.refundPreference = "DECLINE";
  }
  return { action: "send", body };
}

// --- Queue -----------------------------------------------------------------------------------------------------------

/**
 * Queues a CONSUMPTION_REQUEST: from the webhook (also when Revflare forwards it to another server, which may not
 * answer), or from Notification History polling while Apple's window is still open (apps whose notifications go to
 * another server; older polled requests are history, not work). The notification id keeps one row per request whichever
 * way it arrives. API data (transaction history) never carries requests.
 */
export async function queueConsumptionRequest(db: Db, app: { id: string }, ev: AppleEvent, requestReason: string | null): Promise<"queued" | null> {
  if (ev.type !== "CONSUMPTION_REQUEST" || !ev.transaction) return null;
  if (ev.source !== "webhook" && ev.source !== "history") return null;
  const t = now();
  if (ev.source === "history" && !(ev.signedAt > t - CONSUMPTION_WINDOW_MS)) return null;
  const tx = txFromApple(ev.transaction);
  // Apple's 12 hours count from its notification: the signing time when it is sane.
  const sentAt = ev.signedAt > 0 && ev.signedAt <= t ? ev.signedAt : t;
  const startedAt = tx.productType === "auto_renewable" ? (tx.originalPurchasedAt ?? tx.purchasedAt) : tx.purchasedAt;
  const r = await db
    .prepare(
      `INSERT INTO consumption_requests (app_id, transaction_id, original_transaction_id, product_id, product_type, started_at, environment, notification_uid,
         request_reason, received_at, due_at, status, next_attempt_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(app_id, notification_uid) DO NOTHING`,
    )
    .bind(
      app.id,
      tx.transactionId,
      tx.originalTransactionId,
      tx.productId,
      tx.productType,
      startedAt,
      ev.environment,
      ev.uid,
      requestReason?.slice(0, 64) ?? null,
      t,
      sentAt + CONSUMPTION_WINDOW_MS,
      t,
      t,
    )
    .run();
  return r.meta.changes ? "queued" : null;
}

// --- Delivery --------------------------------------------------------------------------------------------------------

type DueRow = {
  id: number;
  app_id: string;
  transaction_id: string;
  product_id: string | null;
  product_type: string | null;
  started_at: number | null;
  environment: string;
  due_at: number;
  attempts: number;
  workspace_id: string;
  app_name: string;
  bundle_id: string | null;
  customer_consent: number | null;
  /** Set when the app has its own settings row; else the d_ columns (workspace defaults) apply. */
  s_app: string | null;
  d_enabled: number | null;
  d_consent_attested_at: number | null;
  d_policy: string | null;
  d_decline_after_days: number | null;
  d_sample_content_provided: number | null;
  d_consumption_percent: number | null;
} & Partial<SettingsRow>;

/** The settings that apply to a due row: the app's own, else the workspace defaults. */
function rowConfig(r: DueRow): RefundConfig {
  if (r.s_app) return configOf(r);
  return configOf({
    enabled: r.d_enabled ?? 0,
    consent_attested_at: r.d_consent_attested_at,
    policy: r.d_policy ?? "none",
    decline_after_days: r.d_decline_after_days,
    sample_content_provided: r.d_sample_content_provided ?? 0,
    consumption_percent: r.d_consumption_percent,
  });
}

/** Unanswered requests of one app in a run (alert + Studioflare note). */
interface Unanswered {
  workspaceId: string;
  appId: string;
  appName: string;
  count: number;
  /** Still fixable before Apple's deadline (missing key / bundle id): retried. */
  retrying: boolean;
  reason: string;
  transactionId: string;
  productId: string | null;
}

const trim = (s: string | null | undefined, n = 500) => (s ? s.slice(0, n) : null);

/** Sends due answers (all apps, or one app right after its notification). At most `maxRequests` Apple requests. */
export const sendConsumptionInfo = defineDbFunction(
  "sendConsumptionInfo",
  async (db, args: { appId?: string; maxRequests?: number; at?: number }, env): Promise<{ sent: number; skipped: number; failed: number; expired: number; retrying: number; requests: number }> => {
    const t = args.at ?? now();
    const out = { sent: 0, skipped: 0, failed: 0, expired: 0, retrying: 0, requests: 0 };
    if (!args.appId) await db.prepare("DELETE FROM consumption_requests WHERE received_at < ? AND status != 'pending'").bind(t - RETENTION_MS).run();
    const { results: rows } = await db
      .prepare(
        `SELECT r.id, r.app_id, r.transaction_id, r.product_id, r.product_type, r.started_at, r.environment, r.due_at, r.attempts, a.workspace_id, a.name AS app_name, a.bundle_id,
           s.app_id AS s_app, s.enabled, s.consent_attested_at, s.policy, s.decline_after_days, s.sample_content_provided, s.consumption_percent,
           d.enabled AS d_enabled, d.consent_attested_at AS d_consent_attested_at, d.policy AS d_policy, d.decline_after_days AS d_decline_after_days,
           d.sample_content_provided AS d_sample_content_provided, d.consumption_percent AS d_consumption_percent,
           (SELECT c.refund_data_consent FROM transactions x JOIN customers c ON c.id = x.customer_id WHERE x.app_id = r.app_id AND x.transaction_id = r.transaction_id) AS customer_consent
         FROM consumption_requests r JOIN apps a ON a.id = r.app_id LEFT JOIN refund_settings s ON s.app_id = r.app_id LEFT JOIN refund_defaults d ON d.workspace_id = a.workspace_id
         WHERE r.status = 'pending' AND r.next_attempt_at <= ?${args.appId ? " AND r.app_id = ?" : ""} ORDER BY r.next_attempt_at LIMIT ?`,
      )
      .bind(...(args.appId ? [t, args.appId, MAX_ROWS] : [t, MAX_ROWS]))
      .all<DueRow>();
    if (!rows.length) return out;
    // Hold them (no I/O between the read and this write, so a concurrent run cannot pick them too).
    await db
      .prepare(`UPDATE consumption_requests SET next_attempt_at = ? WHERE status = 'pending' AND id IN (${rows.map(() => "?").join(", ")})`)
      .bind(t + LEASE_MS, ...rows.map((r) => r.id))
      .run();

    const finish = (id: number, status: "sent" | "skipped" | "failed" | "expired", d: { body?: unknown; http?: number | null; response?: string | null; reason?: string | null; attempt?: boolean }) =>
      db
        .prepare(
          `UPDATE consumption_requests SET status = ?, attempts = attempts + ?, request_body = COALESCE(?, request_body), http_status = COALESCE(?, http_status),
             response = COALESCE(?, response), reason = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(status, d.attempt ? 1 : 0, d.body ? JSON.stringify(d.body) : null, d.http ?? null, trim(d.response), trim(d.reason, 300), t, id)
        .run();

    const apis = new Map<string, AppStoreServerApi | string>();
    const apiFor = async (r: DueRow, environment: ServerEnvironment): Promise<AppStoreServerApi | string> => {
      const k = `${r.workspace_id}|${r.bundle_id}|${environment}`;
      let api = apis.get(k);
      if (!api) {
        if (!r.bundle_id) api = "The app has no bundle id yet (set it in the app's settings)";
        else {
          const cred = await getCredential(env, db, r.workspace_id, "appstore_iap");
          if (!cred) api = "No In-App Purchase key in this workspace yet (add one in Settings → App Store keys)";
          else {
            try {
              api = new AppStoreServerApi(cred, r.bundle_id, environment);
            } catch (err) {
              api = errorMessage(err);
            }
          }
        }
        apis.set(k, api);
      }
      return api;
    };

    const unanswered = new Map<string, Unanswered>();
    const miss = (r: DueRow, reason: string, retrying = false) => {
      if (r.environment !== "Production") return;
      const u = unanswered.get(r.app_id);
      if (u) {
        u.count++;
        u.retrying &&= retrying;
      } else
        unanswered.set(r.app_id, { workspaceId: r.workspace_id, appId: r.app_id, appName: r.app_name, count: 1, retrying, reason, transactionId: r.transaction_id, productId: r.product_id });
    };

    const max = args.maxRequests ?? MAX_REQUESTS;
    for (const r of rows) {
      const plan = planConsumption({
        config: rowConfig(r),
        productType: r.product_type,
        startedAt: r.started_at,
        environment: r.environment,
        customerConsent: r.customer_consent !== 0,
        now: t,
        dueAt: r.due_at,
      });
      if (plan.action === "skip") {
        await finish(r.id, "skipped", { reason: plan.reason });
        out.skipped++;
        // The customer's choice or a test environment is fine; a switched-off app is a lost answer.
        if (plan.alert) miss(r, plan.reason);
        continue;
      }
      if (plan.action === "expire") {
        await finish(r.id, "expired", { reason: plan.reason });
        out.expired++;
        miss(r, plan.reason);
        continue;
      }
      if (out.requests >= max) {
        // Back in line for the next run.
        await db.prepare("UPDATE consumption_requests SET next_attempt_at = ? WHERE id = ? AND status = 'pending'").bind(t, r.id).run();
        continue;
      }
      const api = await apiFor(r, r.environment === "Sandbox" ? "Sandbox" : "Production");
      let http: number | null = null;
      let response: string | null = null;
      let reason: string;
      let retry: boolean;
      let retryAfterMs = 0;
      if (typeof api === "string") {
        // Missing setup (key, bundle id) can still be fixed before Apple's deadline: keep retrying until then.
        reason = api;
        retry = true;
      } else {
        out.requests++;
        try {
          const res = await api.sendConsumptionInformation(r.transaction_id, plan.body);
          await finish(r.id, "sent", { body: plan.body, http: res.status, response: res.text || null, reason: null, attempt: true });
          out.sent++;
          continue;
        } catch (err) {
          if (err instanceof AppleApiError) {
            http = err.status;
            response = err.message;
            retry = err.status === 429 || err.status >= 500;
            if (err.status === 429 && err.retryAfter) retryAfterMs = err.retryAfter * 1000;
          } else {
            http = 0;
            response = `Network error: ${errorMessage(err)}`;
            retry = true;
          }
          reason = response;
        }
      }
      const next = t + Math.max(CONSUMPTION_RETRY_DELAYS[r.attempts] ?? Infinity, retryAfterMs);
      if (retry && next < r.due_at) {
        await db
          .prepare(
            `UPDATE consumption_requests SET attempts = attempts + 1, next_attempt_at = ?, request_body = ?, http_status = COALESCE(?, http_status),
               response = COALESCE(?, response), reason = ?, updated_at = ? WHERE id = ?`,
          )
          .bind(next, JSON.stringify(plan.body), http, trim(response), trim(`Retrying: ${reason}`, 300), t, r.id)
          .run();
        out.retrying++;
        // Missing setup can be fixed before the deadline: say so now, not after the window.
        if (typeof api === "string") miss(r, api, true);
      } else if (retry) {
        await finish(r.id, "expired", { body: plan.body, http, response, reason: `No answer accepted within Apple's 12-hour window (${reason})`, attempt: true });
        out.expired++;
        miss(r, `No answer accepted within Apple's 12-hour window (${reason})`);
      } else {
        await finish(r.id, "failed", { body: plan.body, http, response, reason, attempt: true });
        out.failed++;
        miss(r, `Apple refused the answer (HTTP ${http}): ${reason}`);
      }
    }
    for (const u of unanswered.values()) await alertUnanswered(env, db, u, t).catch((err) => console.error("refund alert failed", err));
    if (out.sent) {
      // Answers go out again: the app's open alerts are done.
      const done = new Map<string, string>();
      for (const r of rows) if (!unanswered.has(r.app_id)) done.set(r.app_id, r.workspace_id);
      for (const [appId, ws] of done) {
        const open = await db.prepare("SELECT 1 FROM alerts WHERE workspace_id = ? AND key LIKE ? AND resolved_at IS NULL LIMIT 1").bind(ws, `refund_unanswered:${appId}:%`).first();
        if (!open) continue;
        await resolveAlerts(db, ws, `refund_unanswered:${appId}:`);
        await refreshOverview(db, ws);
      }
    }
    return out;
  },
);

/**
 * A refund request went (or is going) unanswered: one alert per app and day (Overview, alerts) and, the first time, a
 * note in Studioflare. Without an answer Apple decides alone and usually refunds.
 */
async function alertUnanswered(env: Env, db: Db, u: Unanswered, t: number) {
  const what = u.count === 1 ? "A refund request" : `${u.count} refund requests`;
  const title = u.retrying ? `Refund requests of ${u.appName} cannot be answered yet` : `Refund request of ${u.appName} not answered`;
  const body = u.retrying
    ? `${what} from Apple wait for an answer (Apple's window is 12 hours): ${u.reason}.`
    : `${what} from Apple went unanswered (transaction ${u.transactionId}${u.productId ? `, ${u.productId}` : ""}): ${u.reason}. Without consumption information Apple decides alone.`;
  const isNew = await raiseAlert(env, db, { workspaceId: u.workspaceId, appId: u.appId, key: `refund_unanswered:${u.appId}:${dayOf(t)}`, kind: "refund_request_unanswered", severity: "warning", title, body });
  if (!isNew) return;
  await refreshOverview(db, u.workspaceId);
  await postStudioflareNote(env, `Revflare: ${title}. ${body} (revflare refunds ${u.appId} log)`);
}

/** The overview lists open alerts from its cached read: a new data version shows the change at once. */
const refreshOverview = (db: Db, workspaceId: string) =>
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(`data_version:${workspaceId}`, String(now())).run();

// --- Settings, log ---------------------------------------------------------------------------------------------------

/** Where an app's settings come from: its own row, else the workspace defaults. */
async function effectiveRow(db: Db, appId: string): Promise<{ row: SettingsRow | null; source: "app" | "workspace" | "none" }> {
  const own = await db.prepare("SELECT * FROM refund_settings WHERE app_id = ?").bind(appId).first<SettingsRow>();
  if (own) return { row: own, source: "app" };
  const d = await db
    .prepare("SELECT d.* FROM refund_defaults d JOIN apps a ON a.workspace_id = d.workspace_id WHERE a.id = ?")
    .bind(appId)
    .first<SettingsRow & { workspace_id: string }>();
  return d ? { row: d, source: "workspace" } : { row: null, source: "none" };
}

export async function refundSettingsView(db: Db, appId: string): Promise<RefundRequestSettings> {
  const [{ row, source }, app, counts, lastError] = await Promise.all([
    effectiveRow(db, appId),
    db.prepare("SELECT notification_url_status, forward_url, last_notification_at FROM apps WHERE id = ?").bind(appId).first<{ notification_url_status: string; forward_url: string | null; last_notification_at: number | null }>(),
    db.prepare("SELECT status, COUNT(*) AS n, MAX(updated_at) AS last FROM consumption_requests WHERE app_id = ? GROUP BY status").bind(appId).all<{ status: string; n: number; last: number }>(),
    db
      .prepare("SELECT reason, updated_at FROM consumption_requests WHERE app_id = ? AND status IN ('failed', 'expired') ORDER BY id DESC LIMIT 1")
      .bind(appId)
      .first<{ reason: string | null; updated_at: number }>(),
  ]);
  const c = configOf(row);
  const stats = { pending: 0, sent: 0, skipped: 0, failed: 0, expired: 0 };
  let lastSentAt: number | null = null;
  for (const r of counts.results) {
    if (r.status in stats) stats[r.status as keyof typeof stats] = r.n;
    if (r.status === "sent") lastSentAt = r.last;
  }
  return {
    source,
    enabled: c.enabled,
    consentAttested: c.consentAttested,
    consentAttestedAt: row?.consent_attested_at ?? null,
    consentAttestedBy: row?.consent_attested_by ?? null,
    refundPolicy: c.policy,
    declineAfterDays: c.declineAfterDays,
    sampleContentProvided: c.sampleContentProvided,
    consumptionPercent: c.consumptionPercent,
    deliveryStatus: "DELIVERED",
    notifications: { status: app?.notification_url_status ?? "unknown", forwarded: !!app?.forward_url, lastNotificationAt: app?.last_notification_at ?? null },
    stats,
    lastSentAt,
    lastError: lastError && (!lastSentAt || lastError.updated_at > lastSentAt) ? lastError.reason : null,
  };
}

/** Validates a PUT body (undefined = unchanged). */
export function parseRefundUpdate(body: Record<string, unknown>): RefundRequestSettingsUpdate | { error: string } {
  const out: RefundRequestSettingsUpdate = {};
  for (const k of ["enabled", "consentAttested", "sampleContentProvided"] as const) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== "boolean") return { error: `${k} must be true or false` };
    out[k] = body[k];
  }
  if (body.refundPolicy !== undefined) {
    if (typeof body.refundPolicy !== "string" || !(REFUND_POLICIES as string[]).includes(body.refundPolicy)) return { error: `refundPolicy must be one of ${REFUND_POLICIES.join(", ")}` };
    out.refundPolicy = body.refundPolicy as RefundPolicy;
  }
  if (body.declineAfterDays !== undefined) {
    const v = body.declineAfterDays;
    if (v !== null && (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 3650)) return { error: "declineAfterDays must be a whole number of days (1-3650) or null (refundPolicy decline declines at any age)" };
    out.declineAfterDays = v as number | null;
  }
  if (body.consumptionPercent !== undefined) {
    const v = body.consumptionPercent;
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100)) return { error: "consumptionPercent must be a number from 0 to 100 or null" };
    out.consumptionPercent = v === null ? null : Math.round((v as number) * 1000) / 1000;
  }
  return out;
}

/**
 * Applies a validated update to an app (`useDefaults` drops its own settings: the workspace defaults apply again), or to
 * the workspace defaults. An app without its own row starts from the defaults. `by`: who confirmed the consent
 * attestation (when it is set now).
 */
export async function saveRefundSettings(
  db: Db,
  target: { appId: string } | { workspaceId: string },
  u: RefundRequestSettingsUpdate & { useDefaults?: boolean },
  by: string,
): Promise<{ error?: string }> {
  if ("appId" in target && u.useDefaults) {
    await db.prepare("DELETE FROM refund_settings WHERE app_id = ?").bind(target.appId).run();
    return {};
  }
  const row =
    "appId" in target
      ? (await effectiveRow(db, target.appId)).row
      : await db.prepare("SELECT * FROM refund_defaults WHERE workspace_id = ?").bind(target.workspaceId).first<SettingsRow>();
  const c = configOf(row);
  const t = now();
  let attestedAt = row?.consent_attested_at ?? null;
  let attestedBy = row?.consent_attested_by ?? null;
  if (u.consentAttested === true && !attestedAt) {
    attestedAt = t;
    attestedBy = by.slice(0, 200);
  } else if (u.consentAttested === false) {
    attestedAt = null;
    attestedBy = null;
  }
  // Withdrawing the attestation turns answers off.
  let enabled = u.enabled ?? c.enabled;
  if (u.consentAttested === false) enabled = false;
  if (enabled && !attestedAt) return { error: "Confirm that you obtained your customers' consent to share consumption data with Apple (consentAttested: true) before turning this on" };
  const policy = u.refundPolicy ?? c.policy;
  const days = u.declineAfterDays !== undefined ? u.declineAfterDays : c.declineAfterDays;
  if (policy === "decline_if_delivered_after_days" && !days) return { error: "decline_if_delivered_after_days needs declineAfterDays (1-3650)" };
  const [table, key] = "appId" in target ? ["refund_settings", "app_id"] : ["refund_defaults", "workspace_id"];
  await db
    .prepare(
      `INSERT INTO ${table} (${key}, enabled, consent_attested_at, consent_attested_by, policy, decline_after_days, sample_content_provided, consumption_percent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(${key}) DO UPDATE SET enabled = excluded.enabled, consent_attested_at = excluded.consent_attested_at, consent_attested_by = excluded.consent_attested_by,
         policy = excluded.policy, decline_after_days = excluded.decline_after_days, sample_content_provided = excluded.sample_content_provided,
         consumption_percent = excluded.consumption_percent, updated_at = excluded.updated_at`,
    )
    .bind(
      "appId" in target ? target.appId : target.workspaceId,
      enabled ? 1 : 0,
      attestedAt,
      attestedBy,
      policy,
      days ?? null,
      (u.sampleContentProvided ?? c.sampleContentProvided) ? 1 : 0,
      u.consumptionPercent !== undefined ? u.consumptionPercent : c.consumptionPercent,
      t,
      t,
    )
    .run();
  return {};
}

/** GET /integrations/refunds/defaults: the workspace defaults and the apps that use them. */
export async function refundDefaultsView(db: Db, workspaceId: string): Promise<RefundRequestDefaults> {
  const [row, apps] = await Promise.all([
    db.prepare("SELECT * FROM refund_defaults WHERE workspace_id = ?").bind(workspaceId).first<SettingsRow>(),
    db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN s.app_id IS NULL THEN 1 ELSE 0 END) AS inheriting FROM apps a LEFT JOIN refund_settings s ON s.app_id = a.id
         WHERE a.workspace_id = ? AND a.archived = 0 AND a.platform = 'ios'`,
      )
      .bind(workspaceId)
      .first<{ total: number; inheriting: number | null }>(),
  ]);
  const c = configOf(row);
  return {
    enabled: c.enabled,
    consentAttested: c.consentAttested,
    consentAttestedAt: row?.consent_attested_at ?? null,
    consentAttestedBy: row?.consent_attested_by ?? null,
    refundPolicy: c.policy,
    declineAfterDays: c.declineAfterDays,
    sampleContentProvided: c.sampleContentProvided,
    consumptionPercent: c.consumptionPercent,
    apps: { total: apps?.total ?? 0, usingDefaults: apps?.inheriting ?? 0 },
  };
}

export async function refundRequestLog(db: Db, appId: string, limit = REFUND_LOG_SIZE): Promise<RefundRequestLogItem[]> {
  const { results } = await db
    .prepare(
      `SELECT r.*, p.name AS product_name FROM consumption_requests r LEFT JOIN products p ON p.app_id = r.app_id AND p.product_id = r.product_id
       WHERE r.app_id = ? ORDER BY r.id DESC LIMIT ?`,
    )
    .bind(appId, Math.min(Math.max(1, Math.floor(limit) || REFUND_LOG_SIZE), REFUND_LOG_SIZE))
    .all<{
      id: number;
      received_at: number;
      due_at: number;
      transaction_id: string;
      original_transaction_id: string | null;
      product_id: string | null;
      product_name: string | null;
      environment: string;
      request_reason: string | null;
      status: RefundRequestLogItem["status"];
      attempts: number;
      request_body: string | null;
      http_status: number | null;
      response: string | null;
      reason: string | null;
      updated_at: number;
    }>();
  return results.map((r) => ({
    id: r.id,
    receivedAt: r.received_at,
    dueAt: r.due_at,
    transactionId: r.transaction_id,
    originalTransactionId: r.original_transaction_id,
    productId: r.product_id,
    productName: r.product_name,
    environment: r.environment,
    requestReason: r.request_reason,
    status: r.status,
    attempts: r.attempts,
    request: r.request_body ? parseJson<Record<string, unknown> | null>(r.request_body, null) : null,
    httpStatus: r.http_status,
    response: r.response,
    reason: r.reason,
    updatedAt: r.updated_at,
  }));
}

/** PUT /customers/:id/refund-consent. Returns false when the customer is not in the workspace. */
export async function setRefundConsent(db: Db, workspaceId: string, customerId: string, consent: boolean): Promise<boolean> {
  const r = await db.prepare("UPDATE customers SET refund_data_consent = ? WHERE id = ? AND workspace_id = ?").bind(consent ? 1 : 0, customerId, workspaceId).run();
  return r.meta.changes > 0;
}
