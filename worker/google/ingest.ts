// Google Play → ledger. Real-time developer notifications (RTDN, Pub/Sub push) only say that a purchase changed: each
// one is completed with the Play Developer API (subscriptionsv2 / productsv2 for the state, the Orders API for prices,
// taxes, proceeds and refunds) and mapped onto the same transactions / subscriptions / customers as Apple's sales.
// Everything here runs inside the database object (one call per notification). See docs/google-play.md.
//
// Mapping: transaction_id = Play order id (renewals "GPA.1234-5678-9012-34567..N"), original_transaction_id = the base
// order id (without "..N"), product_id = "<subscription id>:<base plan id>" for subscriptions (one-time products: the
// product id), store = play_store, source = google_play, environment Sandbox for test purchases (license testers).

import { getCredential } from "../lib/credentials";
import { defineDbFunction, type Db } from "../lib/db";
import { backgroundAllowed, metered } from "../lib/budget";
import { applyPlayEventLocal, playEventSeen, type PlayEvent, type PlayLedgerResult, type PlaySubscriptionState, type TxInput } from "../lib/ledger";
import { raiseAlert } from "../lib/alert-store";
import { adsPushLabel, purchaseAttribution } from "../lib/ads-names";
import { countryLabel, formatMoney, pushLiveUpdates, pushToWorkspace, PUSH_VERSION_ADS, type PushMessage } from "../lib/push";
import { rebuildQueued } from "../lib/rollup";
import { FxCache, dayOf, periodFromDuration } from "../lib/money";
import { baseUrl } from "../lib/settings";
import { errorMessage, fromBase64url, now, parseJson } from "../lib/util";
import { productName } from "../apple/ingest";
import { GooglePlayApi, GooglePlayApiError } from "./api";
import { forgetGoogleTokens, GoogleAuthError, type ServiceAccount } from "./auth";
import { OidcError, verifyPushToken } from "./oidc";
import {
  ONE_TIME_NOTIFICATION_TYPES,
  SUBSCRIPTION_NOTIFICATION_TYPES,
  type DeveloperNotification,
  type Money,
  type Order,
  type ProductPurchaseV2,
  type SubscriptionPurchaseV2,
} from "./types";

const DAY = 86_400_000;

/** Play order ids: "GPA.1234-5678-9012-34567" (+ "..N" for the N+1-th renewal). */
export const ORDER_ID_RE = /^GPA\.\d{4}-\d{4}-\d{4}-\d{5}(\.\.\d+)?$/;
export const BASE_ORDER_ID_RE = /^GPA\.\d{4}-\d{4}-\d{4}-\d{5}$/;
/** At most this many earlier orders of a subscription are fetched to fill gaps (renewals missed before setup). */
const CHAIN_BACKFILL = 12;

export const baseOrderId = (orderId: string) => orderId.replace(/\.\.\d+$/, "");
const renewalIndex = (orderId: string): number | null => {
  const m = /\.\.(\d+)$/.exec(orderId);
  return m ? Number(m[1]) : null;
};

export interface PlayAppRow {
  id: string;
  workspace_id: string;
  name: string;
  platform: string;
  bundle_id: string | null;
  notification_key: string;
  google_push_account: string | null;
  google_credential_id: string | null;
  google_check?: string | null;
}

const APP_COLUMNS = "id, workspace_id, name, platform, bundle_id, notification_key, google_push_account, google_credential_id, google_check";

export function rtdnUrl(base: string, key: string): string {
  return `${base}/google/rtdn/${key}`;
}

// Service accounts per app, kept 5 minutes in the database object's memory: a notification reads no credential row.
const accounts = new Map<string, { sa: ServiceAccount; until: number }>();

/** Forgets cached service accounts (a key was added, replaced or deleted). */
export function forgetPlayAccounts() {
  accounts.clear();
}

/**
 * Forgets the cached service accounts and access tokens where they live: in the database object (every Play API call
 * runs there). One RPC without any row read; called when a google_play key is added, replaced or deleted.
 */
export const forgetPlayCaches = defineDbFunction("forgetPlayCaches", async (): Promise<{ ok: true }> => {
  forgetPlayAccounts();
  forgetGoogleTokens();
  return { ok: true };
});

/** The app's service account (its own credential, else the workspace's newest google_play key). */
export async function playServiceAccount(env: Env, db: Db, app: Pick<PlayAppRow, "workspace_id" | "google_credential_id"> & { id?: string }): Promise<ServiceAccount | null> {
  const cacheKey = `${app.id ?? ""}|${app.workspace_id}|${app.google_credential_id ?? ""}`;
  const hit = accounts.get(cacheKey);
  if (hit && hit.until > Date.now()) return hit.sa;
  const sa = await loadServiceAccount(env, db, app);
  if (sa) accounts.set(cacheKey, { sa, until: Date.now() + 5 * 60_000 });
  return sa;
}

async function loadServiceAccount(env: Env, db: Db, app: Pick<PlayAppRow, "workspace_id" | "google_credential_id">): Promise<ServiceAccount | null> {
  const cred =
    (app.google_credential_id ? await getCredential(env, db, app.workspace_id, "google_play", app.google_credential_id) : null) ??
    (await getCredential(env, db, app.workspace_id, "google_play"));
  if (!cred?.secret.privateKey) return null;
  const clientEmail = typeof cred.config.clientEmail === "string" ? cred.config.clientEmail : cred.issuerId;
  if (!clientEmail) return null;
  return { clientEmail, privateKey: cred.secret.privateKey, privateKeyId: cred.keyId, projectId: typeof cred.config.projectId === "string" ? cred.config.projectId : null };
}

// --- Mapping -----------------------------------------------------------------------------------------------------------

