// The ledger: turns store events (verified Apple notifications, App Store Server API transactions, RevenueCat
// imports) into transactions, subscription states and customers. Runs inside the database object (defineDbFunction):
// one RPC per batch of events, whatever the number of queries.

import { toAlpha2 } from "../../shared/countries";
import type { ProductDuration } from "../../shared/types";
import type { AppleEvent, RenewalInfo, TransactionInfo } from "../apple/types";
import { defineDbFunction, type Db } from "./db";
import { addDuration } from "./entitlement-config";
import { appDurations } from "./entitlements";
import { queueMetaEvent } from "./meta";
import { FxCache, dayOf, estimateProceeds, monthly, periodFromDuration, refundedShare } from "./money";
import { newId, now } from "./util";

export type ProductType = "auto_renewable" | "non_consumable" | "consumable" | "non_renewing";

/** A store transaction, normalized (all sources). */
export interface TxInput {
  source: "apple" | "revenuecat" | "google_play" | "polar";
  /** app_store (default) | play_store | polar */
  store?: "app_store" | "play_store" | "polar";
  environment: string;
  transactionId: string;
  originalTransactionId: string;
  webOrderLineItemId?: string | null;
  productId: string;
  productType: ProductType;
  subscriptionGroup?: string | null;
  purchasedAt: number;
  originalPurchasedAt?: number | null;
  expiresAt?: number | null;
  offerType?: number | null;
  offerId?: string | null;
  offerDiscountType?: string | null;
  offerPeriod?: string | null;
  isTrial: boolean;
  reason?: "PURCHASE" | "RENEWAL" | null;
  /** Unit price, thousandths of `currency`. */
  priceMilli: number;
  currency: string | null;
  country: string | null;
  quantity: number;
  refundedAt?: number | null;
  refundReason?: number | null;
  /** Prorated refund: refunded share in milliunits (Apple's revocationPercentage); null = full refund. */
  refundMilli?: number | null;
  revokedAt?: number | null;
  isUpgraded?: boolean;
  familyShared?: boolean;
  appAccountToken?: string | null;
  rcAppUserId?: string | null;
  /** Google Play upgrades / re-signups: the replaced subscription's original id (same customer). */
  linkedOriginalTransactionId?: string | null;
  /** Price already in USD (RevenueCat gives it); else converted with the day's rate. */
  grossUsd?: number | null;
  /** Exact developer proceeds in USD (Google Play's developerRevenueInBuyerCurrency): stored as reported. */
  proceedsUsd?: number | null;
  signedAt: number;
}

const PRODUCT_TYPES: Record<string, ProductType> = {
  "Auto-Renewable Subscription": "auto_renewable",
  "Non-Consumable": "non_consumable",
  Consumable: "consumable",
  "Non-Renewing Subscription": "non_renewing",
};

/** Refunded share of a prorated refund (milliunits, 0 < p < 100000), else null (full refund or none). */
export function prorationOf(tx: Pick<TransactionInfo, "revocationDate" | "revocationPercentage" | "revocationType">): number | null {
  if (!tx.revocationDate) return null;
  const p = tx.revocationPercentage;
  if (typeof p !== "number" || !Number.isFinite(p) || p <= 0 || p >= 100_000) return null;
  if (tx.revocationType && tx.revocationType !== "REFUND_PRORATED") return null;
  return Math.round(p);
}

export function txFromApple(tx: TransactionInfo, notificationType?: string): TxInput {
  const revoked =
    notificationType === "REVOKE" ||
    tx.revocationType === "FAMILY_REVOKE" ||
    tx.revocationType === "ASSIGNMENT_REVOKE" ||
    (tx.revocationDate && tx.revocationReason === undefined && tx.inAppOwnershipType === "FAMILY_SHARED");
  return {
    source: "apple",
    environment: tx.environment ?? "Production",
    transactionId: String(tx.transactionId),
    originalTransactionId: String(tx.originalTransactionId ?? tx.transactionId),
    webOrderLineItemId: tx.webOrderLineItemId ?? null,
    productId: tx.productId,
    productType: PRODUCT_TYPES[tx.type] ?? "consumable",
    subscriptionGroup: tx.subscriptionGroupIdentifier ?? null,
    purchasedAt: tx.purchaseDate,
    originalPurchasedAt: tx.originalPurchaseDate ?? null,
    expiresAt: tx.expiresDate ?? null,
    offerType: tx.offerType ?? null,
    offerId: tx.offerIdentifier ?? null,
    offerDiscountType: tx.offerDiscountType ?? null,
    offerPeriod: tx.offerPeriod ?? null,
    isTrial: tx.offerDiscountType === "FREE_TRIAL" || (!!tx.offerType && (tx.price ?? 0) === 0 && tx.type === "Auto-Renewable Subscription"),
    reason: tx.transactionReason ?? null,
    priceMilli: tx.price ?? 0,
    currency: tx.currency ?? null,
    country: toAlpha2(tx.storefront),
    quantity: tx.quantity ?? 1,
    refundedAt: tx.revocationDate && !revoked ? tx.revocationDate : null,
    refundReason: tx.revocationDate && !revoked ? (tx.revocationReason ?? null) : null,
    refundMilli: tx.revocationDate && !revoked ? prorationOf(tx) : null,
    revokedAt: tx.revocationDate && revoked ? tx.revocationDate : null,
    isUpgraded: !!tx.isUpgraded,
    familyShared: tx.inAppOwnershipType === "FAMILY_SHARED",
    appAccountToken: tx.appAccountToken ?? null,
    signedAt: tx.signedDate ?? 0,
  };
}

