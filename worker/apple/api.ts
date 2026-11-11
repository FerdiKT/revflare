// App Store Server API client (In-App Purchase key, ES256 JWT).
// https://developer.apple.com/documentation/appstoreserverapi

import { es256Jwt } from "../lib/crypto";
import type { Credential } from "../lib/credentials";

export const SERVER_API = {
  Production: "https://api.storekit.itunes.apple.com",
  Sandbox: "https://api.storekit-sandbox.itunes.apple.com",
} as const;

export type ServerEnvironment = keyof typeof SERVER_API;

export class AppleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "AppleApiError";
  }
}

export interface NotificationHistoryPage {
  notificationHistory: { signedPayload: string; sendAttempts?: { attemptDate: number; sendAttemptResult: string }[] }[];
  hasMore: boolean;
  paginationToken?: string;
}

export interface TransactionHistoryPage {
  signedTransactions: string[];
  revision?: string;
  hasMore: boolean;
  bundleId?: string;
  appAppleId?: number;
  environment?: string;
}

export interface SubscriptionStatuses {
  environment?: string;
  bundleId?: string;
  data: {
    subscriptionGroupIdentifier: string;
    lastTransactions: { originalTransactionId: string; status: number; signedTransactionInfo: string; signedRenewalInfo: string }[];
  }[];
}

/** ConsumptionRequest (v2) body of Send Consumption Information. */
export interface ConsumptionRequestBody {
  /** Must be true: Apple answers 400 otherwise. */
  customerConsented: true;
  deliveryStatus: "DELIVERED" | "UNDELIVERED_QUALITY_ISSUE" | "UNDELIVERED_WRONG_ITEM" | "UNDELIVERED_SERVER_OUTAGE" | "UNDELIVERED_OTHER";
  sampleContentProvided: boolean;
  /** Optional. GRANT_PRORATED: no consumptionPercentage for auto-renewable subscriptions (Apple computes it). */
  refundPreference?: "DECLINE" | "GRANT_FULL" | "GRANT_PRORATED";
  /** Milliunits (0-100000). Never for auto-renewable subscriptions; 0 unless DELIVERED. */
  consumptionPercentage?: number;
}

export class AppStoreServerApi {
  private token: { value: string; exp: number } | null = null;

  constructor(
    private readonly credential: Credential,
    private readonly bundleId: string,
    readonly environment: ServerEnvironment = "Production",
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {
    if (!credential.keyId || !credential.issuerId || !credential.secret.privateKey) throw new Error("The In-App Purchase key is incomplete");
  }

  private async jwt(): Promise<string> {
    const t = Math.floor(Date.now() / 1000);
    if (this.token && this.token.exp - 60 > t) return this.token.value;
    const exp = t + 30 * 60;
    const value = await es256Jwt(
      this.credential.secret.privateKey!,
      { kid: this.credential.keyId },
      { iss: this.credential.issuerId, iat: t, exp, aud: "appstoreconnect-v1", bid: this.bundleId },
    );
    this.token = { value, exp };
    return value;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { text } = await this.send(method, path, body);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** One request; throws AppleApiError for non-2xx answers. */
  private async send(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
    const res = await this.fetcher(SERVER_API[this.environment] + path, {
      method,
      headers: { authorization: `Bearer ${await this.jwt()}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let code: number | undefined;
      let message = text.slice(0, 300) || res.statusText;
      try {
        const j = JSON.parse(text) as { errorCode?: number; errorMessage?: string };
        code = j.errorCode;
        message = j.errorMessage ?? message;
      } catch {}
      if (res.status === 401) message = "Apple rejected the In-App Purchase key (check key id, issuer id and the .p8 file)";
      const retryAfter = Number(res.headers.get("retry-after")) || undefined;
      throw new AppleApiError(`App Store Server API ${res.status}: ${message}`, res.status, code, retryAfter);
    }
    return { status: res.status, text };
  }

  /** Notifications Apple sent (or tried to send) in [start, end) — at most the last 180 days. */
  notificationHistory(start: number, end: number, paginationToken?: string): Promise<NotificationHistoryPage> {
    const q = paginationToken ? `?paginationToken=${encodeURIComponent(paginationToken)}` : "";
    return this.request("POST", `/inApps/v1/notifications/history${q}`, { startDate: start, endDate: end });
  }

  /** All transactions of the customer who made `transactionId` (any of their transactions), oldest first. */
  transactionHistory(transactionId: string, revision?: string): Promise<TransactionHistoryPage> {
    const q = new URLSearchParams({ sort: "ASCENDING" });
    if (revision) q.set("revision", revision);
    return this.request("GET", `/inApps/v2/history/${encodeURIComponent(transactionId)}?${q}`);
  }

  subscriptionStatuses(transactionId: string): Promise<SubscriptionStatuses> {
    return this.request("GET", `/inApps/v1/subscriptions/${encodeURIComponent(transactionId)}`);
  }

  /** Send Consumption Information (v2) for a CONSUMPTION_REQUEST: Apple answers 202 Accepted with no body. */
  sendConsumptionInformation(transactionId: string, body: ConsumptionRequestBody): Promise<{ status: number; text: string }> {
    return this.send("PUT", `/inApps/v2/transactions/consumption/${encodeURIComponent(transactionId)}`, body);
  }

  requestTestNotification(): Promise<{ testNotificationToken: string }> {
    return this.request("POST", "/inApps/v1/notifications/test");
  }

  testNotificationStatus(token: string): Promise<{ signedPayload?: string; sendAttempts?: { attemptDate: number; sendAttemptResult: string }[] }> {
    return this.request("GET", `/inApps/v1/notifications/test/${encodeURIComponent(token)}`);
  }
}