const ms = (t: string | number | null | undefined): number | null => {
  if (t === undefined || t === null || t === "") return null;
  const v = typeof t === "number" ? t : /^\d+$/.test(t) ? Number(t) : Date.parse(t);
  return Number.isFinite(v) ? v : null;
};

/** Money → thousandths of the currency unit. */
export function moneyMilli(m: Money | null | undefined): number {
  if (!m) return 0;
  const units = Number(m.units ?? 0);
  return Math.round((Number.isFinite(units) ? units : 0) * 1000 + (m.nanos ?? 0) / 1_000_000);
}

const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** What the order's purchase says about it (environment, linked install, product). */
export interface PurchaseContext {
  environment: string;
  /** obfuscatedExternalAccountId when it is a RevflareKit install id (UUID). */
  installId: string | null;
  regionCode: string | null;
  /** auto_renewable (subscriptionsv2) or a one-time product. */
  subscription: boolean;
  /** Subscription id (subscriptions) or product id. */
  productId: string;
  basePlanId: string | null;
}

/** Refund of an order: when, and the refunded share (milliunits) for partial refunds (null = full). */
export function orderRefund(order: Order): { refundedAt: number; refundMilli: number | null } | null {
  const h = order.orderHistory ?? {};
  const fallback = ms(order.lastEventTime) ?? now();
  if (order.state === "REFUNDED") return { refundedAt: ms(h.refundEvent?.eventTime) ?? fallback, refundMilli: null };
  if (order.state === "PARTIALLY_REFUNDED" || (h.partialRefundEvents?.length && order.state !== "PENDING")) {
    const events = (h.partialRefundEvents ?? []).filter((e) => e.state !== "PENDING");
    if (!events.length) return null;
    const total = moneyMilli(order.total);
    const refunded = events.reduce((s, e) => s + moneyMilli(e.refundDetails?.total), 0);
    const at = Math.max(...events.map((e) => ms(e.processTime) ?? ms(e.createTime) ?? fallback));
    if (!total || refunded >= total) return { refundedAt: at, refundMilli: null };
    const share = Math.round((refunded / total) * 100_000);
    return share > 0 ? { refundedAt: at, refundMilli: share } : null;
  }
  return null;
}

/** One Play order → a ledger transaction. Proceeds: developerRevenueInBuyerCurrency converted at the purchase day's rate. */
export async function txFromOrder(order: Order, ctx: PurchaseContext, fx: FxCache, signedAt: number): Promise<TxInput> {
  const line = order.lineItems?.[0];
  const sd = line?.subscriptionDetails;
  const start = ms(sd?.servicePeriodStartTime) ?? ms(order.createTime) ?? signedAt;
  const end = ms(sd?.servicePeriodEndTime);
  const phase = sd?.offerPhaseDetails;
  const total = order.total ?? line?.total;
  // The order's total covers every unit (multi-quantity one-time purchases): the ledger stores the unit price and
  // multiplies by the quantity; proceeds (developerRevenueInBuyerCurrency) are already the whole order's.
  const quantity = ctx.subscription ? 1 : Math.max(1, Math.floor(Number(line?.oneTimePurchaseDetails?.quantity ?? 1)) || 1);
  const priceMilli = Math.round(moneyMilli(total) / quantity);
  // Free trial phase (or a free subscription order that names no phase).
  const isTrial = !!phase?.freeTrialDetails || sd?.offerPhase === "FREE_TRIAL" || (ctx.subscription && priceMilli === 0 && !phase && !sd?.offerPhase);
  const intro = !isTrial && (!!phase?.introductoryPriceDetails || sd?.offerPhase === "INTRODUCTORY");
  const productId = ctx.subscription ? `${line?.productId ?? ctx.productId}${sd?.basePlanId || ctx.basePlanId ? `:${sd?.basePlanId || ctx.basePlanId}` : ""}` : (line?.productId ?? ctx.productId);
  const currency = total?.currencyCode ?? null;
  const day = dayOf(start);
  const revenue = order.developerRevenueInBuyerCurrency;
  const proceedsUsd = revenue && (revenue.units !== undefined || revenue.nanos !== undefined) ? await fx.toUsd(moneyMilli(revenue) / 1000, revenue.currencyCode ?? currency, day) : null;
  const refund = orderRefund(order);
  const orderId = order.orderId;
  return {
    source: "google_play",
    store: "play_store",
    environment: ctx.environment,
    transactionId: orderId,
    originalTransactionId: ctx.subscription ? baseOrderId(orderId) : orderId,
    productId,
    productType: ctx.subscription ? "auto_renewable" : "consumable",
    subscriptionGroup: ctx.subscription ? (line?.productId ?? ctx.productId) : null,
    purchasedAt: start,
    originalPurchasedAt: null,
    expiresAt: ctx.subscription ? end : null,
    offerType: isTrial || intro ? 1 : null,
    offerId: sd?.offerId ?? line?.oneTimePurchaseDetails?.offerId ?? null,
    offerDiscountType: isTrial ? "FREE_TRIAL" : intro ? "PAY_AS_YOU_GO" : null,
    offerPeriod: (isTrial || intro) && end ? periodFromDuration(end - start, ctx.environment) : null,
    isTrial,
    reason: ctx.subscription && renewalIndex(orderId) !== null ? "RENEWAL" : "PURCHASE",
    priceMilli: isTrial ? 0 : priceMilli,
    currency,
    country: (order.buyerAddress?.buyerCountry ?? ctx.regionCode ?? "").toUpperCase() || null,
    quantity,
    refundedAt: refund?.refundedAt ?? null,
    refundMilli: refund?.refundMilli ?? null,
    appAccountToken: ctx.installId,
    proceedsUsd: isTrial ? null : proceedsUsd,
    signedAt: Math.max(ms(order.lastEventTime) ?? 0, ms(order.createTime) ?? 0) || signedAt,
  };
}