/** Subscription state from Google Play (subscriptionsv2): replaces what Apple's renewal info / notification give. */
export interface PlaySubscriptionState {
  /** trial is derived from the latest transaction: pass active. */
  status: "active" | "grace" | "billing_retry" | "expired" | "refunded" | "revoked";
  autoRenew: boolean;
  /** Apple-style expiration reason when expired / cancelled (1 cancelled, 2 billing, 5 other). */
  expirationReason: number | null;
  /** user[:<survey reason>] | system | developer | replacement */
  cancelReason: string | null;
  purchaseToken: string;
  /** Next renewal price (recurringPrice) in USD. */
  renewalPriceUsd: number | null;
  /** The subscription's expiry (lineItems[].expiryTime). */
  expiresAt: number | null;
}

interface AppRow {
  id: string;
  workspace_id: string;
  commission_pct: number;
  bundle_id: string | null;
  /** 1 when the app's Meta Ads integration is on (new transactions are queued for it). */
  meta_enabled?: number | null;
}

interface TxRow {
  id: string;
  customer_id: string | null;
  signed_at: number;
  refunded_at: number | null;
  refund_milli: number | null;
  proceeds_reported: number;
  gross_usd: number;
  proceeds_usd: number;
}

export interface LedgerResult {
  /** Per input event: what happened (for push notifications and the response). */
  events: {
    uid: string;
    duplicate: boolean;
    kind: string | null;
    type: string;
    productId: string | null;
    country: string | null;
    /** Gross in USD; for a REFUND, the refunded part (prorated share of a partial refund). */
    amountUsd: number;
    transactionId: string | null;
    environment: string;
    isNewTransaction: boolean;
  }[];
}

class Ledger {
  private readonly fx: FxCache;
  private readonly t = now();
  private readonly periods = new Map<string, string | null>();

  constructor(
    private readonly db: Db,
    private readonly app: AppRow,
  ) {
    this.fx = new FxCache(db);
  }

  private durations: Promise<Record<string, ProductDuration>> | null = null;

  /**
   * Non-renewing products (passes) with a duration set in Revflare (worker/lib/entitlements.ts): Apple and Google Play
   * give their transactions no expiry, so it is purchase + duration (no stacking of repeat purchases here: each
   * transaction keeps its own period; RevflareKit stacks them on the device). Read once per batch, and only for
   * one-time transactions without an expiry. Never non-consumables (lifetime) nor subscriptions. Revenue is unchanged
   * (one-time purchase, never MRR).
   */
  private async withPassExpiry(tx: TxInput): Promise<TxInput> {
    if (tx.productType === "auto_renewable" || tx.productType === "non_consumable" || tx.expiresAt != null) return tx;
    this.durations ??= appDurations(this.db, this.app.id);
    const d = (await this.durations)[tx.productId];
    return d ? { ...tx, expiresAt: addDuration(tx.purchasedAt, d) } : tx;
  }

  private async productPeriod(productId: string): Promise<string | null> {
    if (this.periods.has(productId)) return this.periods.get(productId)!;
    const row = await this.db
      .prepare("SELECT period FROM products WHERE app_id = ? AND product_id = ?")
      .bind(this.app.id, productId)
      .first<{ period: string | null }>();
    this.periods.set(productId, row?.period ?? null);
    return row?.period ?? null;
  }

  private async ensureProduct(tx: TxInput, period: string | null) {
    const known = this.periods.get(tx.productId);
    if (known !== undefined && (known || !period)) return;
    await this.db
      .prepare(
        `INSERT INTO products (app_id, product_id, workspace_id, type, subscription_group, period, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(app_id, product_id) DO UPDATE SET
           type = COALESCE(products.type, excluded.type),
           subscription_group = COALESCE(products.subscription_group, excluded.subscription_group),
           period = COALESCE(products.period, excluded.period), updated_at = excluded.updated_at`,
      )
      .bind(this.app.id, tx.productId, this.app.workspace_id, tx.productType, tx.subscriptionGroup ?? null, period, this.t, this.t)
      .run();
    this.periods.set(tx.productId, period ?? known ?? null);
  }

  /** Billing period of a paid subscription transaction (the product's, learned from regular renewals). */
  private async periodOf(tx: TxInput): Promise<string | null> {
    if (tx.productType !== "auto_renewable") return null;
    const fromDuration = tx.expiresAt ? periodFromDuration(tx.expiresAt - tx.purchasedAt, tx.environment) : null;
    // Offers (trials, intro prices) have their own period; the product's regular period is learned elsewhere.
    if (tx.offerType) {
      await this.productPeriod(tx.productId);
      await this.ensureProduct(tx, null);
      return tx.offerPeriod ?? fromDuration;
    }
    const known = await this.productPeriod(tx.productId);
    await this.ensureProduct(tx, known ?? fromDuration);
    return known ?? fromDuration;
  }

