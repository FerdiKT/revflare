// Polar (polar.sh: web checkout, merchant of record) → ledger. Polar webhooks (Standard Webhooks signatures) carry the
// whole order / subscription, so nothing is fetched to store a sale; an optional organization access token lets
// Revflare create the webhook endpoint itself and import past orders. Runs inside the database object. See docs/polar.md.
//
// Mapping: transaction_id = Polar order id, original_transaction_id = the Polar subscription id (subscription orders)
// or the order id, product_id = the Revflare product id mapped to the Polar product (else the Polar product id),
// store = polar, source = polar, price = the order's net amount (after discounts, before tax), proceeds = net amount −
// Polar's platform fee. Customers: the Revflare install id in the checkout metadata (revflare_install_id) is the
// transaction's appAccountToken, which links the sale to the install (attribution, funnels).

import { addDuration } from "../lib/entitlement-config";
import { defineDbFunction, type Db } from "../lib/db";
import { decryptJson, encryptJson, timingSafeEqual } from "../lib/crypto";
import { metered } from "../lib/budget";
import {
  applyPlayEventLocal,
  type PlayEvent,
  type PlaySubscriptionState,
  type TxInput,
} from "../lib/ledger";
import { FxCache, dayOf, periodFromDuration } from "../lib/money";
import { rebuildQueued } from "../lib/rollup";
import { baseUrl } from "../lib/settings";
import { errorMessage, now, parseJson } from "../lib/util";
import { notifyPlay } from "../google/ingest";
import { productName } from "../apple/ingest";
import { countryLabel, pushToWorkspace } from "../lib/push";
import type { DurationUnit } from "../../shared/types";

const DAY = 86_400_000;
/** Standard Webhooks: signatures older or newer than this are refused (replays). */
const TOLERANCE_MS = 5 * 60_000;

/** The webhook events Revflare uses (the endpoint it creates subscribes to these). */
export const POLAR_EVENTS = [
  "order.paid",
  "order.updated",
  "order.refunded",
  "subscription.created",
  "subscription.updated",
  "subscription.active",
  "subscription.canceled",
  "subscription.uncanceled",
  "subscription.revoked",
  "subscription.past_due",
] as const;

// --- Polar objects (only what Revflare reads) ------------------------------------------------------------------------

export interface PolarProduct {
  id: string;
  name?: string | null;
  is_recurring?: boolean | null;
  recurring_interval?: string | null;
  recurring_interval_count?: number | null;
}

export interface PolarSubscription {
  id: string;
  created_at?: string | null;
  modified_at?: string | null;
  amount?: number | null;
  currency?: string | null;
  recurring_interval?: string | null;
  recurring_interval_count?: number | null;
  status: string;
  current_period_start?: string | null;
  current_period_end?: string | null;
  trial_start?: string | null;
  trial_end?: string | null;
  cancel_at_period_end?: boolean | null;
  canceled_at?: string | null;
  started_at?: string | null;
  ends_at?: string | null;
  ended_at?: string | null;
  customer_cancellation_reason?: string | null;
  product_id?: string | null;
  product?: PolarProduct | null;
  metadata?: Record<string, unknown> | null;
  customer?: PolarCustomer | null;
}

export interface PolarCustomer {
  id?: string;
  external_id?: string | null;
  metadata?: Record<string, unknown> | null;
  billing_address?: { country?: string | null } | null;
}

export interface PolarOrder {
  id: string;
  created_at: string;
  modified_at?: string | null;
  status: string;
  paid?: boolean;
  net_amount?: number | null;
  /** Deprecated older name of the net amount. */
  amount?: number | null;
  tax_amount?: number | null;
  total_amount?: number | null;
  refunded_amount?: number | null;
  currency: string;
  billing_reason?: string | null;
  billing_address?: { country?: string | null } | null;
  customer_id?: string | null;
  product_id?: string | null;
  subscription_id?: string | null;
  metadata?: Record<string, unknown> | null;
  platform_fee_amount?: number | null;
  platform_fee_currency?: string | null;
  customer?: PolarCustomer | null;
  product?: PolarProduct | null;
  subscription?: PolarSubscription | null;
  items?: { label?: string | null }[] | null;
}