/**
 * A transaction from the subscription alone (Orders API unavailable): recurring price (before tax), estimated proceeds.
 * Only free trials are free. An introductory price is not in subscriptionsv2 (its offer phase names no amount): the
 * recurring price stands in for it, an estimate like the proceeds (proceeds_reported = 0) until the Orders API works.
 */
function txFromSubscription(sub: SubscriptionPurchaseV2, ctx: PurchaseContext, orderId: string, signedAt: number): TxInput {
  const line = sub.lineItems?.[0];
  const isTrial = !!line?.offerPhase?.freeTrial;
  const intro = !!line?.offerPhase?.introductoryPrice;
  const expiresAt = ms(line?.expiryTime);
  const index = renewalIndex(orderId);
  const start = index === null ? (ms(sub.startTime) ?? signedAt) : Math.min(signedAt, expiresAt ?? signedAt);
  const price = line?.autoRenewingPlan?.recurringPrice;
  return {
    source: "google_play",
    store: "play_store",
    environment: ctx.environment,
    transactionId: orderId,
    originalTransactionId: baseOrderId(orderId),
    productId: `${ctx.productId}${ctx.basePlanId ? `:${ctx.basePlanId}` : ""}`,
    productType: "auto_renewable",
    subscriptionGroup: ctx.productId,
    purchasedAt: start,
    expiresAt,
    offerType: isTrial || intro ? 1 : null,
    offerId: line?.offerDetails?.offerId ?? null,
    offerDiscountType: isTrial ? "FREE_TRIAL" : intro ? "PAY_AS_YOU_GO" : null,
    isTrial,
    reason: index === null ? "PURCHASE" : "RENEWAL",
    priceMilli: isTrial ? 0 : moneyMilli(price),
    currency: price?.currencyCode ?? null,
    country: sub.regionCode?.toUpperCase() ?? null,
    quantity: 1,
    appAccountToken: ctx.installId,
    signedAt,
  };
}

/** Subscription state (subscriptionsv2) → the ledger's. Null for pending purchases (nothing is stored). */
export async function playState(sub: SubscriptionPurchaseV2, purchaseToken: string, notificationType: number | null, fx: FxCache): Promise<PlaySubscriptionState | null> {
  const line = sub.lineItems?.[0];
  const expiresAt = ms(line?.expiryTime);
  const t = now();
  const c = sub.canceledStateContext;
  const cancelReason = c?.userInitiatedCancellation
    ? `user${c.userInitiatedCancellation.cancelSurveyResult?.reason ? `:${c.userInitiatedCancellation.cancelSurveyResult.reason.replace(/^CANCEL_SURVEY_REASON_/, "")}` : ""}`
    : c?.systemInitiatedCancellation
      ? "system"
      : c?.developerInitiatedCancellation
        ? "developer"
        : c?.replacementCancellation
          ? "replacement"
          : null;
  const reasonCode = cancelReason === null ? null : cancelReason.startsWith("user") ? 1 : cancelReason === "system" ? 2 : 5;
  const autoRenewEnabled = line?.autoRenewingPlan ? line.autoRenewingPlan.autoRenewEnabled !== false : false;
  let status: PlaySubscriptionState["status"];
  let autoRenew = autoRenewEnabled;
  switch (sub.subscriptionState) {
    case "SUBSCRIPTION_STATE_PENDING":
    case "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED":
      return null;
    case "SUBSCRIPTION_STATE_ACTIVE":
      status = "active";
      break;
    case "SUBSCRIPTION_STATE_CANCELED":
      status = expiresAt !== null && expiresAt <= t ? "expired" : "active";
      autoRenew = false;
      break;
    case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD":
      status = "grace";
      break;
    case "SUBSCRIPTION_STATE_ON_HOLD":
      status = "billing_retry";
      break;
    case "SUBSCRIPTION_STATE_PAUSED":
      // Paused: no access and no MRR, resumes by itself.
      status = "expired";
      autoRenew = true;
      break;
    default:
      status = "expired";
      autoRenew = false;
  }
  if (notificationType === 12) {
    status = "refunded";
    autoRenew = false;
  }
  const price = line?.autoRenewingPlan?.recurringPrice;
  const renewalPriceUsd = price && autoRenew ? await fx.toUsd(moneyMilli(price) / 1000, price.currencyCode, dayOf(t)) : null;
  return {
    status,
    autoRenew,
    expirationReason: status === "expired" || !autoRenew ? (reasonCode ?? (status === "expired" && sub.subscriptionState !== "SUBSCRIPTION_STATE_PAUSED" ? 5 : null)) : null,
    cancelReason,
    purchaseToken,
    renewalPriceUsd,
    expiresAt,
  };
}

/** Earlier orders of the chain ending with `orderId` that are not stored yet (at most CHAIN_BACKFILL, oldest first). */
async function missingChain(db: Db, appId: string, orderId: string): Promise<string[]> {
  const n = renewalIndex(orderId);
  if (n === null) return [];
  const base = baseOrderId(orderId);
  const chain = [base, ...Array.from({ length: n }, (_, i) => `${base}..${i}`)].slice(-CHAIN_BACKFILL);
  const { results } = await db
    .prepare(`SELECT transaction_id FROM transactions WHERE app_id = ? AND transaction_id IN (${chain.map(() => "?").join(",")})`)
    .bind(appId, ...chain)
    .all<{ transaction_id: string }>();
  const have = new Set(results.map((r) => r.transaction_id));
  return chain.filter((id) => !have.has(id));
}

