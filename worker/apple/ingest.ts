// Apple → ledger: App Store Server Notifications V2 (webhook), Notification History (backfill and polling for apps
// whose notifications go to another server, e.g. RevenueCat), Transaction History and subscription statuses.
// Everything here runs inside the database object (30 s CPU per call): JWS verification is not cheap.

import { getCredential } from "../lib/credentials";
import { defineDbFunction, type Db } from "../lib/db";
import { backgroundAllowed, metered } from "../lib/budget";
import { applyAppleEventsLocal, type LedgerResult } from "../lib/ledger";
import { queueConsumptionRequest } from "../lib/refunds";
import { adsPushLabel, purchaseAttribution } from "../lib/ads-names";
import { pushLiveUpdates, pushToWorkspace, countryLabel, formatMoney, PUSH_VERSION_ADS, type PushMessage } from "../lib/push";
import { rebuildQueued } from "../lib/rollup";
import { FxCache, dayOf } from "../lib/money";
import { errorMessage, now, parseJson } from "../lib/util";
import { AppStoreServerApi, AppleApiError } from "./api";
import { JwsError, trustedRoots, verifyAppleJws } from "./jws";
import type { AppleEvent, NotificationPayload, RenewalInfo, TransactionInfo } from "./types";

const DAY = 86_400_000;

export interface AppRow {
  id: string;
  workspace_id: string;
  name: string;
  bundle_id: string | null;
  apple_app_id: string | null;
  history_synced_until: number | null;
  notification_url_status: string;
  forward_url?: string | null;
}

const APP_COLUMNS = "id, workspace_id, name, bundle_id, apple_app_id, history_synced_until, notification_url_status, forward_url";

/** Verifies a notification (outer JWS and the transaction / renewal JWS inside) and turns it into an event. */
export async function eventFromSignedPayload(env: Env, signedPayload: string, source: AppleEvent["source"]) {
  const roots = trustedRoots(env);
  const payload = await verifyAppleJws<NotificationPayload>(signedPayload, { roots });
  const data = payload.data ?? {};
  const transaction = data.signedTransactionInfo ? await verifyAppleJws<TransactionInfo>(data.signedTransactionInfo, { roots }) : null;
  const renewal = data.signedRenewalInfo ? await verifyAppleJws<RenewalInfo>(data.signedRenewalInfo, { roots }) : null;
  const event: AppleEvent = {
    uid: payload.notificationUUID,
    source,
    type: payload.notificationType,
    subtype: payload.subtype ?? null,
    environment: data.environment ?? payload.summary?.environment ?? transaction?.environment ?? "Production",
    signedAt: payload.signedDate,
    transaction,
    renewal,
    status: data.status ?? null,
    r2Key: null,
  };
  return { event, payload, bundleId: data.bundleId ?? payload.summary?.bundleId ?? transaction?.bundleId, appAppleId: data.appAppleId };
}