  private async customerFor(tx: TxInput, existing: TxRow | null): Promise<string> {
    if (existing?.customer_id) return existing.customer_id;
    const db = this.db;
    let row: { id: string } | null = null;
    if (tx.appAccountToken) {
      row = await db.prepare("SELECT id FROM customers WHERE app_id = ? AND app_account_token = ?").bind(this.app.id, tx.appAccountToken).first();
    }
    if (!row && tx.rcAppUserId) {
      row = await db.prepare("SELECT id FROM customers WHERE app_id = ? AND rc_app_user_id = ?").bind(this.app.id, tx.rcAppUserId).first();
    }
    if (!row) {
      row = await db
        .prepare("SELECT customer_id AS id FROM transactions WHERE app_id = ? AND original_transaction_id = ? AND customer_id IS NOT NULL LIMIT 1")
        .bind(this.app.id, tx.originalTransactionId)
        .first();
    }
    if (!row && tx.linkedOriginalTransactionId) {
      row = await db
        .prepare("SELECT customer_id AS id FROM subscriptions WHERE app_id = ? AND original_transaction_id = ? AND customer_id IS NOT NULL")
        .bind(this.app.id, tx.linkedOriginalTransactionId)
        .first();
    }
    const sandbox = tx.environment === "Production" ? 0 : 1;
    if (row) {
      await db
        .prepare(
          `UPDATE customers SET last_seen_at = MAX(last_seen_at, ?), first_seen_at = MIN(first_seen_at, ?), sandbox = MIN(sandbox, ?),
           country = COALESCE(country, ?), app_account_token = COALESCE(app_account_token, ?), rc_app_user_id = COALESCE(rc_app_user_id, ?)
           WHERE id = ?`,
        )
        .bind(tx.purchasedAt, tx.purchasedAt, sandbox, tx.country, tx.appAccountToken ?? null, tx.rcAppUserId ?? null, row.id)
        .run();
      return row.id;
    }
    const id = newId("cus_");
    await db
      .prepare(
        `INSERT INTO customers (id, workspace_id, app_id, app_account_token, rc_app_user_id, country, first_seen_at, last_seen_at, sandbox)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, this.app.workspace_id, this.app.id, tx.appAccountToken ?? null, tx.rcAppUserId ?? null, tx.country, tx.purchasedAt, tx.purchasedAt, sandbox)
      .run();
    return id;
  }

  /** Inserts or updates one transaction. Returns its row id, whether it is new and its kind. */
  /** Whether the last guessKind() found earlier transactions of the same subscription. */
  private lastHadPrior = false;

  /** Earliest purchase time touched in this batch (daily metrics are rebuilt from that day on). */
  earliest: number | null = null;

  private touch(at: number) {
    if (this.earliest === null || at < this.earliest) this.earliest = at;
  }

  /** Customer totals and first payment, kept incrementally (a rollup never rewrites every customer). */
  private async addToCustomer(customerId: string, tx: TxInput, gross: number, proceeds: number, sign: 1 | -1) {
    if (tx.environment !== "Production" || tx.isTrial || gross <= 0) return;
    await this.db
      .prepare(
        `UPDATE customers SET total_usd = MAX(0, total_usd + ?), total_proceeds_usd = MAX(0, total_proceeds_usd + ?),
         first_paid_at = CASE WHEN ? > 0 THEN MIN(COALESCE(first_paid_at, ?), ?) ELSE first_paid_at END WHERE id = ?`,
      )
      .bind(sign * gross, sign * proceeds, sign, tx.purchasedAt, tx.purchasedAt, customerId)
      .run();
  }

  async upsert(input: TxInput): Promise<{ id: string; isNew: boolean; kind: string; grossUsd: number; customerId: string }> {
    const db = this.db;
    const tx = await this.withPassExpiry(input);
    this.touch(tx.purchasedAt);
    const existing = await db
      .prepare("SELECT id, customer_id, signed_at, refunded_at, refund_milli, proceeds_reported, gross_usd, proceeds_usd FROM transactions WHERE app_id = ? AND transaction_id = ?")
      .bind(this.app.id, tx.transactionId)
      .first<TxRow>();
    const day = dayOf(tx.purchasedAt);
    const quantity = Math.max(1, tx.quantity || 1);
    const gross = tx.isTrial ? 0 : (tx.grossUsd ?? (await this.fx.toUsd((tx.priceMilli / 1000) * quantity, tx.currency, day)));
    const exact = typeof tx.proceedsUsd === "number" && Number.isFinite(tx.proceedsUsd) && !tx.isTrial;
    const proceeds = exact ? Math.max(0, tx.proceedsUsd!) : estimateProceeds(gross, tx.country, this.app.commission_pct);
    const period = await this.periodOf(tx);
    const kind = await this.guessKind(tx);
    const customerId = await this.customerFor(tx, existing);
    if (existing) {
      // Older snapshots never overwrite newer ones (Apple can deliver out of order).
      if (tx.signedAt >= existing.signed_at) {
        // A refund (or its reversal, or a change of its prorated share) moves the customer's total.
        const was = refundedShare(existing);
        const is = refundedShare({ refunded_at: tx.refundedAt ?? null, refund_milli: tx.refundMilli ?? null });
        if (was !== is) {
          const d = is - was;
          await this.addToCustomer(customerId, tx, existing.gross_usd * Math.abs(d), existing.proceeds_usd * Math.abs(d), d > 0 ? -1 : 1);
          this.touch(Math.min(tx.refundedAt ?? existing.refunded_at ?? tx.purchasedAt, tx.purchasedAt));
        }
        // Google Play: proceeds reported after the first sight of the order replace the estimate.
        if (exact && !existing.proceeds_reported) {
          await db.prepare("UPDATE transactions SET proceeds_usd = ?, proceeds_reported = 1 WHERE id = ?").bind(proceeds, existing.id).run();
        }
        // An upgraded (replaced) transaction stays so: a later snapshot of it never un-sets the flag nor stretches its
        // period past the cut (Google Play rebuilds the replaced order with its full service period).
        await db
          .prepare(
            `UPDATE transactions SET expires_at = CASE WHEN is_upgraded = 1 AND expires_at IS NOT NULL THEN MIN(expires_at, COALESCE(?, expires_at)) ELSE ? END,
             refunded_at = ?, refund_reason = ?, refund_milli = ?, revoked_at = ?, is_upgraded = MAX(is_upgraded, ?),
             customer_id = COALESCE(customer_id, ?), signed_at = ?, updated_at = ? WHERE id = ?`,
          )
          .bind(
            tx.expiresAt ?? null,
            tx.expiresAt ?? null,
            tx.refundedAt ?? null,
            tx.refundReason ?? null,
            tx.refundedAt ? (tx.refundMilli ?? null) : null,
            tx.revokedAt ?? null,
            tx.isUpgraded ? 1 : 0,
            customerId,
            tx.signedAt,
            this.t,
            existing.id,
          )
          .run();
      }
      return { id: existing.id, isNew: false, kind, grossUsd: gross, customerId };
    }
    const id = newId("tx_");
    await db
      .prepare(
        `INSERT INTO transactions (id, workspace_id, app_id, customer_id, source, store, environment, transaction_id, original_transaction_id,
          web_order_line_item_id, product_id, product_type, kind, offer_type, offer_id, offer_discount_type, purchased_at,
          original_purchased_at, expires_at, period, price_milli, currency, country, quantity, gross_usd, proceeds_usd, proceeds_reported, refunded_at,
          refund_reason, refund_milli, revoked_at, is_upgraded, family_shared, app_account_token, signed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(app_id, transaction_id) DO NOTHING`,
      )
      .bind(
        id,
        this.app.workspace_id,
        this.app.id,
        customerId,
        tx.source,
        tx.store ?? "app_store",
        tx.environment,
        tx.transactionId,
        tx.originalTransactionId,
        tx.webOrderLineItemId ?? null,
        tx.productId,
        tx.productType,
        kind,
        tx.offerType ?? null,
        tx.offerId ?? null,
        tx.offerDiscountType ?? null,
        tx.purchasedAt,
        tx.originalPurchasedAt ?? null,
        tx.expiresAt ?? null,
        period,
        tx.priceMilli,
        tx.currency,
        tx.country,
        quantity,
        gross,
        proceeds,
        exact ? 1 : 0,
        tx.refundedAt ?? null,
        tx.refundReason ?? null,
        tx.refundedAt ? (tx.refundMilli ?? null) : null,
        tx.revokedAt ?? null,
        tx.isUpgraded ? 1 : 0,
        tx.familyShared ? 1 : 0,
        tx.appAccountToken ?? null,
        tx.signedAt,
        this.t,
        this.t,
      )
      .run();
    const kept = 1 - refundedShare({ refunded_at: tx.refundedAt ?? null, refund_milli: tx.refundMilli ?? null });
    if (kept > 0) await this.addToCustomer(customerId, tx, gross * kept, proceeds * kept, 1);
    // RevflareKit sets appAccountToken = its install id: the purchase links itself to the install's attribution.
    if (tx.appAccountToken) {
      await db
        .prepare("INSERT INTO install_links (app_id, original_transaction_id, install_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
        .bind(this.app.id, tx.originalTransactionId, tx.appAccountToken.toLowerCase(), this.t)
        .run();
    }
    // A later period of a subscription we have never seen: the customer's earlier history is missing, fetch it from
    // Apple (Get Transaction History) later. First purchases and one-time purchases need nothing.
    if (tx.source === "apple" && tx.environment === "Production" && tx.transactionId !== tx.originalTransactionId && !this.lastHadPrior) {
      await db
        .prepare(
          `INSERT INTO pending_history (app_id, transaction_id, source, created_at) SELECT ?, ?, 'ledger', ?
           WHERE NOT EXISTS (SELECT 1 FROM apple_history_state WHERE app_id = ? AND original_transaction_id = ?) ON CONFLICT DO NOTHING`,
        )
        .bind(this.app.id, tx.originalTransactionId, this.t, this.app.id, tx.originalTransactionId)
        .run();
    }
    // Meta Ads integration: queue it (sent by the cron once the install that made it is known).
    if (tx.source === "apple" || tx.source === "google_play") await queueMetaEvent(db, this.app, tx);
    return { id, isNew: true, kind, grossUsd: gross, customerId };
  }

  /**
   * Best guess of the transaction's kind from what is already stored (the rollup recomputes kinds from the whole
   * history of the subscription, so out-of-order arrival is corrected there).
   */
  private async guessKind(tx: TxInput): Promise<string> {
    this.lastHadPrior = false;
    if (tx.productType !== "auto_renewable") return "one_time";
    const prior = await this.db
      .prepare(
        `SELECT SUM(kind = 'trial') AS trials, SUM(kind != 'trial') AS paid FROM transactions
         WHERE app_id = ? AND original_transaction_id = ? AND purchased_at < ? AND transaction_id != ?`,
      )
      .bind(this.app.id, tx.originalTransactionId, tx.purchasedAt, tx.transactionId)
      .first<{ trials: number | null; paid: number | null }>();
    this.lastHadPrior = !!(prior?.paid || prior?.trials);
    if (tx.isTrial) return "trial";
    if (prior?.paid) return "renewal";
    if (prior?.trials) return "conversion";
    // A renewal whose predecessors we have not seen yet.
    if (tx.reason === "RENEWAL") return tx.offerType ? "conversion" : "renewal";
    return "new";
  }

  /** Updates the subscription's latest state from a transaction (+ renewal info, notification, API status). */
  async updateSubscription(
    tx: TxInput,
    renewal: RenewalInfo | null,
    ev: { type?: string; subtype?: string | null; signedAt: number; status?: number | null },
    customerId: string,
    play?: PlaySubscriptionState | null,
  ) {
    if (tx.productType !== "auto_renewable") return;
    const db = this.db;
    const sub = await db
      .prepare("SELECT id, status, auto_renew, expires_at, last_event_at, started_at FROM subscriptions WHERE app_id = ? AND original_transaction_id = ?")
      .bind(this.app.id, tx.originalTransactionId)
      .first<{ id: string; status: string; auto_renew: number; expires_at: number | null; last_event_at: number | null; started_at: number }>();
    if (sub?.last_event_at && ev.signedAt < sub.last_event_at) return;

    // The latest transaction of the subscription decides price and expiry.
    const latest = await db
      .prepare(
        `SELECT product_id, purchased_at, expires_at, kind, period, price_milli, currency, country, gross_usd, proceeds_usd, refunded_at, refund_milli, revoked_at
         FROM transactions WHERE app_id = ? AND original_transaction_id = ? ORDER BY purchased_at DESC LIMIT 1`,
      )
      .bind(this.app.id, tx.originalTransactionId)
      .first<{
        product_id: string;
        purchased_at: number;
        expires_at: number | null;
        kind: string;
        period: string | null;
        price_milli: number;
        currency: string | null;
        country: string | null;
        gross_usd: number;
        proceeds_usd: number;
        refunded_at: number | null;
        refund_milli: number | null;
        revoked_at: number | null;
      }>();
    if (!latest) return;
    // Google Play: a partially refunded order still pays for the period (the subscription goes on).
    const lastPaid = await db
      .prepare(
        `SELECT gross_usd, period, product_id FROM transactions WHERE app_id = ? AND original_transaction_id = ? AND kind != 'trial'
         AND (refunded_at IS NULL OR (? = 1 AND refund_milli IS NOT NULL)) ORDER BY purchased_at DESC LIMIT 1`,
      )
      .bind(this.app.id, tx.originalTransactionId, play ? 1 : 0)
      .first<{ gross_usd: number; period: string | null; product_id: string }>();

    const t = this.t;
    // A replaced Play subscription keeps the cut of its last order (the upgrade), whatever expiry Google reports later.
    const expiresAt =
      play?.cancelReason === "replacement" && play.expiresAt != null && latest.expires_at != null ? Math.min(play.expiresAt, latest.expires_at) : (play?.expiresAt ?? latest.expires_at);
    let status: string;
    let expirationReason: number | null = renewal?.expirationIntent ?? null;
    const type = ev.type ?? "";
    const sandboxOrProd = latest.expires_at ?? 0;
    if (latest.revoked_at) status = "revoked";
    else if (latest.refunded_at) status = "refunded";
    else if (ev.status === 5) status = "revoked";
    else if (ev.status === 3 || renewal?.isInBillingRetryPeriod || (type === "DID_FAIL_TO_RENEW" && ev.subtype !== "GRACE_PERIOD")) status = "billing_retry";
    else if (ev.status === 4 || (type === "DID_FAIL_TO_RENEW" && ev.subtype === "GRACE_PERIOD") || (renewal?.gracePeriodExpiresDate ?? 0) > t) status = "grace";
    else if (ev.status === 2 || type === "EXPIRED" || type === "GRACE_PERIOD_EXPIRED" || (sandboxOrProd && sandboxOrProd <= t)) status = "expired";
    else status = latest.kind === "trial" ? "trial" : "active";
    if (type === "EXPIRED") {
      expirationReason = { VOLUNTARY: 1, BILLING_RETRY: 2, PRICE_INCREASE: 3, PRODUCT_NOT_FOR_SALE: 4 }[ev.subtype ?? ""] ?? expirationReason ?? 5;
    }
    // A billing retry that ran out of time without an EXPIRED notification yet.
    if (status === "billing_retry" && expiresAt && expiresAt < t - 60 * 86_400_000) status = "expired";

    let autoRenew = renewal?.autoRenewStatus ?? sub?.auto_renew ?? 1;
    if (type === "DID_CHANGE_RENEWAL_STATUS") autoRenew = ev.subtype === "AUTO_RENEW_DISABLED" ? 0 : 1;
    if (play) {
      // Google Play says the state outright (a full refund / revocation seen on the order still wins; a partial refund
      // leaves the subscription as Play says).
      const partialRefund = status === "refunded" && latest.refund_milli != null;
      if ((status !== "refunded" && status !== "revoked") || partialRefund) status = play.status === "active" && latest.kind === "trial" ? "trial" : play.status;
      if (play.status === "refunded" || play.status === "revoked") status = play.status;
      autoRenew = play.autoRenew ? 1 : 0;
      expirationReason = play.expirationReason;
    }
    // A paused Play subscription keeps auto-renew on (it resumes by itself).
    if ((status === "expired" && !(play && play.autoRenew)) || status === "refunded" || status === "revoked") autoRenew = 0;

    const period = lastPaid?.period ?? latest.period ?? (await this.productPeriod(latest.product_id));
    const paying = status === "active" || status === "grace";
    const mrr = paying && lastPaid ? monthly(lastPaid.gross_usd, period) : 0;
    let renewalPriceUsd: number | null = null;
    if (play?.renewalPriceUsd != null) renewalPriceUsd = play.renewalPriceUsd;
    else if (renewal?.renewalPrice) renewalPriceUsd = await this.fx.toUsd(renewal.renewalPrice / 1000, renewal.currency ?? latest.currency, dayOf(t));
    else if (lastPaid) renewalPriceUsd = lastPaid.gross_usd;

    await db
      .prepare(
        `INSERT INTO subscriptions (id, workspace_id, app_id, customer_id, environment, original_transaction_id, product_id, status, auto_renew,
           auto_renew_product_id, expiration_reason, started_at, current_period_start, expires_at, grace_expires_at, period, price_milli,
           currency, country, mrr_usd, renewal_price_usd, last_event_at, updated_at, purchase_token, cancel_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(app_id, original_transaction_id) DO UPDATE SET
           customer_id = COALESCE(subscriptions.customer_id, excluded.customer_id), product_id = excluded.product_id,
           status = excluded.status, auto_renew = excluded.auto_renew, auto_renew_product_id = excluded.auto_renew_product_id,
           expiration_reason = excluded.expiration_reason, started_at = MIN(subscriptions.started_at, excluded.started_at),
           current_period_start = excluded.current_period_start, expires_at = excluded.expires_at, grace_expires_at = excluded.grace_expires_at,
           period = excluded.period, price_milli = excluded.price_milli, currency = excluded.currency, country = COALESCE(excluded.country, subscriptions.country),
           mrr_usd = excluded.mrr_usd, renewal_price_usd = excluded.renewal_price_usd, last_event_at = excluded.last_event_at, updated_at = excluded.updated_at,
           purchase_token = COALESCE(excluded.purchase_token, subscriptions.purchase_token),
           cancel_reason = CASE WHEN excluded.purchase_token IS NULL THEN subscriptions.cancel_reason ELSE excluded.cancel_reason END`,
      )
      .bind(
        sub?.id ?? newId("sub_"),
        this.app.workspace_id,
        this.app.id,
        customerId,
        tx.environment,
        tx.originalTransactionId,
        latest.product_id,
        status,
        autoRenew ? 1 : 0,
        renewal?.autoRenewProductId ?? null,
        status === "expired" ? expirationReason : null,
        tx.originalPurchasedAt ?? latest.purchased_at,
        latest.purchased_at,
        expiresAt,
        renewal?.gracePeriodExpiresDate ?? null,
        period,
        latest.price_milli,
        latest.currency,
        latest.country,
        mrr,
        renewalPriceUsd,
        Math.max(ev.signedAt, sub?.last_event_at ?? 0),
        t,
        play?.purchaseToken ?? null,
        play ? (status === "expired" || !autoRenew ? play.cancelReason : null) : null,
      )
      .run();
  }
}

async function loadApp(db: Db, appId: string): Promise<AppRow> {
  const app = await db.prepare("SELECT id, workspace_id, commission_pct, bundle_id, (SELECT enabled FROM meta_integrations WHERE app_id = apps.id) AS meta_enabled FROM apps WHERE id = ?").bind(appId).first<AppRow>();
  if (!app) throw new Error("App not found");
  return app;
}

/** Marks the app's daily metrics stale from `fromDay` on (null: rebuild everything). */
export async function queueRollup(db: Db, appId: string, fromDay: string | null) {
  await db
    .prepare(
      `INSERT INTO rollup_queue (app_id, queued_at, from_day) VALUES (?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET from_day = CASE WHEN rollup_queue.from_day IS NULL OR excluded.from_day IS NULL THEN NULL
         ELSE MIN(rollup_queue.from_day, excluded.from_day) END`,
    )
    .bind(appId, now(), fromDay)
    .run();
}

/** Applies verified Apple events (notifications or Server API data) for one app. */
export async function applyAppleEventsLocal(db: Db, args: { appId: string; events: AppleEvent[] }): Promise<LedgerResult> {
  const app = await loadApp(db, args.appId);
  const ledger = new Ledger(db, app);
  const out: LedgerResult["events"] = [];
  let changed = false;
  for (const ev of args.events) {
    const tx = ev.transaction ? txFromApple(ev.transaction, ev.type) : null;
    if (ev.source !== "api") {
      const ins = await db
        .prepare(
          `INSERT INTO events (id, workspace_id, app_id, uid, source, type, subtype, environment, transaction_id, original_transaction_id,
             product_id, country, amount_usd, signed_at, received_at, r2_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?) ON CONFLICT(app_id, uid) DO NOTHING`,
        )
        .bind(
          newId("evt_"),
          app.workspace_id,
          app.id,
          ev.uid,
          ev.source,
          ev.type,
          ev.subtype,
          ev.environment,
          tx?.transactionId ?? null,
          tx?.originalTransactionId ?? ev.renewal?.originalTransactionId ?? null,
          tx?.productId ?? null,
          tx?.country ?? null,
          ev.signedAt,
          now(),
          ev.r2Key,
        )
        .run();
      if (!ins.meta.changes) {
        out.push({ uid: ev.uid, duplicate: true, kind: null, type: ev.type, productId: tx?.productId ?? null, country: tx?.country ?? null, amountUsd: 0, transactionId: tx?.transactionId ?? null, environment: ev.environment, isNewTransaction: false });
        continue;
      }
      if (ev.source === "webhook") await db.prepare("UPDATE apps SET last_notification_at = ? WHERE id = ?").bind(now(), app.id).run();
    }
    if (!tx) {
      out.push({ uid: ev.uid, duplicate: false, kind: null, type: ev.type, productId: null, country: null, amountUsd: 0, transactionId: null, environment: ev.environment, isNewTransaction: false });
      continue;
    }
    const r = await ledger.upsert(tx);
    await ledger.updateSubscription(tx, ev.renewal, { type: ev.type, subtype: ev.subtype, signedAt: ev.signedAt, status: ev.status }, r.customerId);
    // A refund's amount is the refunded part (the prorated share for a partial refund).
    const share = ev.type === "REFUND" ? refundedShare({ refunded_at: tx.refundedAt ?? null, refund_milli: tx.refundMilli ?? null }) : 0;
    const amountUsd = share > 0 ? r.grossUsd * share : r.grossUsd;
    if (ev.source !== "api") {
      await db.prepare("UPDATE events SET amount_usd = ? WHERE app_id = ? AND uid = ?").bind(amountUsd, app.id, ev.uid).run();
    }
    changed = true;
    out.push({
      uid: ev.uid,
      duplicate: false,
      kind: r.kind,
      type: ev.type,
      productId: tx.productId,
      country: tx.country,
      amountUsd,
      transactionId: tx.transactionId,
      environment: tx.environment,
      isNewTransaction: r.isNew,
    });
  }
  if (changed && ledger.earliest !== null) await queueRollup(db, app.id, dayOf(ledger.earliest));
  return { events: out };
}

export const applyAppleEvents = defineDbFunction("applyAppleEvents", applyAppleEventsLocal);

/**
 * One Google Play notification (or poll result) with the orders it concerns, normalized by worker/google/ingest.ts.
 * Polar webhooks (worker/polar/ingest.ts) use the same shape.
 */
export interface PlayEvent {
  /** "gp:<Pub/Sub messageId>" (or a synthetic id for polls): stored once. */
  uid: string;
  source: "webhook" | "poll";
  /** e.g. SUBSCRIPTION_PURCHASED, ONE_TIME_PRODUCT_PURCHASED, VOIDED_PURCHASE */
  type: string;
  subtype: string | null;
  environment: string;
  signedAt: number;
  r2Key: string | null;
  /** The orders (oldest first); the last one is the notification's own transaction. */
  transactions: TxInput[];
  /** Subscription state (subscriptions only). */
  play: PlaySubscriptionState | null;
  /** Upgrades / downgrades / re-signups: the replaced subscription's purchase token (its subscription ends now). */
  linkedPurchaseToken?: string | null;
  /** events.source of the stored event (default google_play / google_play_poll). */
  eventSource?: string;
  /**
   * A subscription state change without a transaction (Polar subscription.* webhooks): the subscription's original
   * transaction id. Applied to the stored subscription when it has transactions; an earlier end cuts its last period.
   */
  stateOf?: { originalTransactionId: string; environment: string } | null;
}

/** Event types whose amount is the refunded part. */
const REFUND_TYPES = new Set(["VOIDED_PURCHASE", "SUBSCRIPTION_REVOKED", "order.refunded"]);

export interface PlayLedgerResult {
  duplicate: boolean;
  /** Per transaction of the event, in order. */
  transactions: { transactionId: string; kind: string; isNew: boolean; grossUsd: number; productId: string; country: string | null; environment: string; originalTransactionId: string; appAccountToken: string | null }[];
}

/** Whether a Play notification was already stored (Pub/Sub retries): checked before any Google API call. */
export async function playEventSeen(db: Db, appId: string, uid: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 AS x FROM events WHERE app_id = ? AND uid = ?").bind(appId, uid).first());
}

/** Applies a Google Play event: its event row, its orders, the subscription state, the replaced subscription. */
export async function applyPlayEventLocal(db: Db, args: { appId: string; event: PlayEvent; seenChecked?: boolean }): Promise<PlayLedgerResult> {
  const app = await loadApp(db, args.appId);
  const ev = args.event;
  // Stored once per uid (Pub/Sub redelivers; the RTDN endpoint checks before calling Google). The events row is
  // written last, with its amount: one write less.
  if (!args.seenChecked && (await playEventSeen(db, app.id, ev.uid))) return { duplicate: true, transactions: [] };
  const ledger = new Ledger(db, app);
  const last = ev.transactions[ev.transactions.length - 1] ?? null;
  const out: PlayLedgerResult["transactions"] = [];
  let customerId: string | null = null;
  const old = ev.linkedPurchaseToken
    ? await db.prepare("SELECT original_transaction_id FROM subscriptions WHERE app_id = ? AND purchase_token = ?").bind(app.id, ev.linkedPurchaseToken).first<{ original_transaction_id: string }>()
    : null;
  for (const tx of ev.transactions) {
    if (old && old.original_transaction_id !== tx.originalTransactionId) tx.linkedOriginalTransactionId = old.original_transaction_id;
    const r = await ledger.upsert(tx);
    customerId = r.customerId;
    out.push({
      transactionId: tx.transactionId,
      kind: r.kind,
      isNew: r.isNew,
      grossUsd: r.grossUsd,
      productId: tx.productId,
      country: tx.country,
      environment: tx.environment,
      originalTransactionId: tx.originalTransactionId,
      appAccountToken: tx.appAccountToken ?? null,
    });
  }
  let amount: number | null = null;
  if (last && customerId) {
    await ledger.updateSubscription(last, null, { type: ev.type, subtype: ev.subtype, signedAt: ev.signedAt }, customerId, ev.play);
    const gross = out[out.length - 1].grossUsd;
    const share = REFUND_TYPES.has(ev.type) ? refundedShare({ refunded_at: last.refundedAt ?? null, refund_milli: last.refundMilli ?? null }) : 0;
    amount = share > 0 ? gross * share : gross;
  }
  if (!last && ev.play && ev.stateOf) {
    const stub = ev.stateOf;
    const latest = await db
      .prepare("SELECT id, customer_id, purchased_at, expires_at FROM transactions WHERE app_id = ? AND original_transaction_id = ? ORDER BY purchased_at DESC LIMIT 1")
      .bind(app.id, stub.originalTransactionId)
      .first<{ id: string; customer_id: string | null; purchased_at: number; expires_at: number | null }>();
    if (latest?.customer_id) {
      // Ended before its paid period did (revoked now): the period stops there, MRR with it.
      const end = ev.play.expiresAt;
      if ((ev.play.status === "expired" || ev.play.status === "revoked") && end != null && latest.expires_at != null && end < latest.expires_at && end <= now()) {
        const cut = Math.max(end, latest.purchased_at);
        await db.prepare("UPDATE transactions SET expires_at = ?, updated_at = ? WHERE id = ?").bind(cut, now(), latest.id).run();
        ledger.earliest = Math.min(ledger.earliest ?? cut, cut);
      }
      const tx: TxInput = {
        source: "polar",
        environment: stub.environment,
        transactionId: "",
        originalTransactionId: stub.originalTransactionId,
        productId: "",
        productType: "auto_renewable",
        purchasedAt: latest.purchased_at,
        isTrial: false,
        priceMilli: 0,
        currency: null,
        country: null,
        quantity: 1,
        signedAt: ev.signedAt,
      };
      await ledger.updateSubscription(tx, null, { type: ev.type, subtype: ev.subtype, signedAt: ev.signedAt }, latest.customer_id, ev.play);
    }
  }
  // An upgrade / downgrade replaced an older subscription: it ends where the new one starts.
  if (old && last && old.original_transaction_id !== last.originalTransactionId) {
    const cut = last.purchasedAt;
    await db.batch([
      db
        .prepare("UPDATE transactions SET expires_at = MIN(COALESCE(expires_at, ?), ?), is_upgraded = 1, updated_at = ? WHERE app_id = ? AND original_transaction_id = ? AND COALESCE(expires_at, 0) > ?")
        .bind(cut, cut, now(), app.id, old.original_transaction_id, cut),
      db
        .prepare(
          "UPDATE subscriptions SET status = 'expired', auto_renew = 0, mrr_usd = 0, expires_at = MIN(COALESCE(expires_at, ?), ?), cancel_reason = 'replacement', updated_at = ? WHERE app_id = ? AND original_transaction_id = ?",
        )
        .bind(cut, cut, now(), app.id, old.original_transaction_id),
    ]);
    ledger.earliest = Math.min(ledger.earliest ?? cut, cut);
  }
  const ins = await db
    .prepare(
      `INSERT INTO events (id, workspace_id, app_id, uid, source, type, subtype, environment, transaction_id, original_transaction_id,
         product_id, country, amount_usd, signed_at, received_at, r2_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(app_id, uid) DO NOTHING`,
    )
    .bind(
      newId("evt_"),
      app.workspace_id,
      app.id,
      ev.uid,
      ev.eventSource ?? (ev.source === "webhook" ? "google_play" : "google_play_poll"),
      ev.type,
      ev.subtype,
      ev.environment,
      last?.transactionId ?? null,
      last?.originalTransactionId ?? ev.stateOf?.originalTransactionId ?? null,
      last?.productId ?? null,
      last?.country ?? null,
      amount,
      ev.signedAt,
      now(),
      ev.r2Key,
    )
    .run();
  if (ev.source === "webhook") await db.prepare("UPDATE apps SET last_notification_at = ? WHERE id = ?").bind(now(), app.id).run();
  if (ledger.earliest !== null && (ev.transactions.length || ev.stateOf)) await queueRollup(db, app.id, dayOf(ledger.earliest));
  return { duplicate: !ins.meta.changes && !ev.transactions.length, transactions: out };
}

/** Applies normalized transactions from an import (RevenueCat), with an optional subscription state per original id. */
export async function applyImportedTransactionsLocal(db: Db, args: { appId: string; transactions: TxInput[] }): Promise<{ inserted: number; updated: number }> {
    const app = await loadApp(db, args.appId);
    const ledger = new Ledger(db, app);
    let inserted = 0;
    let updated = 0;
    const touched = new Map<string, { tx: TxInput; customerId: string }>();
    for (const tx of args.transactions) {
      const r = await ledger.upsert(tx);
      if (r.isNew) inserted++;
      else updated++;
      const prev = touched.get(tx.originalTransactionId);
      if (!prev || prev.tx.purchasedAt < tx.purchasedAt) touched.set(tx.originalTransactionId, { tx, customerId: r.customerId });
    }
    for (const { tx, customerId } of touched.values()) {
      await ledger.updateSubscription(tx, null, { signedAt: tx.signedAt }, customerId);
    }
    if (ledger.earliest !== null) await queueRollup(db, app.id, dayOf(ledger.earliest));
    return { inserted, updated };
}

export const applyImportedTransactions = defineDbFunction("applyImportedTransactions", applyImportedTransactionsLocal);
