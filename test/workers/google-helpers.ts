// A fake Google (OAuth token endpoint, Play Developer API, OIDC certificates) for the Google Play integration tests.
// Every value is synthetic (com.example.* packages, made-up order ids and tokens).
import { fetchMock } from "cloudflare:test";
import { forgetGoogleTokens } from "../../worker/google/auth";
import { forgetGoogleJwks } from "../../worker/google/oidc";
import type { Order, ProductPurchaseV2, SubscriptionPurchaseV2, VoidedPurchase } from "../../worker/google/types";

export const DAY = 86_400_000;

const b64url = (bytes: ArrayBuffer | Uint8Array | string) => {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" } as const;

export async function rsaKeyPair() {
  return (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
}

export async function pkcs8Pem(key: CryptoKey): Promise<string> {
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", key)) as ArrayBuffer);
  let s = "";
  for (const x of der) s += String.fromCharCode(x);
  const b64 = btoa(s).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

/** A synthetic service account JSON key file. */
export async function serviceAccountJson(email = "revflare-test@example-project.iam.gserviceaccount.com") {
  const pair = await rsaKeyPair();
  const json = {
    type: "service_account",
    project_id: "example-project",
    private_key_id: "0123456789abcdef0123456789abcdef01234567",
    private_key: await pkcs8Pem(pair.privateKey),
    client_email: email,
    client_id: "100000000000000000001",
    token_uri: "https://oauth2.googleapis.com/token",
  };
  return { json: JSON.stringify(json), publicKey: pair.publicKey };
}

export async function signJwt(key: CryptoKey, header: Record<string, unknown>, claims: Record<string, unknown>): Promise<string> {
  const h = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", ...header }));
  const p = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

export const money = (amount: number, currencyCode = "USD") => {
  const units = Math.floor(amount);
  return { currencyCode, units: String(units), nanos: Math.round((amount - units) * 1e9) };
};

export const iso = (ms: number) => new Date(ms).toISOString();

/** A Play order. phase: free (free trial), intro, base. */
export function playOrder(
  orderId: string,
  o: {
    start: number;
    end?: number;
    price: number;
    currency?: string;
    phase?: "free" | "intro" | "base";
    productId?: string;
    basePlanId?: string;
    country?: string;
    revenue?: number;
    state?: Order["state"];
    refundAt?: number;
    partial?: { amount: number; at: number }[];
    oneTime?: boolean;
    token?: string;
  },
): Order {
  const currency = o.currency ?? "USD";
  const phase = o.phase ?? "base";
  return {
    orderId,
    purchaseToken: o.token,
    state: o.state ?? "PROCESSED",
    createTime: iso(o.start),
    lastEventTime: iso(o.refundAt ?? o.partial?.[o.partial.length - 1]?.at ?? o.start),
    buyerAddress: { buyerCountry: o.country ?? "US" },
    total: money(o.price, currency),
    tax: money(0, currency),
    orderDetails: { taxInclusive: true },
    developerRevenueInBuyerCurrency: money(o.revenue ?? Math.round(o.price * 85) / 100, currency),
    lineItems: [
      o.oneTime
        ? { productId: o.productId ?? "coins_100", productTitle: "100 coins (Example)", total: money(o.price, currency), oneTimePurchaseDetails: { quantity: 1 } }
        : {
            productId: o.productId ?? "premium",
            productTitle: "Premium (Example)",
            total: money(o.price, currency),
            subscriptionDetails: {
              basePlanId: o.basePlanId ?? "monthly",
              offerId: phase === "base" ? undefined : `${phase}-offer`,
              offerPhaseDetails: phase === "free" ? { freeTrialDetails: {} } : phase === "intro" ? { introductoryPriceDetails: {} } : { baseDetails: {} },
              servicePeriodStartTime: iso(o.start),
              servicePeriodEndTime: iso(o.end ?? o.start + 30 * DAY),
            },
          },
    ],
    orderHistory: {
      processedEvent: { eventTime: iso(o.start) },
      ...(o.refundAt ? { refundEvent: { eventTime: iso(o.refundAt), refundDetails: { total: money(o.price, currency) } } } : {}),
      ...(o.partial ? { partialRefundEvents: o.partial.map((p) => ({ createTime: iso(p.at), processTime: iso(p.at), state: "PROCESSED_SUCCESSFULLY", refundDetails: { total: money(p.amount, currency) } })) } : {}),
    },
  };
}

export function playSubscription(
  o: {
    state?: SubscriptionPurchaseV2["subscriptionState"];
    orderId: string;
    expiry: number;
    start?: number;
    productId?: string;
    basePlanId?: string;
    autoRenew?: boolean;
    phase?: "free" | "intro" | "base";
    installId?: string;
    linked?: string;
    test?: boolean;
    cancel?: SubscriptionPurchaseV2["canceledStateContext"];
    price?: number;
  },
): SubscriptionPurchaseV2 {
  const phase = o.phase ?? "base";
  return {
    kind: "androidpublisher#subscriptionPurchaseV2",
    regionCode: "US",
    startTime: iso(o.start ?? o.expiry - 30 * DAY),
    subscriptionState: o.state ?? "SUBSCRIPTION_STATE_ACTIVE",
    ...(o.linked ? { linkedPurchaseToken: o.linked } : {}),
    ...(o.test ? { testPurchase: {} } : {}),
    ...(o.cancel ? { canceledStateContext: o.cancel } : {}),
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    ...(o.installId ? { externalAccountIdentifiers: { obfuscatedExternalAccountId: o.installId } } : {}),
    lineItems: [
      {
        productId: o.productId ?? "premium",
        expiryTime: iso(o.expiry),
        latestSuccessfulOrderId: o.orderId,
        autoRenewingPlan: { autoRenewEnabled: o.autoRenew ?? true, recurringPrice: money(o.price ?? 9.99) },
        offerDetails: { basePlanId: o.basePlanId ?? "monthly", ...(phase !== "base" ? { offerId: `${phase}-offer` } : {}) },
        offerPhase: phase === "free" ? { freeTrial: {} } : phase === "intro" ? { introductoryPrice: {} } : { basePrice: {} },
      },
    ],
  };
}

/** In-memory Play backend answering the Developer API, plus Google's token endpoint and certificates. */
export class FakeGoogle {
  subs = new Map<string, SubscriptionPurchaseV2>();
  products = new Map<string, ProductPurchaseV2>();
  orders = new Map<string, Order>();
  voided: VoidedPurchase[] = [];
  tokenRequests: { body: string }[] = [];
  apiCalls: string[] = [];
  jwks: object[] = [];
  /** Requests for Google's OIDC certificates. */
  jwksFetches = 0;
  /** HTTP status forced for the Orders API (e.g. 403: no financial permission). */
  ordersStatus = 200;

  install() {
    forgetGoogleTokens();
    forgetGoogleJwks();
    fetchMock
      .get("https://oauth2.googleapis.com")
      .intercept({ path: "/token", method: "POST" })
      .reply((opts) => {
        this.tokenRequests.push({ body: String(opts.body) });
        return { statusCode: 200, data: JSON.stringify({ access_token: "ya29.example-access-token", expires_in: 3599, token_type: "Bearer" }), responseOptions: { headers: { "content-type": "application/json" } } };
      })
      .persist();
    fetchMock
      .get("https://www.googleapis.com")
      .intercept({ path: "/oauth2/v3/certs", method: "GET" })
      .reply(() => ({ statusCode: 200, data: JSON.stringify({ keys: (this.jwksFetches++, this.jwks) }), responseOptions: { headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" } } }))
      .persist();
    fetchMock
      .get("https://androidpublisher.googleapis.com")
      .intercept({ path: (p: string) => p.startsWith("/androidpublisher/v3/applications/"), method: "GET" })
      .reply((opts) => {
        const auth = (opts.headers as Record<string, string>)?.authorization ?? (opts.headers as Record<string, string>)?.Authorization;
        if (auth !== "Bearer ya29.example-access-token") return this.json(401, { error: { code: 401, message: "Request had invalid authentication credentials." } });
        return this.handle(String(opts.path));
      })
      .persist();
  }

  private json(statusCode: number, body: unknown) {
    return { statusCode, data: JSON.stringify(body), responseOptions: { headers: { "content-type": "application/json" } } };
  }

  private notFound(what: string) {
    return this.json(404, { error: { code: 404, message: `${what} not found`, status: "NOT_FOUND" } });
  }

  handle(path: string) {
    const url = new URL(`https://androidpublisher.googleapis.com${path}`);
    const rest = decodeURIComponent(url.pathname).replace(/^\/androidpublisher\/v3\/applications\/[^/]+/, "");
    this.apiCalls.push(rest + url.search);
    let m: RegExpExecArray | null;
    if ((m = /^\/purchases\/subscriptionsv2\/tokens\/(.+)$/.exec(rest))) return this.subs.has(m[1]) ? this.json(200, this.subs.get(m[1])) : this.notFound("Purchase");
    if ((m = /^\/purchases\/productsv2\/tokens\/(.+)$/.exec(rest))) return this.products.has(m[1]) ? this.json(200, this.products.get(m[1])) : this.notFound("Purchase");
    if (rest === "/purchases/voidedpurchases") return this.json(200, { voidedPurchases: this.voided });
    if (rest === "/orders:batchGet") {
      if (this.ordersStatus !== 200) return this.json(this.ordersStatus, { error: { code: this.ordersStatus, message: "The caller does not have permission" } });
      const ids = url.searchParams.getAll("orderIds");
      if (ids.some((id) => !this.orders.has(id))) return this.notFound("Order");
      return this.json(200, { orders: ids.map((id) => this.orders.get(id)) });
    }
    if ((m = /^\/orders\/(.+)$/.exec(rest))) {
      if (this.ordersStatus !== 200) return this.json(this.ordersStatus, { error: { code: this.ordersStatus, message: "The caller does not have permission" } });
      return this.orders.has(m[1]) ? this.json(200, this.orders.get(m[1])) : this.notFound("Order");
    }
    return this.notFound(rest);
  }
}

let seq = 0;

/** A Pub/Sub push body for a DeveloperNotification. */
export function pushBody(packageName: string, notification: Record<string, unknown>, messageId = `${Date.now()}${++seq}`) {
  const data = btoa(JSON.stringify({ version: "1.0", packageName, eventTimeMillis: String(Date.now()), ...notification }));
  return { body: { message: { data, messageId, publishTime: new Date().toISOString(), attributes: {} }, subscription: "projects/example-project/subscriptions/revflare-rtdn" }, messageId };
}
