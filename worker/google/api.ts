// Google Play Developer API v3 client (read-only calls): subscriptionsv2 / productsv2 purchase state, the Orders API
// (prices, taxes, proceeds, refunds) and voided purchases. https://developers.google.com/android-publisher

import { accessToken, type ServiceAccount } from "./auth";
import type { Order, ProductPurchaseV2, SubscriptionPurchaseV2, VoidedPurchase } from "./types";

export const PUBLISHER = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

export class GooglePlayApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string | null = null,
  ) {
    super(message);
  }
}

export class GooglePlayApi {
  /** Requests made (callers cap their subrequests). */
  requests = 0;

  constructor(
    private readonly sa: ServiceAccount,
    readonly packageName: string,
  ) {}

  private async get<T>(path: string, query?: URLSearchParams): Promise<T> {
    const token = await accessToken(this.sa);
    this.requests++;
    const url = `${PUBLISHER}/${encodeURIComponent(this.packageName)}${path}${query && [...query.keys()].length ? `?${query}` : ""}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      let reason: string | null = null;
      try {
        const e = (JSON.parse(text) as { error?: { message?: string; status?: string; errors?: { reason?: string }[] } }).error;
        message = e?.message ?? message;
        reason = e?.errors?.[0]?.reason ?? e?.status ?? null;
      } catch {}
      throw new GooglePlayApiError(`Google Play API ${res.status}: ${message}`, res.status, reason);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  subscription(token: string): Promise<SubscriptionPurchaseV2> {
    return this.get(`/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`);
  }

  product(token: string): Promise<ProductPurchaseV2> {
    return this.get(`/purchases/productsv2/tokens/${encodeURIComponent(token)}`);
  }

  order(orderId: string): Promise<Order> {
    return this.get(`/orders/${encodeURIComponent(orderId)}`);
  }

  /** At most 1000 distinct ids; the whole call fails when one of them is unknown. */
  async orders(orderIds: string[]): Promise<Order[]> {
    const ids = [...new Set(orderIds)].slice(0, 1000);
    if (!ids.length) return [];
    if (ids.length === 1) return [await this.order(ids[0])];
    const q = new URLSearchParams();
    for (const id of ids) q.append("orderIds", id);
    const r = await this.get<{ orders?: Order[] }>("/orders:batchGet", q);
    return r.orders ?? [];
  }

  /** Voided purchases (subscriptions included, type=1) seen voided since `startTime` (≤ 30 days ago). */
  voided(startTime: number, endTime: number, pageToken?: string): Promise<{ voidedPurchases?: VoidedPurchase[]; tokenPagination?: { nextPageToken?: string } }> {
    const q = new URLSearchParams({ type: "1", "pageSelection.maxResults": "1000" });
    if (pageToken) q.set("pageSelection.token", pageToken);
    else {
      q.set("startTime", String(startTime));
      q.set("endTime", String(endTime));
    }
    return this.get("/purchases/voidedpurchases", q);
  }
}