/** Fetches orders; a batch failing (one id unknown, e.g. a gap Play never billed) falls back to the ones that matter. */
async function fetchOrders(api: GooglePlayApi, ids: string[], required: string[]): Promise<Map<string, Order>> {
  const out = new Map<string, Order>();
  try {
    for (const o of await api.orders(ids)) out.set(o.orderId, o);
  } catch (err) {
    if (!(err instanceof GooglePlayApiError) || (err.status !== 404 && err.status !== 400) || ids.length === required.length) throw err;
    for (const o of await api.orders(required)) out.set(o.orderId, o);
  }
  return out;
}

// --- RTDN ----------------------------------------------------------------------------------------------------------------

interface PushBody {
  message?: { data?: string; messageId?: string; message_id?: string; publishTime?: string; attributes?: Record<string, string> };
  subscription?: string;
}

export interface RtdnResult {
  status: number;
  error?: string;
  type?: string;
  duplicate?: boolean;
  ignored?: string;
}

async function storeRaw(env: Env, appId: string, uid: string, value: unknown): Promise<string | null> {
  const t = new Date();
  const key = `raw/google/${appId}/${t.getUTCFullYear()}/${String(t.getUTCMonth() + 1).padStart(2, "0")}/${uid.replace(/[^A-Za-z0-9._:-]/g, "_")}.json`;
  try {
    await env.RAW.put(key, JSON.stringify({ ...(value as object), receivedAt: t.toISOString() }), { httpMetadata: { contentType: "application/json" } });
    return key;
  } catch (err) {
    console.error("raw notification not stored", err);
    return null;
  }
}

/** Records the outcome of a Play API call; a steady "ok" is not rewritten (one row write less per notification). */
async function setCheck(db: Db, appId: string, check: { ok: boolean; error?: string }, previous?: string | null) {
  if (previous !== undefined && check.ok && parseCheck(previous ?? null)?.ok) return;
  await db.prepare("UPDATE apps SET google_check = ? WHERE id = ?").bind(JSON.stringify({ at: now(), ...check }), appId).run();
}

