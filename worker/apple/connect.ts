// App Store Connect API (team API key): apps, their notification URLs, in-app purchase / subscription names and
// periods, and Sales and Trends reports (reconciliation).
// https://developer.apple.com/documentation/appstoreconnectapi

import { es256Jwt } from "../lib/crypto";
import type { Credential } from "../lib/credentials";

const BASE = "https://api.appstoreconnect.apple.com";

export interface AscApp {
  id: string;
  name: string;
  bundleId: string;
  subscriptionStatusUrl: string | null;
  subscriptionStatusUrlVersion: string | null;
  subscriptionStatusUrlForSandbox: string | null;
}

export interface AscProduct {
  productId: string;
  name: string;
  type: "auto_renewable" | "non_consumable" | "consumable" | "non_renewing";
  period: string | null;
  group: string | null;
}

const PERIODS: Record<string, string> = {
  ONE_WEEK: "P1W",
  ONE_MONTH: "P1M",
  TWO_MONTHS: "P2M",
  THREE_MONTHS: "P3M",
  SIX_MONTHS: "P6M",
  ONE_YEAR: "P1Y",
};

const IAP_TYPES: Record<string, AscProduct["type"]> = {
  CONSUMABLE: "consumable",
  NON_CONSUMABLE: "non_consumable",
  NON_RENEWING_SUBSCRIPTION: "non_renewing",
};

export class AscError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AscError";
  }
}

export class AppStoreConnectApi {
  private token: { value: string; exp: number } | null = null;

