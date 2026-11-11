// App Store Server Notifications V2 / App Store Server API payloads (the fields Revflare uses).

export type AppleEnvironment = "Production" | "Sandbox" | "Xcode" | "LocalTesting";

export interface NotificationPayload {
  notificationType: string;
  subtype?: string;
  notificationUUID: string;
  version?: string;
  signedDate: number;
  data?: {
    appAppleId?: number;
    bundleId?: string;
    bundleVersion?: string;
    environment?: AppleEnvironment;
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
    status?: number;
    consumptionRequestReason?: string;
  };
  summary?: { bundleId?: string; environment?: AppleEnvironment; productId?: string; succeededCount?: number; failedCount?: number };
}

export interface TransactionInfo {
  transactionId: string;
  originalTransactionId: string;
  webOrderLineItemId?: string;
  bundleId: string;
  productId: string;
  subscriptionGroupIdentifier?: string;
  purchaseDate: number;
  originalPurchaseDate?: number;
  expiresDate?: number;
  quantity?: number;
  /** "Auto-Renewable Subscription" | "Non-Consumable" | "Consumable" | "Non-Renewing Subscription" */
  type: string;
  appAccountToken?: string;
  inAppOwnershipType?: "PURCHASED" | "FAMILY_SHARED";
  signedDate: number;
  revocationReason?: number;
  revocationDate?: number;
  /** Refunded share in milliunits (40000 = 40 %); present on refunded transactions, 100000 for a full refund. */
  revocationPercentage?: number;
  /** "REFUND_FULL" | "REFUND_PRORATED" | "FAMILY_REVOKE" | "ASSIGNMENT_REVOKE" */
  revocationType?: string;
  isUpgraded?: boolean;
  offerType?: number;
  offerIdentifier?: string;
  offerDiscountType?: string;
  offerPeriod?: string;
  environment: AppleEnvironment;
  storefront?: string;
  storefrontId?: string;
  transactionReason?: "PURCHASE" | "RENEWAL";
  /** Milliunits of `currency`. */
  price?: number;
  currency?: string;
}

export interface RenewalInfo {
  originalTransactionId: string;
  productId?: string;
  autoRenewProductId?: string;
  autoRenewStatus?: number;
  expirationIntent?: number;
  gracePeriodExpiresDate?: number;
  isInBillingRetryPeriod?: boolean;
  priceIncreaseStatus?: number;
  renewalDate?: number;
  renewalPrice?: number;
  currency?: string;
  recentSubscriptionStartDate?: number;
  signedDate: number;
  environment?: AppleEnvironment;
}

/** One verified Apple event, as handed to the database (worker/lib/ledger.ts). */
export interface AppleEvent {
  uid: string;
  source: "webhook" | "history" | "api";
  type: string;
  subtype: string | null;
  environment: string;
  signedAt: number;
  transaction: TransactionInfo | null;
  renewal: RenewalInfo | null;
  /** Subscription status from the Server API (1 active, 2 expired, 3 billing retry, 4 grace, 5 revoked). */
  status?: number | null;
  r2Key: string | null;
}
