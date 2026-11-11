// Google Play Developer API v3 and Real-time developer notification payloads (the fields Revflare uses).

/** google.type.Money */
export interface Money {
  currencyCode?: string;
  /** int64 as a string */
  units?: string | number;
  nanos?: number;
}

export interface SubscriptionPurchaseV2 {
  kind?: string;
  regionCode?: string;
  startTime?: string;
  subscriptionState?:
    | "SUBSCRIPTION_STATE_UNSPECIFIED"
    | "SUBSCRIPTION_STATE_PENDING"
    | "SUBSCRIPTION_STATE_ACTIVE"
    | "SUBSCRIPTION_STATE_PAUSED"
    | "SUBSCRIPTION_STATE_IN_GRACE_PERIOD"
    | "SUBSCRIPTION_STATE_ON_HOLD"
    | "SUBSCRIPTION_STATE_CANCELED"
    | "SUBSCRIPTION_STATE_EXPIRED"
    | "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED";
  linkedPurchaseToken?: string;
  pausedStateContext?: { autoResumeTime?: string };
  canceledStateContext?: {
    userInitiatedCancellation?: { cancelSurveyResult?: { reason?: string; reasonUserInput?: string }; cancelTime?: string };
    systemInitiatedCancellation?: Record<string, never>;
    developerInitiatedCancellation?: Record<string, never>;
    replacementCancellation?: Record<string, never>;
  };
  testPurchase?: Record<string, never>;
  acknowledgementState?: string;
  externalAccountIdentifiers?: { externalAccountId?: string; obfuscatedExternalAccountId?: string; obfuscatedExternalProfileId?: string };
  lineItems?: SubscriptionLineItem[];
  /** Deprecated: lineItems[].latestSuccessfulOrderId. */
  latestOrderId?: string;
}

export interface SubscriptionLineItem {
  productId: string;
  expiryTime?: string;
  latestSuccessfulOrderId?: string;
  autoRenewingPlan?: { autoRenewEnabled?: boolean; recurringPrice?: Money };
  prepaidPlan?: { allowExtendAfterTime?: string };
  offerDetails?: { offerTags?: string[]; basePlanId?: string; offerId?: string };
  offerPhase?: { freeTrial?: object; introductoryPrice?: object; basePrice?: object; prorationPeriod?: { originalOfferPhaseType?: string } };
}

export interface ProductPurchaseV2 {
  kind?: string;
  productLineItem?: { productId: string; productOfferDetails?: { offerId?: string; purchaseOptionId?: string; quantity?: number; refundableQuantity?: number } }[];
  purchaseStateContext?: { purchaseState?: "PURCHASE_STATE_UNSPECIFIED" | "PURCHASED" | "CANCELLED" | "PENDING" };
  testPurchaseContext?: { fopType?: string };
  orderId?: string;
  obfuscatedExternalAccountId?: string;
  obfuscatedExternalProfileId?: string;
  regionCode?: string;
  purchaseCompletionTime?: string;
  acknowledgementState?: string;
}

export interface RefundDetails {
  total?: Money;
  tax?: Money;
}

export interface Order {
  orderId: string;
  purchaseToken?: string;
  state?: "STATE_UNSPECIFIED" | "PENDING" | "PROCESSED" | "CANCELED" | "PENDING_REFUND" | "PARTIALLY_REFUNDED" | "REFUNDED";
  createTime?: string;
  lastEventTime?: string;
  buyerAddress?: { buyerState?: string; buyerCountry?: string; buyerPostcode?: string };
  total?: Money;
  tax?: Money;
  orderDetails?: { taxInclusive?: boolean };
  developerRevenueInBuyerCurrency?: Money;
  lineItems?: {
    productId?: string;
    productTitle?: string;
    listingPrice?: Money;
    total?: Money;
    tax?: Money;
    oneTimePurchaseDetails?: { quantity?: number; offerId?: string; purchaseOptionId?: string };
    subscriptionDetails?: {
      basePlanId?: string;
      offerId?: string;
      offerPhase?: string;
      offerPhaseDetails?: { freeTrialDetails?: object; introductoryPriceDetails?: object; baseDetails?: object; prorationPeriodDetails?: { originalOfferPhase?: string } };
      servicePeriodStartTime?: string;
      servicePeriodEndTime?: string;
    };
  }[];
  orderHistory?: {
    processedEvent?: { eventTime?: string };
    cancellationEvent?: { eventTime?: string };
    refundEvent?: { eventTime?: string; refundDetails?: RefundDetails; refundReason?: string };
    partialRefundEvents?: { createTime?: string; processTime?: string; state?: string; refundDetails?: RefundDetails }[];
  };
}

export interface VoidedPurchase {
  kind?: string;
  purchaseToken?: string;
  orderId?: string;
  purchaseTimeMillis?: string;
  voidedTimeMillis?: string;
  /** 0 Other, 1 Remorse, 2 Not_received, 3 Defective, 4 Accidental_purchase, 5 Fraud, 6 Friendly_fraud, 7 Chargeback, 8 Unacknowledged_purchase */
  voidedReason?: number;
  /** 0 User, 1 Developer, 2 Google */
  voidedSource?: number;
  voidedQuantity?: number;
}

/** The decoded `message.data` of an RTDN Pub/Sub push. */
export interface DeveloperNotification {
  version?: string;
  packageName?: string;
  eventTimeMillis?: string | number;
  subscriptionNotification?: { version?: string; notificationType: number; purchaseToken: string; subscriptionId?: string };
  oneTimeProductNotification?: { version?: string; notificationType: number; purchaseToken: string; sku?: string };
  voidedPurchaseNotification?: { purchaseToken: string; orderId: string; productType?: number; refundType?: number };
  pendingRefundReviewNotification?: Record<string, unknown>;
  testNotification?: { version?: string };
}

export const SUBSCRIPTION_NOTIFICATION_TYPES: Record<number, string> = {
  1: "SUBSCRIPTION_RECOVERED",
  2: "SUBSCRIPTION_RENEWED",
  3: "SUBSCRIPTION_CANCELED",
  4: "SUBSCRIPTION_PURCHASED",
  5: "SUBSCRIPTION_ON_HOLD",
  6: "SUBSCRIPTION_IN_GRACE_PERIOD",
  7: "SUBSCRIPTION_RESTARTED",
  8: "SUBSCRIPTION_PRICE_CHANGE_CONFIRMED",
  9: "SUBSCRIPTION_DEFERRED",
  10: "SUBSCRIPTION_PAUSED",
  11: "SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED",
  12: "SUBSCRIPTION_REVOKED",
  13: "SUBSCRIPTION_EXPIRED",
  17: "SUBSCRIPTION_ITEMS_CHANGED",
  18: "SUBSCRIPTION_CANCELLATION_SCHEDULED",
  19: "SUBSCRIPTION_PRICE_CHANGE_UPDATED",
  20: "SUBSCRIPTION_PENDING_PURCHASE_CANCELED",
  22: "SUBSCRIPTION_PRICE_STEP_UP_CONSENT_UPDATED",
};

export const ONE_TIME_NOTIFICATION_TYPES: Record<number, string> = { 1: "ONE_TIME_PRODUCT_PURCHASED", 2: "ONE_TIME_PRODUCT_CANCELED" };