  constructor(
    private readonly credential: Credential,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {
    if (!credential.keyId || !credential.issuerId || !credential.secret.privateKey) throw new Error("The App Store Connect API key is incomplete");
  }

  private async jwt(): Promise<string> {
    const t = Math.floor(Date.now() / 1000);
    if (this.token && this.token.exp - 60 > t) return this.token.value;
    const exp = t + 15 * 60;
    const value = await es256Jwt(this.credential.secret.privateKey!, { kid: this.credential.keyId }, { iss: this.credential.issuerId, iat: t, exp, aud: "appstoreconnect-v1" });
    this.token = { value, exp };
    return value;
  }

  async request(method: string, path: string, body?: unknown, accept?: string): Promise<Response> {
    const res = await this.fetcher(path.startsWith("http") ? path : BASE + path, {
      method,
      headers: { authorization: `Bearer ${await this.jwt()}`, ...(body ? { "content-type": "application/json" } : {}), ...(accept ? { accept } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { errors?: { detail?: string; title?: string }[] };
        detail = j.errors?.map((e) => e.detail ?? e.title).join("; ") || detail;
      } catch {}
      throw new AscError(`App Store Connect API ${res.status}: ${detail}`, res.status);
    }
    return res;
  }

  private async json<T>(path: string): Promise<T | null> {
    const res = await this.request("GET", path);
    if (res.status === 404) return null;
    return (await res.json()) as T;
  }

  async listApps(): Promise<AscApp[]> {
    const out: AscApp[] = [];
    let next: string | null =
      "/v1/apps?limit=200&fields[apps]=name,bundleId,subscriptionStatusUrl,subscriptionStatusUrlVersion,subscriptionStatusUrlForSandbox";
    while (next) {
      const page: { data: { id: string; attributes: Record<string, string | null> }[]; links?: { next?: string } } | null = await this.json(next);
      for (const a of page?.data ?? []) {
        out.push({
          id: a.id,
          name: a.attributes.name ?? a.id,
          bundleId: a.attributes.bundleId ?? "",
          subscriptionStatusUrl: a.attributes.subscriptionStatusUrl ?? null,
          subscriptionStatusUrlVersion: a.attributes.subscriptionStatusUrlVersion ?? null,
          subscriptionStatusUrlForSandbox: a.attributes.subscriptionStatusUrlForSandbox ?? null,
        });
      }
      next = page?.links?.next ?? null;
    }
    return out;
  }

  /** Points the app's App Store Server Notifications (V2) to `url` (production and sandbox). */
  async setNotificationUrl(appId: string, url: string, sandboxUrl: string = url): Promise<void> {
    await this.request("PATCH", `/v1/apps/${appId}`, {
      data: {
        type: "apps",
        id: appId,
        attributes: {
          subscriptionStatusUrl: url,
          subscriptionStatusUrlVersion: "V2",
          subscriptionStatusUrlForSandbox: sandboxUrl,
          subscriptionStatusUrlVersionForSandbox: "V2",
        },
      },
    });
  }

  /** In-app purchases and subscriptions of an app, with their names and billing periods. */
  async listProducts(appId: string): Promise<AscProduct[]> {
    const out: AscProduct[] = [];
    const iaps = await this.json<{ data: { attributes: { productId: string; name: string; inAppPurchaseType: string } }[] }>(
      `/v1/apps/${appId}/inAppPurchasesV2?limit=200&fields[inAppPurchases]=productId,name,inAppPurchaseType`,
    );
    for (const i of iaps?.data ?? []) {
      out.push({ productId: i.attributes.productId, name: i.attributes.name, type: IAP_TYPES[i.attributes.inAppPurchaseType] ?? "non_consumable", period: null, group: null });
    }
    const groups = await this.json<{
      data: { id: string; attributes: { referenceName: string } }[];
      included?: { type: string; attributes: { productId: string; name: string; subscriptionPeriod?: string }; relationships?: unknown }[];
    }>(`/v1/apps/${appId}/subscriptionGroups?limit=50&include=subscriptions&fields[subscriptions]=productId,name,subscriptionPeriod&limit[subscriptions]=50`);
    for (const s of groups?.included ?? []) {
      if (s.type !== "subscriptions") continue;
      out.push({ productId: s.attributes.productId, name: s.attributes.name, type: "auto_renewable", period: PERIODS[s.attributes.subscriptionPeriod ?? ""] ?? null, group: null });
    }
    return out;
  }

  /**
   * Promotional and win-back offers of the app's subscriptions (at most `maxSubscriptions` subscriptions: 2 requests
   * each). Promotional offers: `offerCode` is the identifier StoreKit uses; win-back offers: `offerId`.
   */
  async listSubscriptionOffers(
    appId: string,
    maxSubscriptions = 15,
  ): Promise<{ offers: { productId: string; offerId: string; name: string | null; kind: "promotional" | "win_back" }[]; truncated: boolean }> {
    const groups = await this.json<{ included?: { type: string; id: string; attributes: { productId: string } }[] }>(
      `/v1/apps/${appId}/subscriptionGroups?limit=50&include=subscriptions&fields[subscriptions]=productId&limit[subscriptions]=50`,
    );
    const subs = (groups?.included ?? []).filter((s) => s.type === "subscriptions");
    const offers: { productId: string; offerId: string; name: string | null; kind: "promotional" | "win_back" }[] = [];
    for (const s of subs.slice(0, maxSubscriptions)) {
      const id = encodeURIComponent(s.id);
      const promo = await this.json<{ data: { attributes: { name?: string; offerCode?: string } }[] }>(
        `/v1/subscriptions/${id}/promotionalOffers?limit=200&fields[subscriptionPromotionalOffers]=name,offerCode`,
      );
      for (const o of promo?.data ?? []) if (o.attributes.offerCode) offers.push({ productId: s.attributes.productId, offerId: o.attributes.offerCode, name: o.attributes.name ?? null, kind: "promotional" });
      const winBack = await this.json<{ data: { attributes: { referenceName?: string; offerId?: string } }[] }>(
        `/v1/subscriptions/${id}/winBackOffers?limit=200&fields[winBackOffers]=referenceName,offerId`,
      );
      for (const o of winBack?.data ?? []) if (o.attributes.offerId) offers.push({ productId: s.attributes.productId, offerId: o.attributes.offerId, name: o.attributes.referenceName ?? null, kind: "win_back" });
    }
    return { offers, truncated: subs.length > maxSubscriptions };
  }

  /**
   * Daily Sales and Trends summary report (tab-separated rows), or null when Apple has none for that day (yet).
   * Reports for a day are available the next day around 08:00 Pacific.
   */
  async dailySalesReport(vendorNumber: string, day: string): Promise<Record<string, string>[] | null> {
    const q = new URLSearchParams({
      "filter[frequency]": "DAILY",
      "filter[reportType]": "SALES",
      "filter[reportSubType]": "SUMMARY",
      "filter[vendorNumber]": vendorNumber,
      "filter[reportDate]": day,
      "filter[version]": "1_1",
    });
    // Reports are gzip files: any other Accept (application/json included) gets 406.
    const res = await this.request("GET", `/v1/salesReports?${q}`, undefined, "application/a-gzip");
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    const text = await gunzipText(res);
    return parseTsv(text);
  }

  // Analytics Reports API (App Analytics) ------------------------------------------------------------------------
  // https://developer.apple.com/documentation/appstoreconnectapi/analytics
  // Creating requests needs the Admin role; listing and downloading reports also works with Sales and Reports / Finance.

  /** The app's ONGOING report requests (Apple keeps one per app). */
  async listAnalyticsReportRequests(appleAppId: string): Promise<AnalyticsRequest[]> {
    const page = await this.json<{ data: { id: string; attributes?: { accessType?: string; stoppedDueToInactivity?: boolean } }[] }>(
      `/v1/apps/${encodeURIComponent(appleAppId)}/analyticsReportRequests?filter[accessType]=ONGOING&fields[analyticsReportRequests]=accessType,stoppedDueToInactivity&limit=50`,
    );
    return (page?.data ?? []).map((r) => ({ id: r.id, accessType: r.attributes?.accessType ?? "ONGOING", stopped: !!r.attributes?.stoppedDueToInactivity }));
  }

  /** One report request (null when Apple no longer has it). */
  async getAnalyticsReportRequest(id: string): Promise<AnalyticsRequest | null> {
    const r = await this.json<{ data: { id: string; attributes?: { accessType?: string; stoppedDueToInactivity?: boolean } } }>(
      `/v1/analyticsReportRequests/${encodeURIComponent(id)}?fields[analyticsReportRequests]=accessType,stoppedDueToInactivity`,
    );
    return r ? { id: r.data.id, accessType: r.data.attributes?.accessType ?? "ONGOING", stopped: !!r.data.attributes?.stoppedDueToInactivity } : null;
  }

  /** Asks Apple to produce reports for the app every day (first ones after 1–2 days). Returns the request id. */
  async createAnalyticsReportRequest(appleAppId: string, accessType: "ONGOING" | "ONE_TIME_SNAPSHOT" = "ONGOING"): Promise<string> {
    const res = await this.request("POST", "/v1/analyticsReportRequests", {
      data: { type: "analyticsReportRequests", attributes: { accessType }, relationships: { app: { data: { type: "apps", id: appleAppId } } } },
    });
    if (res.status === 404) throw new AscError(`App Store Connect API 404: app ${appleAppId} not found`, 404);
    return ((await res.json()) as { data: { id: string } }).data.id;
  }

  /** Reports Apple produces for a request (App Store engagement and commerce ones); null when the request is gone. */
  async listAnalyticsReports(requestId: string): Promise<{ id: string; name: string; category: string }[] | null> {
    const out: { id: string; name: string; category: string }[] = [];
    let next: string | null =
      `/v1/analyticsReportRequests/${encodeURIComponent(requestId)}/reports?filter[category]=APP_STORE_ENGAGEMENT,COMMERCE&fields[analyticsReports]=name,category&limit=200`;
    for (let i = 0; next && i < 5; i++) {
      const page: { data: { id: string; attributes?: { name?: string; category?: string } }[]; links?: { next?: string } } | null = await this.json(next);
      if (!page) return i ? out : null;
      for (const r of page.data) out.push({ id: r.id, name: r.attributes?.name ?? "", category: r.attributes?.category ?? "" });
      next = page.links?.next ?? null;
    }
    return out;
  }

  /** Daily instances of a report (one per processing date). */
  async listAnalyticsInstances(reportId: string, maxPages = 3): Promise<{ id: string; processingDate: string }[]> {
    const out: { id: string; processingDate: string }[] = [];
    let next: string | null =
      `/v1/analyticsReports/${encodeURIComponent(reportId)}/instances?filter[granularity]=DAILY&fields[analyticsReportInstances]=granularity,processingDate&limit=200`;
    for (let i = 0; next && i < maxPages; i++) {
      const page: { data: { id: string; attributes?: { processingDate?: string } }[]; links?: { next?: string } } | null = await this.json(next);
      for (const r of page?.data ?? []) if (r.attributes?.processingDate) out.push({ id: r.id, processingDate: r.attributes.processingDate });
      next = page?.links?.next ?? null;
    }
    return out;
  }

  /** The files of an instance. Their URLs are signed and valid for 5 minutes: download right away. */
  async listAnalyticsSegments(instanceId: string): Promise<{ id: string; url: string; sizeInBytes: number | null }[]> {
    const page = await this.json<{ data: { id: string; attributes?: { url?: string; sizeInBytes?: number } }[] }>(
      `/v1/analyticsReportInstances/${encodeURIComponent(instanceId)}/segments?fields[analyticsReportSegments]=url,sizeInBytes,checksum&limit=200`,
    );
    return (page?.data ?? []).filter((s) => s.attributes?.url).map((s) => ({ id: s.id, url: s.attributes!.url!, sizeInBytes: s.attributes?.sizeInBytes ?? null }));
  }

  /** Downloads a segment (signed URL: no Authorization header). The body is gzip'd tab-separated text. */
  async downloadSegment(url: string): Promise<Response> {
    const res = await this.fetcher(url, { method: "GET" });
    if (!res.ok) {
      await res.body?.cancel();
      throw new AscError(`Report download ${res.status}`, res.status);
    }
    return res;
  }
}

export interface AnalyticsRequest {
  id: string;
  accessType: string;
  stopped: boolean;
}

/** The response body as text lines, gunzipped when it is gzip (checked by its magic number). */
export async function* responseLines(res: Response): AsyncGenerator<string> {
  const buf = new Uint8Array(await res.arrayBuffer());
  const gz = buf[0] === 0x1f && buf[1] === 0x8b;
  let stream: ReadableStream<Uint8Array> = new Blob([buf]).stream();
  if (gz) stream = stream.pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let rest = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += value;
    const parts = rest.split(/\r?\n/);
    rest = parts.pop() ?? "";
    for (const p of parts) yield p;
  }
  if (rest) yield rest;
}

async function gunzipText(res: Response): Promise<string> {
  const buf = new Uint8Array(await res.arrayBuffer());
  // gzip magic number
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(buf);
}

export function parseTsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split("\t").map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const cells = l.split("\t");
    return Object.fromEntries(head.map((h, i) => [h, (cells[i] ?? "").trim()]));
  });
}

/** App icons from the public iTunes lookup API (no auth), by App Store id. */
export async function lookupIcons(appleIds: string[], fetcher: typeof fetch = fetch): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < appleIds.length; i += 100) {
    const ids = appleIds.slice(i, i + 100).join(",");
    const res = await fetcher(`https://itunes.apple.com/lookup?id=${ids}&entity=software`);
    if (!res.ok) continue;
    const j = (await res.json()) as { results?: { trackId?: number; artworkUrl512?: string; artworkUrl100?: string }[] };
    for (const r of j.results ?? []) if (r.trackId) out[String(r.trackId)] = r.artworkUrl512 ?? r.artworkUrl100 ?? "";
  }
  return out;
}