/** Per app, in apps.polar_config. */
export interface PolarConfig {
  /** Polar product id → Revflare product id (e.g. the id the app's events and paywalls use). */
  products?: Record<string, string>;
  /** Polar sandbox (sandbox.polar.sh): sales are stored as Sandbox. */
  sandbox?: boolean;
  /** The webhook endpoint Revflare created with the access token. */
  webhookEndpointId?: string | null;
  /** Last order import: { at, orders, error? }. */
  lastSync?: { at: number; orders: number; error?: string } | null;
}

export interface PolarSecret {
  webhookSecret?: string | null;
  accessToken?: string | null;
}

export interface PolarAppRow {
  id: string;
  workspace_id: string;
  name: string;
  platform: string;
  notification_key: string;
  polar_secret: string | null;
  polar_config: string | null;
}

const APP_COLUMNS =
  "id, workspace_id, name, platform, notification_key, polar_secret, polar_config";

export const polarWebhookUrl = (base: string, key: string) =>
  `${base}/polar/webhooks/${key}`;
export const polarApiBase = (sandbox: boolean | undefined) =>
  sandbox ? "https://sandbox-api.polar.sh/v1" : "https://api.polar.sh/v1";

// --- Signatures -------------------------------------------------------------------------------------------------------

function b64decode(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function b64encode(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * Standard Webhooks signature check (webhook-id, webhook-timestamp, webhook-signature "v1,<base64>" ...). The HMAC key
 * is the base64 part of a "whsec_" secret (Standard Webhooks) or, for older Polar endpoints, the secret's own bytes:
 * both are tried, like Polar's SDKs do.
 */
export async function verifyPolarSignature(
  body: string,
  headers: {
    id: string | null;
    timestamp: string | null;
    signature: string | null;
  },
  secret: string,
  at = Date.now(),
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (
    !id ||
    !timestamp ||
    !signature ||
    !/^\d{1,12}$/.test(timestamp) ||
    signature.length > 4096
  )
    return false;
  if (Math.abs(at - Number(timestamp) * 1000) > TOLERANCE_MS) return false;
  const given = signature
    .split(" ")
    .map((p) => p.split(","))
    .filter((p) => p[0] === "v1" && p[1])
    .map((p) => p[1]);
  if (!given.length) return false;
  const keys: Uint8Array[] = [];
  const decoded = b64decode(
    secret.startsWith("whsec_") ? secret.slice(6) : secret,
  );
  if (decoded?.length) keys.push(decoded);
  keys.push(new TextEncoder().encode(secret));
  const content = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
  for (const raw of keys) {
    const key = await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expected = b64encode(await crypto.subtle.sign("HMAC", key, content));
    if (given.some((g) => timingSafeEqual(g, expected))) return true;
  }
  return false;
}

// --- Mapping ----------------------------------------------------------------------------------------------------------

const ms = (t: string | null | undefined): number | null => {
  if (!t) return null;
  const v = Date.parse(t);
  return Number.isFinite(v) ? v : null;
};

/** Currencies without minor units: Polar amounts are in the smallest unit ("cents"). */
const ZERO_DECIMAL = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);
/** Polar amount (smallest unit) → units of the currency. */
export const units = (amount: number, currency: string | null | undefined) =>
  ZERO_DECIMAL.has((currency ?? "USD").toUpperCase()) ? amount : amount / 100;

const UNIT_LETTER: Record<string, string> = {
  day: "D",
  week: "W",
  month: "M",
  year: "Y",
};
const isUnit = (u: unknown): u is DurationUnit =>
  u === "day" || u === "week" || u === "month" || u === "year";
/** Polar interval (+ count) → ISO period ("P1M"). */
export const polarPeriod = (
  interval: string | null | undefined,
  count: number | null | undefined,
) =>
  isUnit(interval)
    ? `P${Math.max(1, count ?? 1)}${UNIT_LETTER[interval]}`
    : null;

const INSTALL_KEYS = [
  "revflare_install_id",
  "revflareInstallId",
  "revflare_id",
];
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Revflare install id from checkout metadata (copied by Polar onto orders and subscriptions). */
export function installIdOf(
  ...sources: (Record<string, unknown> | null | undefined)[]
): string | null {
  for (const m of sources) {
    if (!m) continue;
    for (const k of INSTALL_KEYS) {
      const v = m[k];
      if (typeof v === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(v))
        return UUID_RE.test(v) ? v.toLowerCase() : v;
    }
  }
  return null;
}

/** The Revflare product id of a Polar product. */
export function productIdOf(
  config: PolarConfig,
  polarProductId: string | null | undefined,
  fallback?: string | null,
): string {
  const id = polarProductId ?? "";
  return config.products?.[id] ?? (id || fallback || "polar");
}

/** Orders that are part of a subscription's billing (renewing revenue, MRR). Proration and meter charges are one-time. */
const SUBSCRIPTION_ORDERS = new Set([
  "subscription_create",
  "subscription_cycle",
]);
const PAID_STATUSES = new Set(["paid", "refunded", "partially_refunded"]);

/** One Polar order → a ledger transaction. */
export async function txFromPolarOrder(
  order: PolarOrder,
  config: PolarConfig,
  fx: FxCache,
): Promise<TxInput> {
  const environment = config.sandbox ? "Sandbox" : "Production";
  const sub = order.subscription ?? null;
  const subscriptionId = order.subscription_id ?? sub?.id ?? null;
  const reason =
    order.billing_reason ??
    (subscriptionId ? "subscription_create" : "purchase");
  const recurring = !!subscriptionId && SUBSCRIPTION_ORDERS.has(reason);
  const purchasedAt = ms(order.created_at) ?? now();
  const currency = (order.currency || "usd").toUpperCase();
  const net = Math.max(0, order.net_amount ?? order.amount ?? 0);
  const interval =
    sub?.recurring_interval ?? order.product?.recurring_interval ?? null;
  const count =
    sub?.recurring_interval_count ??
    order.product?.recurring_interval_count ??
    1;
  const trialEnd = ms(sub?.trial_end);
  const isTrial =
    recurring &&
    net === 0 &&
    trialEnd !== null &&
    trialEnd > purchasedAt + 3_600_000;
  let expiresAt: number | null = null;
  if (recurring) {
    const start = ms(sub?.current_period_start);
    const end = ms(sub?.current_period_end);
    if (isTrial) expiresAt = trialEnd;
    else if (
      start !== null &&
      end !== null &&
      end > purchasedAt &&
      Math.abs(start - purchasedAt) < 3 * DAY
    )
      expiresAt = end;
    else if (isUnit(interval))
      expiresAt = addDuration(purchasedAt, {
        unit: interval,
        count: Math.max(1, count ?? 1),
      });
  }
  // Refunds: refunded_amount is of the net amount (tax is refunded apart).
  let refundedAt: number | null = null;
  let refundMilli: number | null = null;
  const refunded = Math.max(0, order.refunded_amount ?? 0);
  if (order.status === "refunded" || refunded > 0) {
    refundedAt = ms(order.modified_at) ?? now();
    if (order.status !== "refunded" && net > 0 && refunded < net) {
      const share = Math.round((refunded / net) * 100_000);
      refundMilli = share > 0 ? share : null;
      if (!refundMilli) refundedAt = null;
    }
  }
  // Proceeds: net amount − Polar's fee (in its own currency); when the order names no fee, Polar's standard 4% + 40¢
  // of the amount paid.
  const day = dayOf(purchasedAt);
  const netUsd = await fx.toUsd(units(net, currency), currency, day);
  let feeUsd: number;
  if (order.platform_fee_amount && order.platform_fee_amount > 0) {
    const feeCurrency = (order.platform_fee_currency || currency).toUpperCase();
    feeUsd = await fx.toUsd(
      units(order.platform_fee_amount, feeCurrency),
      feeCurrency,
      day,
    );
  } else {
    const totalUsd = await fx.toUsd(
      units(Math.max(net, order.total_amount ?? net), currency),
      currency,
      day,
    );
    feeUsd = net > 0 ? totalUsd * 0.04 + 0.4 : 0;
  }
  const productId = productIdOf(
    config,
    order.product_id ?? order.product?.id,
    order.items?.[0]?.label,
  );
  const country =
    (
      order.billing_address?.country ??
      order.customer?.billing_address?.country ??
      ""
    ).toUpperCase() || null;
  return {
    source: "polar",
    store: "polar",
    environment,
    transactionId: order.id,
    originalTransactionId: recurring ? subscriptionId! : order.id,
    productId,
    productType: recurring
      ? "auto_renewable"
      : subscriptionId
        ? "consumable"
        : "non_consumable",
    subscriptionGroup: null,
    purchasedAt,
    originalPurchasedAt: recurring
      ? (ms(sub?.started_at) ?? ms(sub?.created_at))
      : null,
    expiresAt,
    offerType: isTrial ? 1 : null,
    offerDiscountType: isTrial ? "FREE_TRIAL" : null,
    offerPeriod:
      isTrial && trialEnd ? periodFromDuration(trialEnd - purchasedAt) : null,
    isTrial,
    reason:
      recurring && reason === "subscription_cycle" ? "RENEWAL" : "PURCHASE",
    priceMilli: isTrial ? 0 : Math.round(units(net, currency) * 1000),
    currency,
    country: country && /^[A-Z]{2}$/.test(country) ? country : null,
    quantity: 1,
    refundedAt,
    refundMilli,
    appAccountToken: installIdOf(
      order.metadata,
      sub?.metadata,
      order.customer?.metadata,
    ),
    proceedsUsd: isTrial ? null : Math.max(0, netUsd - feeUsd),
    signedAt: ms(order.modified_at) ?? purchasedAt,
  };
}

/** A Polar subscription → its state (null while it is incomplete: never paid). */
export async function stateFromPolarSubscription(
  sub: PolarSubscription,
  fx: FxCache,
  type?: string,
): Promise<PlaySubscriptionState | null> {
  if (sub.status === "incomplete") return null;
  const revoked = type === "subscription.revoked";
  let status: PlaySubscriptionState["status"];
  if (revoked) status = "expired";
  else if (sub.status === "active" || sub.status === "trialing")
    status = "active";
  else if (sub.status === "past_due") status = "billing_retry";
  else status = "expired"; // canceled (ended), unpaid, incomplete_expired, paused
  const renewing =
    ["active", "trialing", "past_due", "paused"].includes(sub.status) &&
    !revoked;
  const autoRenew = renewing && !sub.cancel_at_period_end;
  const cancelled = !autoRenew || status === "expired";
  let cancelReason: string | null = null;
  if (cancelled) {
    if (sub.status === "unpaid" || sub.status === "incomplete_expired")
      cancelReason = "system";
    else if (sub.customer_cancellation_reason)
      cancelReason = `user:${sub.customer_cancellation_reason}`;
    else if (revoked) cancelReason = "developer";
    else cancelReason = "user";
  }
  const end = ms(sub.current_period_end);
  const expiresAt =
    status === "expired"
      ? (ms(sub.ended_at) ?? ms(sub.ends_at) ?? end)
      : sub.status === "trialing"
        ? (ms(sub.trial_end) ?? end)
        : (ms(sub.ends_at) ?? end);
  const currency = (sub.currency || "usd").toUpperCase();
  return {
    status,
    autoRenew,
    expirationReason:
      status === "expired"
        ? cancelReason === "system"
          ? 2
          : cancelReason?.startsWith("user")
            ? 1
            : 5
        : null,
    cancelReason,
    purchaseToken: sub.id,
    renewalPriceUsd:
      typeof sub.amount === "number"
        ? await fx.toUsd(units(sub.amount, currency), currency, dayOf(now()))
        : null,
    expiresAt,
  };
}

/** Products seen in this object: their row (type, period, name) is written once. */
const knownProducts = new Set<string>();

/** Creates (or completes) the product row of a Polar product: type, period and name from Polar. */
async function ensureProduct(
  db: Db,
  app: Pick<PolarAppRow, "id" | "workspace_id">,
  tx: TxInput,
  product: PolarProduct | null | undefined,
) {
  const k = `${app.id}|${tx.productId}`;
  if (knownProducts.has(k)) return;
  const period =
    tx.productType === "auto_renewable"
      ? polarPeriod(
          product?.recurring_interval,
          product?.recurring_interval_count,
        )
      : null;
  const t = now();
  await db
    .prepare(
      `INSERT INTO products (app_id, product_id, workspace_id, type, subscription_group, period, name, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
       ON CONFLICT(app_id, product_id) DO UPDATE SET type = COALESCE(products.type, excluded.type), period = COALESCE(products.period, excluded.period),
         name = COALESCE(products.name, excluded.name), updated_at = excluded.updated_at`,
    )
    .bind(
      app.id,
      tx.productId,
      app.workspace_id,
      tx.productType,
      period,
      product?.name?.slice(0, 120) ?? null,
      t,
      t,
    )
    .run();
  knownProducts.add(k);
}

/** Builds the ledger event of a Polar webhook (or an imported order); null = nothing to store. */
export async function buildPolarEvent(
  db: Db,
  app: Pick<PolarAppRow, "id" | "workspace_id">,
  config: PolarConfig,
  payload: { type: string; data: unknown },
  meta: { uid: string; source: "webhook" | "poll"; signedAt: number },
): Promise<{ event: PlayEvent } | { ignored: string }> {
  const fx = new FxCache(db);
  const environment = config.sandbox ? "Sandbox" : "Production";
  const base = {
    uid: meta.uid,
    source: meta.source,
    subtype: null,
    environment,
    r2Key: null,
    eventSource: meta.source === "webhook" ? "polar" : "polar_poll",
  };
  const type = payload.type;
  if (type.startsWith("order.")) {
    const order = payload.data as PolarOrder;
    if (
      !order ||
      typeof order.id !== "string" ||
      typeof order.created_at !== "string"
    )
      return { ignored: "malformed order" };
    if (!order.paid && !PAID_STATUSES.has(order.status))
      return { ignored: `order ${order.status}` };
    const tx = await txFromPolarOrder(order, config, fx);
    await ensureProduct(db, app, tx, order.product);
    const play =
      tx.productType === "auto_renewable" && order.subscription
        ? await stateFromPolarSubscription(order.subscription, fx)
        : null;
    // The order's own period is the subscription's current one: its end follows the subscription (trial end, cancel).
    return {
      event: {
        ...base,
        type,
        subtype: order.billing_reason ?? null,
        signedAt: tx.signedAt,
        transactions: [tx],
        play,
      },
    };
  }
  if (type.startsWith("subscription.")) {
    const sub = payload.data as PolarSubscription;
    if (!sub || typeof sub.id !== "string" || typeof sub.status !== "string")
      return { ignored: "malformed subscription" };
    const play = await stateFromPolarSubscription(sub, fx, type);
    if (!play) return { ignored: `subscription ${sub.status}` };
    return {
      event: {
        ...base,
        type,
        subtype: sub.status,
        signedAt: ms(sub.modified_at) ?? meta.signedAt,
        transactions: [],
        play,
        stateOf: { originalTransactionId: sub.id, environment },
      },
    };
  }
  return { ignored: `event ${type} not used` };
}

/** Rebuilds the app's daily metrics when the ledger queued it (never a full rebuild for a state change alone). */
async function rebuildIfQueued(db: Db, appId: string) {
  if (
    await db
      .prepare("SELECT 1 AS x FROM rollup_queue WHERE app_id = ?")
      .bind(appId)
      .first()
  )
    await rebuildQueued(db, appId);
}

async function storeRaw(
  env: Env,
  appId: string,
  uid: string,
  body: string,
): Promise<string | null> {
  const t = new Date();
  const key = `raw/polar/${appId}/${t.getUTCFullYear()}/${String(t.getUTCMonth() + 1).padStart(2, "0")}/${uid.replace(/[^A-Za-z0-9._:-]/g, "_")}.json`;
  try {
    await env.RAW.put(key, body, {
      httpMetadata: { contentType: "application/json" },
    });
    return key;
  } catch (err) {
    console.error("raw polar webhook not stored", err);
    return null;
  }
}

export interface PolarWebhookResult {
  status: 200 | 400 | 401 | 404 | 503;
  error?: string;
  type?: string;
  duplicate?: boolean;
  ignored?: string;
}

/** POST /polar/webhooks/:key: verifies, stores and applies one Polar webhook. Polar retries anything but 2xx. */
export const ingestPolarWebhook = defineDbFunction(
  "ingestPolarWebhook",
  async (
    db,
    args: {
      key: string;
      body: string;
      headers: {
        id: string | null;
        timestamp: string | null;
        signature: string | null;
      };
    },
    env,
  ): Promise<PolarWebhookResult> => {
    const app = await db
      .prepare(
        `SELECT ${APP_COLUMNS} FROM apps WHERE notification_key = ? AND platform = 'web'`,
      )
      .bind(args.key)
      .first<PolarAppRow>();
    if (!app) return { status: 404, error: "Unknown webhook URL" };
    // Not connected yet: Polar retries with backoff, nothing is lost while the secret is added.
    const secret = app.polar_secret
      ? await decryptJson<PolarSecret>(env, db, app.polar_secret)
      : null;
    if (!secret?.webhookSecret)
      return {
        status: 503,
        error: "Polar is not connected for this app yet (no webhook secret)",
      };
    if (
      !(await verifyPolarSignature(
        args.body,
        args.headers,
        secret.webhookSecret,
      ))
    )
      return { status: 401, error: "Invalid webhook signature" };
    let payload: { type?: unknown; data?: unknown };
    try {
      payload = JSON.parse(args.body);
    } catch {
      return { status: 400, error: "Invalid JSON" };
    }
    if (typeof payload?.type !== "string")
      return { status: 400, error: "Missing event type" };
    const uid = `polar:${args.headers.id}`;
    if (
      await db
        .prepare("SELECT 1 AS x FROM events WHERE app_id = ? AND uid = ?")
        .bind(app.id, uid)
        .first()
    )
      return { status: 200, duplicate: true, type: payload.type };
    const config = parseJson<PolarConfig>(app.polar_config, {});
    const built = await buildPolarEvent(
      db,
      app,
      config,
      { type: payload.type, data: payload.data },
      { uid, source: "webhook", signedAt: now() },
    );
    if ("ignored" in built)
      return { status: 200, ignored: built.ignored, type: payload.type };
    built.event.r2Key = await storeRaw(env, app.id, uid, args.body);
    const result = await applyPlayEventLocal(db, {
      appId: app.id,
      event: built.event,
      seenChecked: true,
    });
    if (result.duplicate)
      return { status: 200, duplicate: true, type: payload.type };
    await rebuildIfQueued(db, app.id);
    await notifyPlay(env, db, app, built.event, result).catch((err) =>
      console.error("push failed", err),
    );
    if (built.event.stateOf)
      await notifyCancellation(env, db, app, built.event).catch((err) =>
        console.error("push failed", err),
      );
    return { status: 200, type: payload.type };
  },
);

/** A customer cancelled a subscription (subscription.canceled without a transaction): one push, like Apple's / Play's. */
async function notifyCancellation(
  env: Env,
  db: Db,
  app: Pick<PolarAppRow, "id" | "workspace_id" | "name">,
  ev: PlayEvent,
) {
  if (
    ev.type !== "subscription.canceled" ||
    !ev.play?.cancelReason?.startsWith("user") ||
    ev.signedAt < now() - 30 * 60_000 ||
    !ev.stateOf
  )
    return;
  const s = await db
    .prepare(
      "SELECT product_id, country FROM subscriptions WHERE app_id = ? AND original_transaction_id = ?",
    )
    .bind(app.id, ev.stateOf.originalTransactionId)
    .first<{ product_id: string; country: string | null }>();
  if (!s) return;
  await pushToWorkspace(env, db, app.workspace_id, {
    kind: "cancellation",
    appId: app.id,
    titleKey: "PUSH_TITLE_CANCELLATION",
    titleArgs: [
      app.name + (ev.environment !== "Production" ? " (Sandbox)" : ""),
    ],
    bodyKey: "PUSH_BODY_CANCELLATION",
    bodyArgs: [
      await productName(db, app.id, s.product_id),
      countryLabel(s.country),
    ],
  });
}

// --- Settings, endpoint creation, import -------------------------------------------------------------------------------

export interface PolarSettings {
  appId: string;
  webhookUrl: string;
  connected: boolean;
  hasAccessToken: boolean;
  sandbox: boolean;
  products: Record<string, string>;
  webhookEndpointId: string | null;
  lastNotificationAt: number | null;
  lastSync: PolarConfig["lastSync"];
  events: readonly string[];
}

async function loadApp(
  db: Db,
  appId: string,
): Promise<(PolarAppRow & { last_notification_at: number | null }) | null> {
  return db
    .prepare(
      `SELECT ${APP_COLUMNS}, last_notification_at FROM apps WHERE id = ? AND platform = 'web'`,
    )
    .bind(appId)
    .first();
}

function settingsOf(
  app: PolarAppRow & { last_notification_at: number | null },
  secret: PolarSecret | null,
  base: string,
): PolarSettings {
  const config = parseJson<PolarConfig>(app.polar_config, {});
  return {
    appId: app.id,
    webhookUrl: polarWebhookUrl(base, app.notification_key),
    connected: !!secret?.webhookSecret,
    hasAccessToken: !!secret?.accessToken,
    sandbox: !!config.sandbox,
    products: config.products ?? {},
    webhookEndpointId: config.webhookEndpointId ?? null,
    lastNotificationAt: app.last_notification_at,
    lastSync: config.lastSync ?? null,
    events: POLAR_EVENTS,
  };
}

export const getPolarSettings = defineDbFunction(
  "getPolarSettings",
  async (
    db,
    args: { appId: string; requestUrl: string },
    env,
  ): Promise<PolarSettings | null> => {
    const app = await loadApp(db, args.appId);
    if (!app) return null;
    const secret = app.polar_secret
      ? await decryptJson<PolarSecret>(env, db, app.polar_secret)
      : null;
    return settingsOf(app, secret, await baseUrl(env, db, args.requestUrl));
  },
);

async function polarFetch<T>(
  token: string,
  sandbox: boolean | undefined,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const r = await fetch(`${polarApiBase(sandbox)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await r.text();
  if (!r.ok) {
    const detail = parseJson<{ detail?: unknown; error?: unknown }>(text, {});
    throw new Error(
      `Polar API ${r.status}: ${typeof detail.detail === "string" ? detail.detail : typeof detail.error === "string" ? detail.error : text.slice(0, 200)}`,
    );
  }
  return JSON.parse(text) as T;
}

export interface PolarUpdate {
  appId: string;
  requestUrl: string;
  /** Webhook signing secret copied from Polar (null removes it). */
  webhookSecret?: string | null;
  /** Organization access token (scopes webhooks:write, orders:read); null removes it. */
  accessToken?: string | null;
  /** Polar product id → Revflare product id; replaces the map (empty values remove an entry). */
  products?: Record<string, string> | null;
  sandbox?: boolean;
  /** With an access token and no webhook secret: create (or re-key) the Polar webhook endpoint now. Default true. */
  createWebhook?: boolean;
}

/** Saves the app's Polar settings; with an access token and no secret, creates the webhook endpoint in Polar. */
export const updatePolarSettings = defineDbFunction(
  "updatePolarSettings",
  async (
    db,
    args: PolarUpdate,
    env,
  ): Promise<PolarSettings | { error: string }> => {
    const app = await loadApp(db, args.appId);
    if (!app) return { error: "Not found" };
    const secret: PolarSecret = app.polar_secret
      ? await decryptJson<PolarSecret>(env, db, app.polar_secret)
      : {};
    const config = parseJson<PolarConfig>(app.polar_config, {});
    if (args.webhookSecret !== undefined)
      secret.webhookSecret = args.webhookSecret?.trim() || null;
    if (args.accessToken !== undefined)
      secret.accessToken = args.accessToken?.trim() || null;
    if (args.sandbox !== undefined) config.sandbox = args.sandbox;
    if (args.products !== undefined) {
      const map: Record<string, string> = {};
      for (const [k, v] of Object.entries(args.products ?? {}))
        if (k.trim() && typeof v === "string" && v.trim())
          map[k.trim()] = v.trim();
      config.products = map;
    }
    const base = await baseUrl(env, db, args.requestUrl);
    const url = polarWebhookUrl(base, app.notification_key);
    if (
      secret.accessToken &&
      !secret.webhookSecret &&
      args.createWebhook !== false
    ) {
      try {
        const list = await polarFetch<{ items: { id: string; url: string }[] }>(
          secret.accessToken,
          config.sandbox,
          "/webhooks/endpoints?limit=100",
        );
        const existing = list.items.find((e) => e.url === url);
        const endpoint = existing
          ? await polarFetch<{ id: string; secret: string }>(
              secret.accessToken,
              config.sandbox,
              `/webhooks/endpoints/${encodeURIComponent(existing.id)}/secret`,
              { method: "PATCH", body: "{}" },
            )
          : await polarFetch<{ id: string; secret: string }>(
              secret.accessToken,
              config.sandbox,
              "/webhooks/endpoints",
              {
                method: "POST",
                body: JSON.stringify({
                  url,
                  name: "Revflare",
                  format: "raw",
                  events: POLAR_EVENTS,
                }),
              },
            );
        if (!endpoint.secret)
          return {
            error:
              "Polar created the webhook endpoint but returned no secret: copy it from Polar → Settings → Webhooks",
          };
        secret.webhookSecret = endpoint.secret;
        config.webhookEndpointId = endpoint.id;
      } catch (err) {
        return {
          error: `Could not create the webhook endpoint in Polar: ${errorMessage(err)}`,
        };
      }
    }
    const stored =
      secret.webhookSecret || secret.accessToken
        ? await encryptJson(env, db, secret)
        : null;
    await db
      .prepare(
        "UPDATE apps SET polar_secret = ?, polar_config = ?, updated_at = ? WHERE id = ?",
      )
      .bind(stored, JSON.stringify(config), now(), app.id)
      .run();
    return settingsOf(
      { ...app, polar_config: JSON.stringify(config) },
      secret,
      base,
    );
  },
);

/**
 * Imports the app's Polar orders (newest first, at most `maxPages` × 100) with the access token: past sales, refunds
 * and the subscription state each order carries. Orders already stored with the same snapshot change nothing.
 */
export const syncPolarOrders = defineDbFunction(
  "syncPolarOrders",
  async (
    db,
    args: { appId: string; maxPages?: number },
    env,
  ): Promise<{ orders: number; stored: number; error?: string }> => {
    const app = await loadApp(db, args.appId);
    if (!app) return { orders: 0, stored: 0, error: "Not found" };
    const secret = app.polar_secret
      ? await decryptJson<PolarSecret>(env, db, app.polar_secret)
      : null;
    if (!secret?.accessToken)
      return {
        orders: 0,
        stored: 0,
        error:
          "No Polar access token for this app (PUT /apps/:id/polar { accessToken })",
      };
    const config = parseJson<PolarConfig>(app.polar_config, {});
    const filter = Object.keys(config.products ?? {})
      .map((id) => `&product_id=${encodeURIComponent(id)}`)
      .join("");
    let orders = 0;
    let stored = 0;
    let error: string | undefined;
    await metered(db, async () => {
      try {
        const pages = Math.min(Math.max(args.maxPages ?? 5, 1), 20);
        for (let page = 1; page <= pages; page++) {
          const r = await polarFetch<{
            items: PolarOrder[];
            pagination: { max_page: number };
          }>(
            secret.accessToken!,
            config.sandbox,
            `/orders/?limit=100&page=${page}&sorting=-created_at${filter}`,
          );
          for (const order of r.items) {
            orders++;
            const built = await buildPolarEvent(
              db,
              app,
              config,
              { type: "order.updated", data: order },
              {
                uid: `polar-sync:${order.id}:${order.modified_at ?? order.created_at}`,
                source: "poll",
                signedAt: now(),
              },
            );
            if ("ignored" in built) continue;
            const res = await applyPlayEventLocal(db, {
              appId: app.id,
              event: built.event,
            });
            if (!res.duplicate && res.transactions.some((t) => t.isNew))
              stored++;
          }
          if (page >= r.pagination.max_page) break;
        }
      } catch (err) {
        error = errorMessage(err);
      }
    });
    config.lastSync = { at: now(), orders, ...(error ? { error } : {}) };
    await db
      .prepare("UPDATE apps SET polar_config = ? WHERE id = ?")
      .bind(JSON.stringify(config), app.id)
      .run();
    await rebuildIfQueued(db, app.id);
    return { orders, stored, ...(error ? { error } : {}) };
  },
);