export async function productName(db: Db, appId: string, productId: string): Promise<string> {
  const row = await db.prepare("SELECT name FROM products WHERE app_id = ? AND product_id = ?").bind(appId, productId).first<{ name: string | null }>();
  if (row?.name) return row.name;
  const last = productId.split(".").pop() ?? productId;
  return last.replace(/[_-]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/** Push notifications for fresh events (not for backfilled history). */
async function notifyEvents(env: Env, db: Db, app: AppRow, events: AppleEvent[], result: LedgerResult) {
  const ws = await db.prepare("SELECT currency FROM workspaces WHERE id = ?").bind(app.workspace_id).first<{ currency: string }>();
  const currency = ws?.currency ?? "USD";
  const fx = new FxCache(db);
  const rate = await fx.perUsd(currency, dayOf(now()));
  let revenue: { appName: string; amountUsd: number; productName: string } | undefined;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const r = result.events[i];
    if (!r || r.duplicate) continue;
    // Old events (backfill) never push; polled history events do while they are fresh.
    if (ev.signedAt < now() - 30 * 60_000) continue;
    const sandbox = ev.environment !== "Production" ? " (Sandbox)" : "";
    let msg: PushMessage | null = null;
    if (ev.type === "TEST") {
      msg = { kind: "test", appId: app.id, titleKey: "PUSH_TITLE_TEST", titleArgs: [app.name], bodyKey: "PUSH_BODY_TEST", bodyArgs: [sandbox.trim()] };
    } else if (ev.type === "REFUND" && r.productId) {
      const amount = formatMoney(Math.abs(r.amountUsd) * rate, currency);
      msg = {
        kind: "refund",
        appId: app.id,
        titleKey: "PUSH_TITLE_REFUND",
        titleArgs: [app.name + sandbox],
        bodyKey: "PUSH_BODY_SALE",
        bodyArgs: [await productName(db, app.id, r.productId), countryLabel(r.country), amount],
        amountUsd: r.amountUsd,
        data: { transactionId: r.transactionId },
      };
    } else if (ev.type === "DID_CHANGE_RENEWAL_STATUS" && ev.subtype === "AUTO_RENEW_DISABLED" && ev.transaction) {
      msg = {
        kind: "cancellation",
        appId: app.id,
        titleKey: "PUSH_TITLE_CANCELLATION",
        titleArgs: [app.name + sandbox],
        bodyKey: "PUSH_BODY_CANCELLATION",
        bodyArgs: [await productName(db, app.id, ev.transaction.productId), countryLabel(r.country)],
      };
    } else if (r.isNewTransaction && r.productId && r.kind) {
      const kind = r.kind === "one_time" || r.kind === "new" ? "sale" : (r.kind as "renewal" | "trial" | "conversion");
      const titleKey = { one_time: "PUSH_TITLE_PURCHASE", new: "PUSH_TITLE_NEW_SUBSCRIPTION", renewal: "PUSH_TITLE_RENEWAL", trial: "PUSH_TITLE_TRIAL", conversion: "PUSH_TITLE_CONVERSION" }[r.kind] ?? "PUSH_TITLE_PURCHASE";
      const name = await productName(db, app.id, r.productId);
      const amount = r.kind === "trial" ? "" : formatMoney(r.amountUsd * rate, currency);
      const bodyKey = r.kind === "trial" ? "PUSH_BODY_TRIAL" : "PUSH_BODY_SALE";
      const bodyArgs = r.kind === "trial" ? [name, countryLabel(r.country)] : [name, countryLabel(r.country), amount];
      // Apple Ads purchases (not Apple's test attribution): "… · Apple Ads · <ad group>" for builds that know the keys.
      const ads = ev.transaction
        ? adsPushLabel(await purchaseAttribution(db, app.id, ev.transaction.originalTransactionId, ev.transaction.appAccountToken ?? null))
        : null;
      msg = {
        kind,
        appId: app.id,
        titleKey,
        titleArgs: [app.name + sandbox],
        bodyKey,
        bodyArgs,
        amountUsd: r.amountUsd,
        data: { transactionId: r.transactionId },
        ...(ads ? { newer: { pushVersion: PUSH_VERSION_ADS, bodyKey: `${bodyKey}_ADS`, bodyArgs: [...bodyArgs, ads] } } : {}),
      };
      if (r.amountUsd > 0 && ev.environment === "Production") revenue = { appName: app.name, amountUsd: r.amountUsd, productName: name };
    }
    if (msg) await pushToWorkspace(env, db, app.workspace_id, msg);
  }
  if (revenue) await pushLiveUpdates(env, db, app.workspace_id, revenue);
}

async function storeRaw(env: Env, app: AppRow, uid: string, signedPayload: string): Promise<string | null> {
  const t = new Date();
  const key = `raw/apple/${app.id}/${t.getUTCFullYear()}/${String(t.getUTCMonth() + 1).padStart(2, "0")}/${uid}.json`;
  try {
    await env.RAW.put(key, JSON.stringify({ signedPayload, receivedAt: t.toISOString() }), { httpMetadata: { contentType: "application/json" } });
    return key;
  } catch (err) {
    console.error("raw notification not stored", err);
    return null;
  }
}

/** POST /apple/notifications/:key — one App Store Server Notification V2. */
export const ingestNotification = defineDbFunction(
  "ingestNotification",
  async (
    db,
    args: { key: string; signedPayload: string },
    env,
  ): Promise<{ status: number; error?: string; type?: string; duplicate?: boolean; appId?: string; forwardUrl?: string | null; consumptionRequest?: boolean }> => {
    const app = await db.prepare(`SELECT ${APP_COLUMNS} FROM apps WHERE notification_key = ? AND platform = 'ios'`).bind(args.key).first<AppRow>();
    if (!app) return { status: 404, error: "Unknown notification URL" };
    let parsed: Awaited<ReturnType<typeof eventFromSignedPayload>>;
    try {
      parsed = await eventFromSignedPayload(env, args.signedPayload, "webhook");
    } catch (err) {
      if (err instanceof JwsError) return { status: 400, error: `Signature check failed: ${err.message}` };
      throw err;
    }
    if (app.bundle_id && parsed.bundleId && parsed.bundleId !== app.bundle_id) {
      return { status: 400, error: `Notification is for ${parsed.bundleId}, this URL belongs to ${app.bundle_id}` };
    }
    if (app.apple_app_id && parsed.appAppleId && String(parsed.appAppleId) !== app.apple_app_id) {
      return { status: 400, error: "Notification is for another App Store app id" };
    }
    parsed.event.r2Key = await storeRaw(env, app, parsed.event.uid, args.signedPayload);
    const result = await applyAppleEventsLocal(db, { appId: app.id, events: [parsed.event] });
    const forward = { appId: app.id, forwardUrl: app.forward_url ?? null };
    if (result.events[0]?.duplicate) return { status: 200, type: parsed.event.type, duplicate: true, ...forward };
    if (app.notification_url_status !== "revflare") {
      await db.prepare("UPDATE apps SET notification_url_status = 'revflare' WHERE id = ?").bind(app.id).run();
    }
    if (parsed.event.transaction) await rebuildQueued(db, app.id);
    await notifyEvents(env, db, app, [parsed.event], result).catch((err) => console.error("push failed", err));
    // A refund request (also when forwarded: the other server may not answer): queue the answer (worker/lib/refunds.ts).
    const consumption =
      parsed.event.type === "CONSUMPTION_REQUEST"
        ? await queueConsumptionRequest(db, app, parsed.event, parsed.payload.data?.consumptionRequestReason ?? null)
        : null;
    return { status: 200, type: parsed.event.type, ...forward, ...(consumption === "queued" ? { consumptionRequest: true } : {}) };
  },
);

interface HistoryCursor {
  start: number;
  end: number;
  token?: string;
}

/**
 * Pulls Notification History for one app: the last 180 days on the first run, then everything since the last sync.
 * At most `maxRequests` Apple calls per invocation; the pagination cursor is kept between calls.
 */
export const syncNotificationHistory = defineDbFunction(
  "syncNotificationHistory",
  async (db, args: { appId: string; maxRequests?: number; background?: boolean }, env): Promise<{ processed: number; requests: number; done: boolean; error?: string; unavailable?: boolean; budget?: boolean }> => {
    if (args.background && !(await backgroundAllowed(db, env))) return { processed: 0, requests: 0, done: false, budget: true };
    return metered(db, () => notificationHistoryRound(db, args, env));
  },
);

async function notificationHistoryRound(db: Db, args: { appId: string; maxRequests?: number }, env: Env): Promise<{ processed: number; requests: number; done: boolean; error?: string; unavailable?: boolean }> {
  {
    const app = await db.prepare(`SELECT ${APP_COLUMNS} FROM apps WHERE id = ?`).bind(args.appId).first<AppRow>();
    if (!app?.bundle_id) return { processed: 0, requests: 0, done: true, error: "App has no bundle id" };
    const cred = await getCredential(env, db, app.workspace_id, "appstore_iap");
    if (!cred) return { processed: 0, requests: 0, done: true, error: "No In-App Purchase key in this workspace" };
    const api = new AppStoreServerApi(cred, app.bundle_id, "Production");
    const cursorKey = `history_cursor:${app.id}`;
    const stored = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(cursorKey).first<{ value: string }>();
    const t = now();
    const cursor: HistoryCursor = stored
      ? parseJson<HistoryCursor>(stored.value, { start: t - 179 * DAY, end: t })
      : { start: Math.max(t - 179 * DAY, (app.history_synced_until ?? 0) - 60 * 60_000), end: t };
    let requests = 0;
    let processed = 0;
    const max = args.maxRequests ?? 20;
    try {
      while (requests < max) {
        const page = await api.notificationHistory(cursor.start, cursor.end, cursor.token);
        requests++;
        const events: AppleEvent[] = [];
        const refundRequests: Array<{ event: AppleEvent; reason: string | null }> = [];
        for (const item of page.notificationHistory ?? []) {
          try {
            const { event, bundleId, payload } = await eventFromSignedPayload(env, item.signedPayload, "history");
            if (bundleId && bundleId !== app.bundle_id) continue;
            events.push(event);
            if (event.type === "CONSUMPTION_REQUEST") refundRequests.push({ event, reason: payload.data?.consumptionRequestReason ?? null });
          } catch (err) {
            console.warn(JSON.stringify({ event: "history_item_rejected", app: app.id, error: errorMessage(err) }));
          }
        }
        if (events.length) {
          const result = await applyAppleEventsLocal(db, { appId: app.id, events });
          processed += result.events.filter((e) => !e.duplicate).length;
          await notifyEvents(env, db, app, events, result).catch((err) => console.error("push failed", err));
        }
        // Refund requests still inside Apple's window (the other server may not answer them): queued, the cron answers.
        for (const q of refundRequests) await queueConsumptionRequest(db, app, q.event, q.reason);
        if (page.hasMore && page.paginationToken) {
          cursor.token = page.paginationToken;
          continue;
        }
        // Done with this window.
        await db.batch([
          db.prepare("DELETE FROM settings WHERE key = ?").bind(cursorKey),
          db
            .prepare(
              `UPDATE apps SET history_synced_until = ?, last_history_sync_at = ?, store_available = 1,
               history_backfilled_from = COALESCE(history_backfilled_from, ?) WHERE id = ?`,
            )
            .bind(cursor.end, t, dayOf(cursor.start), app.id),
        ]);
        if (processed) await rebuildQueued(db, app.id);
        return { processed, requests, done: true };
      }
      await db
        .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(cursorKey, JSON.stringify(cursor))
        .run();
      return { processed, requests, done: false };
    } catch (err) {
      // Production answers 401 for apps that were never released (the same key works for the others): nothing to
      // sync until the first release; the webhook takes over from then on.
      if (err instanceof AppleApiError && err.status === 401) {
        await db.batch([
          db.prepare("DELETE FROM settings WHERE key = ?").bind(cursorKey),
          db.prepare("UPDATE apps SET last_history_sync_at = ?, store_available = 0 WHERE id = ?").bind(t, app.id),
        ]);
        return { processed, requests, done: true, unavailable: true };
      }
      if (cursor.token || processed) {
        await db
          .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .bind(cursorKey, JSON.stringify(cursor))
          .run();
      }
      await db.prepare("UPDATE apps SET last_history_sync_at = ? WHERE id = ?").bind(t, app.id).run();
      const retry = err instanceof AppleApiError && err.status === 429;
      return { processed, requests, done: false, error: retry ? "rate_limited" : errorMessage(err) };
    }
  }
}

/**
 * Get Transaction History for customers not fetched yet (completes their history beyond the 180 days of notifications,
 * and one-time purchases), then Get All Subscription Statuses for live subscriptions (auto-renew state).
 */
export const syncTransactionHistory = defineDbFunction(
  "syncTransactionHistory",
  async (db, args: { appId: string; maxRequests?: number; background?: boolean }, env): Promise<{ customers: number; transactions: number; requests: number; remaining: number; error?: string; budget?: boolean }> => {
    if (args.background && !(await backgroundAllowed(db, env))) return { customers: 0, transactions: 0, requests: 0, remaining: await countPending(db, args.appId), budget: true };
    return metered(db, () => transactionHistoryRound(db, args, env));
  },
);

async function transactionHistoryRound(db: Db, args: { appId: string; maxRequests?: number }, env: Env): Promise<{ customers: number; transactions: number; requests: number; remaining: number; error?: string }> {
  {
    const app = await db.prepare(`SELECT ${APP_COLUMNS} FROM apps WHERE id = ?`).bind(args.appId).first<AppRow>();
    if (!app?.bundle_id) return { customers: 0, transactions: 0, requests: 0, remaining: 0, error: "App has no bundle id" };
    const cred = await getCredential(env, db, app.workspace_id, "appstore_iap");
    if (!cred) return { customers: 0, transactions: 0, requests: 0, remaining: 0, error: "No In-App Purchase key in this workspace" };
    const api = new AppStoreServerApi(cred, app.bundle_id, "Production");
    const max = args.maxRequests ?? 20;
    // The queue is filled by the ledger (subscriptions seen mid-life) and the RevenueCat discovery.
    const { results: pending } = await db
      .prepare("SELECT transaction_id AS otid FROM pending_history WHERE app_id = ? ORDER BY created_at LIMIT ?")
      .bind(app.id, max)
      .all<{ otid: string }>();
    let requests = 0;
    let transactions = 0;
    let customers = 0;
    const roots = trustedRoots(env);
    try {
      for (const { otid } of pending) {
        if (requests >= max) break;
        let revision: string | undefined;
        const events: AppleEvent[] = [];
        const known = await db.prepare("SELECT 1 AS x FROM apple_history_state WHERE app_id = ? AND original_transaction_id = ? AND revision IS NOT NULL").bind(app.id, otid).first();
        if (known) {
          await db.prepare("DELETE FROM pending_history WHERE app_id = ? AND transaction_id = ?").bind(app.id, otid).run();
          continue;
        }
        for (;;) {
          let page;
          try {
            page = await api.transactionHistory(otid, revision);
          } catch (err) {
            // Unknown or foreign transaction ids (e.g. sandbox ids from an import): skip them for good.
            if (err instanceof AppleApiError && (err.status === 404 || err.status === 400)) {
              requests++;
              break;
            }
            throw err;
          }
          requests++;
          for (const jws of page.signedTransactions ?? []) {
            const tx = await verifyAppleJws<TransactionInfo>(jws, { roots });
            events.push({ uid: `tx:${tx.transactionId}`, source: "api", type: "TRANSACTION_HISTORY", subtype: null, environment: tx.environment, signedAt: tx.signedDate, transaction: tx, renewal: null, r2Key: null });
          }
          revision = page.revision;
          if (!page.hasMore || requests >= max) break;
        }
        if (events.length) {
          await applyAppleEventsLocal(db, { appId: app.id, events });
          transactions += events.length;
        }
        // Every original transaction id the history returned belongs to the same customer: mark them all done.
        const otids = new Set([otid, ...events.map((e) => String(e.transaction!.originalTransactionId))]);
        await db.batch([
          ...[...otids].map((o) => db.prepare("DELETE FROM pending_history WHERE app_id = ? AND transaction_id = ?").bind(app.id, o)),
          ...[...otids].map((o) =>
            db
              .prepare(
                `INSERT INTO apple_history_state (app_id, original_transaction_id, revision, fetched_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT(app_id, original_transaction_id) DO UPDATE SET revision = excluded.revision, fetched_at = excluded.fetched_at`,
              )
              .bind(app.id, o, revision ?? "done", now()),
          ),
        ]);
        customers++;
      }
      // Live subscriptions: current status and renewal info (auto-renew on/off, billing retry...).
      const { results: live } = await db
        .prepare(
          `SELECT s.original_transaction_id AS otid FROM subscriptions s
           LEFT JOIN apple_history_state h ON h.app_id = s.app_id AND h.original_transaction_id = s.original_transaction_id
           WHERE s.app_id = ? AND s.environment = 'Production' AND s.status IN ('active', 'trial', 'grace', 'billing_retry')
             AND (h.status_checked_at IS NULL OR h.status_checked_at < ?) LIMIT ?`,
        )
        .bind(app.id, now() - 7 * DAY, Math.max(0, max - requests))
        .all<{ otid: string }>();
      for (const { otid } of live) {
        if (requests >= max) break;
        const res = await api.subscriptionStatuses(otid);
        requests++;
        const events: AppleEvent[] = [];
        for (const group of res.data ?? []) {
          for (const last of group.lastTransactions ?? []) {
            const tx = await verifyAppleJws<TransactionInfo>(last.signedTransactionInfo, { roots });
            const renewal = last.signedRenewalInfo ? await verifyAppleJws<RenewalInfo>(last.signedRenewalInfo, { roots }) : null;
            events.push({ uid: `status:${tx.transactionId}`, source: "api", type: "SUBSCRIPTION_STATUS", subtype: null, environment: tx.environment, signedAt: Math.max(tx.signedDate, renewal?.signedDate ?? 0), transaction: tx, renewal, status: last.status, r2Key: null });
          }
        }
        if (events.length) await applyAppleEventsLocal(db, { appId: app.id, events });
        await db
          .prepare(
            `INSERT INTO apple_history_state (app_id, original_transaction_id, status_checked_at, fetched_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(app_id, original_transaction_id) DO UPDATE SET status_checked_at = excluded.status_checked_at`,
          )
          .bind(app.id, otid, now(), now())
          .run();
      }
    } catch (err) {
      const remaining = await countPending(db, app.id);
      if (transactions) await rebuildQueued(db, app.id);
      const retry = err instanceof AppleApiError && err.status === 429;
      return { customers, transactions, requests, remaining, error: retry ? "rate_limited" : errorMessage(err) };
    }
    if (transactions) await rebuildQueued(db, app.id);
    return { customers, transactions, requests, remaining: await countPending(db, app.id) };
  }
}

async function countPending(db: Db, appId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM pending_history WHERE app_id = ?").bind(appId).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Asks Apple to send a TEST notification to the app's configured URL (sandbox or production). */
export const requestTestNotification = defineDbFunction(
  "requestTestNotification",
  async (db, args: { appId: string; environment: "Production" | "Sandbox" }, env): Promise<{ token?: string; error?: string }> => {
    const app = await db.prepare(`SELECT ${APP_COLUMNS} FROM apps WHERE id = ?`).bind(args.appId).first<AppRow>();
    if (!app?.bundle_id) return { error: "App has no bundle id" };
    const cred = await getCredential(env, db, app.workspace_id, "appstore_iap");
    if (!cred) return { error: "No In-App Purchase key in this workspace" };
    try {
      const r = await new AppStoreServerApi(cred, app.bundle_id, args.environment).requestTestNotification();
      return { token: r.testNotificationToken };
    } catch (err) {
      return { error: errorMessage(err) };
    }
  },
);