/** POST /google/rtdn/:key: one Pub/Sub push (verified, deduplicated on messageId, completed through the Play API). */
export const ingestRtdn = defineDbFunction(
  "ingestRtdn",
  async (db, args: { key: string; body: string; authorization: string | null; requestUrl: string }, env): Promise<RtdnResult> => {
    const app = await db.prepare(`SELECT ${APP_COLUMNS} FROM apps WHERE notification_key = ? AND platform = 'android'`).bind(args.key).first<PlayAppRow>();
    if (!app) return { status: 404, error: "Unknown notification URL" };
    if (app.google_push_account) {
      const url = new URL(args.requestUrl);
      const audiences = [`${url.origin}${url.pathname}`];
      try {
        audiences.push(rtdnUrl(await baseUrl(env, db, args.requestUrl), app.notification_key));
      } catch {}
      try {
        await verifyPushToken(args.authorization, { audiences, email: app.google_push_account });
      } catch (err) {
        if (err instanceof OidcError) return { status: 401, error: `Push authentication failed: ${err.message}` };
        throw err;
      }
    }
    let push: PushBody;
    let note: DeveloperNotification;
    try {
      push = JSON.parse(args.body) as PushBody;
      note = JSON.parse(new TextDecoder().decode(fromBase64url((push.message?.data ?? "").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")))) as DeveloperNotification;
    } catch {
      // Acknowledged (Pub/Sub would retry a 4xx for 7 days and the body will never parse): logged.
      console.warn(JSON.stringify({ event: "google_rtdn_malformed", app: app.id, body: args.body.slice(0, 500) }));
      return { status: 200, ignored: "malformed push body" };
    }
    const messageId = push.message?.messageId ?? push.message?.message_id;
    if (!messageId || typeof note !== "object" || !note) {
      console.warn(JSON.stringify({ event: "google_rtdn_malformed", app: app.id, body: args.body.slice(0, 500) }));
      return { status: 200, ignored: "malformed push body" };
    }
    if (app.bundle_id && note.packageName && note.packageName !== app.bundle_id) {
      // Another app's topic pushes here (a misconfigured subscription): acknowledged so Pub/Sub stops retrying, logged
      // and shown as an alert (once a day).
      const error = `Notification is for ${note.packageName}, this URL belongs to ${app.bundle_id}`;
      console.warn(JSON.stringify({ event: "google_rtdn_wrong_package", app: app.id, messageId, packageName: note.packageName }));
      await raiseAlert(env, db, {
        workspaceId: app.workspace_id,
        appId: app.id,
        key: `google_play_package:${app.id}:${dayOf(now())}`,
        kind: "google_play_package",
        severity: "warning",
        title: `Google Play notifications for another app reach ${app.name}`,
        body: `${error}. Point ${note.packageName}'s Pub/Sub push subscription at its own app's notification URL in Revflare.`,
      }).catch((err) => console.error("package alert failed", err));
      return { status: 200, ignored: error };
    }
    const uid = `gp:${messageId}`;
    if (await playEventSeen(db, app.id, uid)) return { status: 200, duplicate: true };
    const signedAt = ms(note.eventTimeMillis) ?? now();

    // Test notification (Play Console → Monetization setup → Send test notification): proves the setup works.
    if (note.testNotification) {
      const r2Key = await storeRaw(env, app.id, uid, { message: push.message, notification: note });
      await applyPlayEventLocal(db, { appId: app.id, seenChecked: true, event: { uid, source: "webhook", type: "TEST", subtype: null, environment: "Sandbox", signedAt, r2Key, transactions: [], play: null } });
      await setCheck(db, app.id, { ok: true }, app.google_check);
      await raiseAlert(env, db, {
        workspaceId: app.workspace_id,
        appId: app.id,
        key: `google_play_test:${app.id}:${messageId}`,
        kind: "google_play_test",
        severity: "info",
        title: "Google Play test notification received",
        body: `${app.name}: real-time developer notifications reach Revflare.`,
        push: { kind: "test", titleKey: "PUSH_TITLE_TEST", titleArgs: [app.name], bodyKey: "PUSH_BODY_TEST", bodyArgs: ["(Google Play)"] },
      }).catch((err) => console.error("test alert failed", err));
      return { status: 200, type: "TEST" };
    }
    if (note.pendingRefundReviewNotification) {
      console.log(JSON.stringify({ event: "google_pending_refund_review", app: app.id, messageId }));
      return { status: 200, ignored: "pending refund review" };
    }
    if (!note.subscriptionNotification && !note.oneTimeProductNotification && !note.voidedPurchaseNotification) return { status: 200, ignored: "unknown notification" };

    const sa = await playServiceAccount(env, db, app);
    // Not set up yet: Pub/Sub retries for days, so nothing is lost while the key is added.
    if (!sa || !app.bundle_id) return { status: 503, error: "No Google Play service account for this app yet" };
    const api = new GooglePlayApi(sa, app.bundle_id);
    let built: { event: PlayEvent; raw: Record<string, unknown> } | { ignored: string };
    try {
      built = await buildEvent(db, api, note, { uid, signedAt, appId: app.id });
    } catch (err) {
      // Unknown purchase tokens / orders (e.g. a purchase of another app): acknowledged, logged.
      if (err instanceof GooglePlayApiError && (err.status === 404 || err.status === 410 || err.status === 400)) {
        console.warn(JSON.stringify({ event: "google_rtdn_unknown", app: app.id, messageId, error: err.message }));
        return { status: 200, ignored: err.message };
      }
      // Key or permission problems (shown on the app's Google Play page) and Google outages: Pub/Sub retries.
      if (err instanceof GooglePlayApiError || err instanceof GoogleAuthError) {
        await setCheck(db, app.id, { ok: false, error: err.message });
        return { status: 503, error: err.message };
      }
      throw err;
    }
    if ("ignored" in built) return { status: 200, ignored: built.ignored };
    built.event.r2Key = await storeRaw(env, app.id, uid, { message: push.message, notification: note, ...built.raw });
    const result = await applyPlayEventLocal(db, { appId: app.id, event: built.event, seenChecked: true });
    if (result.duplicate) return { status: 200, duplicate: true, type: built.event.type };
    await setCheck(db, app.id, { ok: true }, app.google_check);
    if (built.event.transactions.length) await rebuildQueued(db, app.id);
    await nameProducts(db, app.id, (built.raw.orders as Order[] | undefined) ?? []).catch(() => {});
    await notifyPlay(env, db, app, built.event, result).catch((err) => console.error("push failed", err));
    return { status: 200, type: built.event.type };
  },
);

/** Fetches what a notification is about and builds the ledger event (or says why nothing is stored). */
async function buildEvent(db: Db, api: GooglePlayApi, note: DeveloperNotification, meta: { uid: string; signedAt: number; appId: string }): Promise<{ event: PlayEvent; raw: Record<string, unknown> } | { ignored: string }> {
  const fx = new FxCache(db);
  const base = { uid: meta.uid, source: "webhook" as const, signedAt: meta.signedAt, r2Key: null };
  if (note.subscriptionNotification) {
    const n = note.subscriptionNotification;
    const type = SUBSCRIPTION_NOTIFICATION_TYPES[n.notificationType] ?? `SUBSCRIPTION_${n.notificationType}`;
    const sub = await api.subscription(n.purchaseToken);
    const line = sub.lineItems?.find((l) => !n.subscriptionId || l.productId === n.subscriptionId) ?? sub.lineItems?.[0];
    const play = await playState(sub, n.purchaseToken, n.notificationType, fx);
    if (!play || !line) return { ignored: "pending purchase" };
    const orderId = line.latestSuccessfulOrderId ?? sub.latestOrderId;
    if (!orderId) return { ignored: "no order yet" };
    const ctx: PurchaseContext = {
      environment: sub.testPurchase ? "Sandbox" : "Production",
      installId: isUuid(sub.externalAccountIdentifiers?.obfuscatedExternalAccountId) ? sub.externalAccountIdentifiers!.obfuscatedExternalAccountId!.toLowerCase() : null,
      regionCode: sub.regionCode ?? null,
      subscription: true,
      productId: line.productId,
      basePlanId: line.offerDetails?.basePlanId ?? null,
    };
    const missing = await missingChain(db, meta.appId, orderId);
    let orders: Map<string, Order> | null = null;
    try {
      orders = await fetchOrders(api, [...missing, orderId], [orderId]);
    } catch (err) {
      // Without the Orders API (permission "View financial data" missing): prices from the subscription, estimated proceeds.
      if (!(err instanceof GooglePlayApiError) || (err.status !== 403 && err.status !== 401 && err.status !== 404)) throw err;
      console.warn(JSON.stringify({ event: "google_orders_unavailable", app: meta.appId, error: err.message }));
    }
    const transactions: TxInput[] = [];
    const ids = orders ? [...missing, orderId].filter((id) => orders!.has(id)) : [];
    for (const id of ids) transactions.push(await txFromOrder(orders!.get(id)!, ctx, fx, meta.signedAt));
    if (!orders?.has(orderId)) transactions.push(txFromSubscription(sub, ctx, orderId, meta.signedAt));
    const last = transactions[transactions.length - 1];
    // Revoked: refunded now, whatever the order says yet.
    if (n.notificationType === 12 && !last.refundedAt) last.refundedAt = meta.signedAt;
    // The latest order's period ends with the subscription (deferrals, grace).
    if (play.expiresAt && last.expiresAt && play.expiresAt > last.expiresAt && !last.isTrial) last.expiresAt = play.expiresAt;
    // ...and never after it: a subscription replaced by an upgrade / downgrade (or revoked) ends early. A later
    // notification on the replaced token must not stretch its last order back to the full period (double MRR).
    if (play.expiresAt && last.expiresAt && play.expiresAt < last.expiresAt) last.expiresAt = Math.max(play.expiresAt, last.purchasedAt);
    if (sub.canceledStateContext?.replacementCancellation) last.isUpgraded = true;
    return {
      event: { ...base, type, subtype: play.cancelReason, environment: ctx.environment, transactions, play, linkedPurchaseToken: sub.linkedPurchaseToken ?? null },
      raw: { subscription: sub, orders: orders ? [...orders.values()] : [] },
    };
  }
  if (note.oneTimeProductNotification) {
    const n = note.oneTimeProductNotification;
    const type = ONE_TIME_NOTIFICATION_TYPES[n.notificationType] ?? `ONE_TIME_PRODUCT_${n.notificationType}`;
    const product = await api.product(n.purchaseToken);
    const state = product.purchaseStateContext?.purchaseState;
    if (state === "PENDING" || !product.orderId) return { ignored: "pending purchase" };
    const stored = await db.prepare("SELECT 1 AS x FROM transactions WHERE app_id = ? AND transaction_id = ?").bind(meta.appId, product.orderId).first();
    const order = await api.order(product.orderId);
    // Pending payments cancelled before they went through were never paid: nothing to store.
    if (!stored && (state === "CANCELLED" || order.state === "PENDING" || order.state === "CANCELED")) return { ignored: "purchase not completed" };
    const ctx = productContext(product, n.sku ?? null);
    const tx = await txFromOrder(order, ctx, fx, meta.signedAt);
    if (stored && (state === "CANCELLED" || order.state === "CANCELED") && !tx.refundedAt) tx.refundedAt = meta.signedAt;
    return { event: { ...base, type, subtype: state ?? null, environment: ctx.environment, transactions: [tx], play: null }, raw: { product, orders: [order] } };
  }
  const v = note.voidedPurchaseNotification!;
  const subtype = v.refundType === 2 ? "PARTIAL" : "FULL";
  const existing = await db
    .prepare("SELECT environment, app_account_token, product_type FROM transactions WHERE app_id = ? AND transaction_id = ?")
    .bind(meta.appId, v.orderId)
    .first<{ environment: string; app_account_token: string | null; product_type: string | null }>();
  let ctx: PurchaseContext;
  const raw: Record<string, unknown> = {};
  const subscription = existing ? existing.product_type === "auto_renewable" : v.productType === 1;
  if (existing) {
    ctx = { environment: existing.environment, installId: existing.app_account_token, regionCode: null, subscription, productId: "", basePlanId: null };
  } else if (subscription) {
    const sub = await api.subscription(v.purchaseToken);
    raw.subscription = sub;
    const line = sub.lineItems?.[0];
    ctx = {
      environment: sub.testPurchase ? "Sandbox" : "Production",
      installId: isUuid(sub.externalAccountIdentifiers?.obfuscatedExternalAccountId) ? sub.externalAccountIdentifiers!.obfuscatedExternalAccountId!.toLowerCase() : null,
      regionCode: sub.regionCode ?? null,
      subscription: true,
      productId: line?.productId ?? "",
      basePlanId: line?.offerDetails?.basePlanId ?? null,
    };
  } else {
    const product = await api.product(v.purchaseToken);
    raw.product = product;
    ctx = productContext(product, null);
  }
  const order = await api.order(v.orderId);
  raw.orders = [order];
  const tx = await txFromOrder(order, ctx, fx, meta.signedAt);
  // The order may not show the refund yet: a full void refunds it now.
  if (!tx.refundedAt) {
    tx.refundedAt = meta.signedAt;
    tx.refundMilli = null;
  }
  return { event: { ...base, type: "VOIDED_PURCHASE", subtype, environment: ctx.environment, transactions: [tx], play: null }, raw };
}

function productContext(product: ProductPurchaseV2, sku: string | null): PurchaseContext {
  return {
    environment: product.testPurchaseContext?.fopType === "TEST" ? "Sandbox" : "Production",
    installId: isUuid(product.obfuscatedExternalAccountId) ? product.obfuscatedExternalAccountId.toLowerCase() : null,
    regionCode: product.regionCode ?? null,
    subscription: false,
    productId: product.productLineItem?.[0]?.productId ?? sku ?? "",
    basePlanId: null,
  };
}

const namedProducts = new Set<string>();

/** Product titles from the Orders API name products that have no name yet (once per product and isolate). */
export async function nameProducts(db: Db, appId: string, raw: Order[]) {
  for (const o of raw) {
    const line = o.lineItems?.[0];
    if (!line?.productTitle || !line.productId) continue;
    const id = line.subscriptionDetails?.basePlanId ? `${line.productId}:${line.subscriptionDetails.basePlanId}` : line.productId;
    if (namedProducts.has(`${appId}|${id}`)) continue;
    const r = await db.prepare("UPDATE products SET name = ? WHERE app_id = ? AND product_id = ? AND name IS NULL").bind(line.productTitle.replace(/\s*\(.*\)\s*$/, "").slice(0, 120), appId, id).run();
    // Remembered once the product has a name (a product the ledger has not created yet, e.g. during a free trial, is retried).
    if (r.meta.changes || (await db.prepare("SELECT 1 AS x FROM products WHERE app_id = ? AND product_id = ? AND name IS NOT NULL").bind(appId, id).first())) namedProducts.add(`${appId}|${id}`);
  }
}

/** Push notifications for a fresh Play (or Polar) event (sales, trials, renewals, refunds, cancellations). */
export async function notifyPlay(env: Env, db: Db, app: Pick<PlayAppRow, "id" | "workspace_id" | "name">, ev: PlayEvent, result: PlayLedgerResult) {
  if (ev.signedAt < now() - 30 * 60_000) return;
  const ws = await db.prepare("SELECT currency FROM workspaces WHERE id = ?").bind(app.workspace_id).first<{ currency: string }>();
  const currency = ws?.currency ?? "USD";
  const rate = await new FxCache(db).perUsd(currency, dayOf(now()));
  const sandbox = ev.environment !== "Production" ? " (Sandbox)" : "";
  const last = result.transactions[result.transactions.length - 1];
  if (!last) return;
  const lastTx = ev.transactions[ev.transactions.length - 1];
  if (ev.type === "VOIDED_PURCHASE" || ev.type === "SUBSCRIPTION_REVOKED" || ev.type === "order.refunded") {
    const share = lastTx.refundMilli == null ? 1 : lastTx.refundMilli / 100_000;
    const amountUsd = last.grossUsd * share;
    await pushToWorkspace(env, db, app.workspace_id, {
      kind: "refund",
      appId: app.id,
      titleKey: "PUSH_TITLE_REFUND",
      titleArgs: [app.name + sandbox],
      bodyKey: "PUSH_BODY_SALE",
      bodyArgs: [await productName(db, app.id, last.productId), countryLabel(last.country), formatMoney(amountUsd * rate, currency)],
      amountUsd,
      data: { transactionId: last.transactionId },
    });
    return;
  }
  if ((ev.type === "SUBSCRIPTION_CANCELED" || ev.type === "subscription.canceled") && ev.play?.cancelReason?.startsWith("user")) {
    await pushToWorkspace(env, db, app.workspace_id, {
      kind: "cancellation",
      appId: app.id,
      titleKey: "PUSH_TITLE_CANCELLATION",
      titleArgs: [app.name + sandbox],
      bodyKey: "PUSH_BODY_CANCELLATION",
      bodyArgs: [await productName(db, app.id, last.productId), countryLabel(last.country)],
    });
    return;
  }
  let revenue: { appName: string; amountUsd: number; productName: string } | undefined;
  for (const r of result.transactions) {
    if (!r.isNew) continue;
    const tx = ev.transactions.find((t) => t.transactionId === r.transactionId);
    // Gaps filled from older orders never push (the notification's own order does).
    if (!tx || (tx !== lastTx && tx.purchasedAt < now() - 2 * DAY)) continue;
    const kind = r.kind === "one_time" || r.kind === "new" ? "sale" : (r.kind as "renewal" | "trial" | "conversion");
    const titleKey = { one_time: "PUSH_TITLE_PURCHASE", new: "PUSH_TITLE_NEW_SUBSCRIPTION", renewal: "PUSH_TITLE_RENEWAL", trial: "PUSH_TITLE_TRIAL", conversion: "PUSH_TITLE_CONVERSION" }[r.kind] ?? "PUSH_TITLE_PURCHASE";
    const name = await productName(db, app.id, r.productId);
    const bodyKey = r.kind === "trial" ? "PUSH_BODY_TRIAL" : "PUSH_BODY_SALE";
    const bodyArgs = r.kind === "trial" ? [name, countryLabel(r.country)] : [name, countryLabel(r.country), formatMoney(r.grossUsd * rate, currency)];
    const ads = adsPushLabel(await purchaseAttribution(db, app.id, r.originalTransactionId, r.appAccountToken));
    const msg: PushMessage = {
      kind,
      appId: app.id,
      titleKey,
      titleArgs: [app.name + sandbox],
      bodyKey,
      bodyArgs,
      amountUsd: r.grossUsd,
      data: { transactionId: r.transactionId },
      ...(ads ? { newer: { pushVersion: PUSH_VERSION_ADS, bodyKey: `${bodyKey}_ADS`, bodyArgs: [...bodyArgs, ads] } } : {}),
    };
    await pushToWorkspace(env, db, app.workspace_id, msg);
    if (r.grossUsd > 0 && r.environment === "Production") revenue = { appName: app.name, amountUsd: r.grossUsd, productName: name };
  }
  if (revenue) await pushLiveUpdates(env, db, app.workspace_id, revenue);
}

// --- Voided purchases poll (refunds RTDN missed) -------------------------------------------------------------------------

/**
 * Daily: voided purchases (refunds, chargebacks, revocations) of the last days for Android apps with a service account,
 * matched to stored orders by order id. Background work: metered, within the daily budget, a few apps per call.
 */
export const pollVoidedPurchases = defineDbFunction(
  "pollVoidedPurchases",
  async (db, args: { maxApps?: number; appIds?: string[]; force?: boolean }, env): Promise<{ apps: number; requests: number; refunded: number; errors: string[]; budget?: boolean }> => {
    if (!(await backgroundAllowed(db, env))) return { apps: 0, requests: 0, refunded: 0, errors: [], budget: true };
    return metered(db, async () => {
      const t = now();
      const filter = args.appIds?.length ? ` AND id IN (${args.appIds.slice(0, 50).map(() => "?").join(",")})` : "";
      const { results: apps } = await db
        .prepare(
          `SELECT ${APP_COLUMNS}, google_voided_checked_at FROM apps WHERE platform = 'android' AND archived = 0 AND bundle_id IS NOT NULL
             AND workspace_id IN (SELECT workspace_id FROM credentials WHERE kind = 'google_play')${args.force ? "" : " AND COALESCE(google_voided_checked_at, 0) < ?"}${filter}
           ORDER BY COALESCE(google_voided_checked_at, 0) LIMIT ?`,
        )
        .bind(...(args.force ? [] : [t - 20 * 3_600_000]), ...(args.appIds?.slice(0, 50) ?? []), args.maxApps ?? 4)
        .all<PlayAppRow & { google_voided_checked_at: number | null }>();
      let requests = 0;
      let refunded = 0;
      const errors: string[] = [];
      for (const app of apps) {
        const sa = await playServiceAccount(env, db, app);
        if (!sa) continue;
        const api = new GooglePlayApi(sa, app.bundle_id!);
        const since = Math.max(t - 30 * DAY + 3_600_000, (app.google_voided_checked_at ?? 0) - 2 * DAY);
        try {
          const voided: { orderId: string; at: number }[] = [];
          let token: string | undefined;
          for (let page = 0; page < 5; page++) {
            const r = await api.voided(since, t, token);
            for (const v of r.voidedPurchases ?? []) if (v.orderId) voided.push({ orderId: v.orderId, at: ms(v.voidedTimeMillis) ?? t });
            token = r.tokenPagination?.nextPageToken;
            if (!token) break;
          }
          refunded += await applyVoided(db, app, voided);
          await db.prepare("UPDATE apps SET google_voided_checked_at = ? WHERE id = ?").bind(t, app.id).run();
        } catch (err) {
          errors.push(`${app.id}: ${errorMessage(err)}`);
          if (err instanceof GooglePlayApiError || err instanceof GoogleAuthError) await setCheck(db, app.id, { ok: false, error: err.message });
        }
        requests += api.requests;
      }
      return { apps: apps.length, requests, refunded, errors };
    });
  },
);

interface StoredTx {
  transaction_id: string;
  original_transaction_id: string;
  product_id: string;
  product_type: string | null;
  purchased_at: number;
  expires_at: number | null;
  price_milli: number;
  currency: string | null;
  country: string | null;
  environment: string;
  app_account_token: string | null;
  refunded_at: number | null;
  refund_milli: number | null;
  signed_at: number;
}

/** Marks stored orders refunded (full) when they are not yet; one ledger event per order (deduplicated). */
async function applyVoided(db: Db, app: PlayAppRow, voided: { orderId: string; at: number }[]): Promise<number> {
  let n = 0;
  const ids = [...new Set(voided.map((v) => v.orderId).filter((id) => ORDER_ID_RE.test(id)))];
  const at = new Map(voided.map((v) => [v.orderId, v.at]));
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await db
      .prepare(
        `SELECT transaction_id, original_transaction_id, product_id, product_type, purchased_at, expires_at, price_milli, currency, country, environment, app_account_token,
           refunded_at, refund_milli, signed_at FROM transactions WHERE app_id = ? AND transaction_id IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(app.id, ...chunk)
      .all<StoredTx>();
    for (const r of results) {
      if (r.refunded_at && r.refund_milli == null) continue;
      const tx: TxInput = {
        source: "google_play",
        store: "play_store",
        environment: r.environment,
        transactionId: r.transaction_id,
        originalTransactionId: r.original_transaction_id,
        productId: r.product_id,
        productType: (r.product_type as TxInput["productType"]) ?? "consumable",
        purchasedAt: r.purchased_at,
        expiresAt: r.expires_at,
        isTrial: false,
        priceMilli: r.price_milli,
        currency: r.currency,
        country: r.country,
        quantity: 1,
        refundedAt: at.get(r.transaction_id) ?? now(),
        refundMilli: null,
        appAccountToken: r.app_account_token,
        signedAt: Math.max(r.signed_at, now()),
      };
      const res = await applyPlayEventLocal(db, {
        appId: app.id,
        event: { uid: `gpv:${r.transaction_id}`, source: "poll", type: "VOIDED_PURCHASE", subtype: "FULL", environment: r.environment, signedAt: now(), r2Key: null, transactions: [tx], play: null },
      });
      if (!res.duplicate) n++;
    }
  }
  if (n) await rebuildQueued(db, app.id);
  return n;
}

// --- Setup ---------------------------------------------------------------------------------------------------------------

/** Read-only check of the app's service account: voided purchases of the last hour (needs the financial permission). */
export const checkGooglePlay = defineDbFunction("checkGooglePlay", async (db, args: { appId: string }, env): Promise<{ ok: boolean; error?: string }> => {
  const app = await db.prepare(`SELECT ${APP_COLUMNS} FROM apps WHERE id = ?`).bind(args.appId).first<PlayAppRow>();
  if (!app?.bundle_id || app.platform !== "android") return { ok: false, error: "Not an Android app" };
  const sa = await playServiceAccount(env, db, app);
  if (!sa) return { ok: false, error: "Add a Google Play service account key first" };
  try {
    await new GooglePlayApi(sa, app.bundle_id).voided(now() - 3_600_000, now());
    await setCheck(db, app.id, { ok: true });
    return { ok: true };
  } catch (err) {
    let error = errorMessage(err);
    if (err instanceof GooglePlayApiError && (err.status === 401 || err.status === 403))
      error += ' — invite the service account in Play Console (Users and permissions) with "View financial data, orders, and cancellation survey responses" for this app, then wait a few minutes';
    if (err instanceof GooglePlayApiError && err.status === 404) error += ` — check the package name (${app.bundle_id}) and that the app exists in this Play Console account`;
    await setCheck(db, app.id, { ok: false, error });
    return { ok: false, error };
  }
});

export const parseCheck = (json: string | null): { at: number; ok: boolean; error?: string } | null => (json ? parseJson(json, null) : null);
