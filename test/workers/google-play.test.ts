import { env, fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pushTestHooks, type PushMessage } from "../../worker/lib/push";
import { checkAlerts } from "../../worker/lib/alerts";
import { call, ownerClient } from "./helpers";
import { DAY, FakeGoogle, playOrder, playSubscription, pushBody, rsaKeyPair, serviceAccountJson, signJwt } from "./google-helpers";

const db = env.DATABASE.get(env.DATABASE.idFromName("main"));
const rows = async <T = any>(sql: string, ...params: (string | number)[]) => (((await db.exec([{ sql, params, mode: "all" }], false)) as { results: unknown[] }[])[0].results as T[]);

const google = new FakeGoogle();
const pushes: { deviceId: string; msg: PushMessage }[] = [];
const PKG = "com.example.revflare.android";
const INSTALL = "4b1c2a4e-0b7d-4c41-9a51-2f3e4d5c6b7a";
const O1 = "GPA.3311-1111-2222-33333";
const O2 = "GPA.3322-1111-2222-33333";
const O3 = "GPA.3333-1111-2222-33333";
const OT = "GPA.3344-1111-2222-33333";
const OS = "GPA.3355-1111-2222-33333";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  google.install();
  pushTestHooks.sink = pushes;
});
afterAll(() => {
  pushTestHooks.sink = null;
});

let appId = "";
let key = "";
let sdkKey = "";
let owner: Awaited<ReturnType<typeof ownerClient>>;
let saPublicKey: CryptoKey;

const rtdn = (notification: Record<string, unknown>, opts: { messageId?: string; headers?: Record<string, string>; pkg?: string } = {}) => {
  const p = pushBody(opts.pkg ?? PKG, notification, opts.messageId);
  return call(null, `/google/rtdn/${key}`, { body: p.body, headers: opts.headers });
};
const subNote = (type: number, token: string) => ({ subscriptionNotification: { version: "1.0", notificationType: type, purchaseToken: token, subscriptionId: "premium" } });
const tx = (id: string) => rows(`SELECT * FROM transactions WHERE app_id = ? AND transaction_id = ?`, appId, id).then((r) => r[0]);
const sub = (otid: string) => rows(`SELECT * FROM subscriptions WHERE app_id = ? AND original_transaction_id = ?`, appId, otid).then((r) => r[0]);

describe("Google Play", () => {
  it("adds an Android app and its service account", async () => {
    owner = await ownerClient();
    expect((await call(owner, "/api/v1/devices", { body: { apnsToken: "9a5".padEnd(64, "0"), name: "Play test", prefs: { timezone: "UTC", cancellations: true } } })).status).toBeLessThan(300);
    expect((await call(owner, "/api/v1/apps", { body: { platform: "android", name: "Droid", packageName: "not a package" } })).status).toBe(400);
    const app = await call(owner, "/api/v1/apps", { body: { platform: "android", name: "Droid", packageName: PKG } });
    expect(app.status).toBe(201);
    expect(app.json.platform).toBe("android");
    expect(app.json.bundleId).toBe(PKG);
    expect(app.json.revflareNotificationUrl).toMatch(/\/google\/rtdn\/[A-Za-z0-9_-]+$/);
    expect(app.json.googlePlay).toMatchObject({ configured: false, pushAuth: false });
    appId = app.json.id;
    sdkKey = app.json.sdkKey;
    key = (app.json.revflareNotificationUrl as string).split("/").pop()!;
    // Same package name as an iOS bundle id: a separate app.
    const ios = await call(owner, "/api/v1/apps", { body: { name: "Droid iOS", bundleId: PKG } });
    expect(ios.status).toBe(201);
    expect(ios.json.id).not.toBe(appId);

    // App Store only features answer 400 for Android apps.
    expect((await call(owner, `/api/v1/apps/${appId}/sync`, { method: "POST" })).status).toBe(400);
    expect((await call(owner, `/api/v1/apps/${appId}/test-notification`, { method: "POST" })).json.error).toMatch(/App Store only/);
    expect((await call(owner, `/api/v1/apps/${appId}/integrations/refunds`, { method: "PUT", body: { enabled: true } })).status).toBe(400);
    expect((await call(owner, `/api/v1/apps/${appId}/offers`, { method: "PUT", body: { offers: [] } })).status).toBe(400);
    expect((await call(owner, `/api/v1/apps/${ios.json.id}/google-play`)).status).toBe(400);

    // RTDN before any service account: retried by Pub/Sub (503), nothing stored.
    google.subs.set("tok-early", playSubscription({ orderId: "GPA.3399-1111-2222-33333", expiry: Date.now() + 30 * DAY }));
    expect((await rtdn(subNote(4, "tok-early"))).status).toBe(503);

    expect((await call(owner, "/api/v1/credentials", { body: { kind: "google_play", serviceAccount: "{}" } })).status).toBe(400);
    const sa = await serviceAccountJson();
    saPublicKey = sa.publicKey;
    const put = await call(owner, `/api/v1/apps/${appId}/google-play`, { method: "PUT", body: { serviceAccount: sa.json } });
    expect(put.status).toBe(200);
    expect(put.json.credential).toMatchObject({ clientEmail: "revflare-test@example-project.iam.gserviceaccount.com", projectId: "example-project", appSpecific: true });
    expect(put.json.rtdnUrl).toBe(app.json.revflareNotificationUrl);
    const creds = await call(owner, "/api/v1/credentials");
    const gp = creds.json.items.find((c: any) => c.kind === "google_play");
    expect(gp.issuerId).toBe("revflare-test@example-project.iam.gserviceaccount.com");
    expect(JSON.stringify(creds.json)).not.toContain("PRIVATE KEY");

    const test = await call(owner, `/api/v1/apps/${appId}/google-play/test`, { method: "POST" });
    expect(test.json).toEqual({ ok: true });
  });

  it("signs the JWT bearer token request with the service account key", async () => {
    expect(google.tokenRequests.length).toBeGreaterThan(0);
    const form = new URLSearchParams(google.tokenRequests[0].body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, p, s] = form.get("assertion")!.split(".");
    const dec = (x: string) => JSON.parse(atob(x.replace(/-/g, "+").replace(/_/g, "/")));
    expect(dec(h)).toMatchObject({ alg: "RS256", typ: "JWT", kid: "0123456789abcdef0123456789abcdef01234567" });
    const claims = dec(p);
    expect(claims).toMatchObject({
      iss: "revflare-test@example-project.iam.gserviceaccount.com",
      aud: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/androidpublisher",
    });
    expect(claims.exp - claims.iat).toBe(3600);
    const sig = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", saPublicKey, sig, new TextEncoder().encode(`${h}.${p}`))).toBe(true);
  });

  it("maps a free trial, its conversion and renewals", async () => {
    const t0 = Date.now() - 70 * DAY;
    // Free trial (3 days), bought with obfuscatedAccountId = RevflareKit install id.
    google.orders.set(O1, playOrder(O1, { start: t0, end: t0 + 3 * DAY, price: 0, phase: "free", revenue: 0 }));
    google.subs.set("tok-1", playSubscription({ orderId: O1, expiry: t0 + 3 * DAY, phase: "free", installId: INSTALL, start: t0 }));
    pushes.length = 0;
    const r = await rtdn(subNote(4, "tok-1"), { messageId: "msg-trial" });
    expect(r.status).toBe(200);
    const trial = await tx(O1);
    expect(trial).toMatchObject({ kind: "trial", store: "play_store", source: "google_play", product_id: "premium:monthly", environment: "Production", gross_usd: 0, country: "US" });
    expect(await sub(O1)).toMatchObject({ status: "trial", auto_renew: 1, purchase_token: "tok-1" });
    expect(await rows("SELECT install_id FROM install_links WHERE app_id = ? AND original_transaction_id = ?", appId, O1)).toEqual([{ install_id: INSTALL }]);

    // Duplicate Pub/Sub delivery: acknowledged, stored once, no Play call.
    const calls = google.apiCalls.length;
    const dup = await rtdn(subNote(4, "tok-1"), { messageId: "msg-trial" });
    expect(dup.json).toMatchObject({ ok: true, duplicate: true });
    expect(google.apiCalls.length).toBe(calls);
    expect((await rows("SELECT COUNT(*) AS n FROM transactions WHERE app_id = ?", appId))[0].n).toBe(1);

    // Conversion: first paid order "..0" (exact proceeds from the Orders API).
    const t1 = t0 + 3 * DAY - 60_000;
    google.orders.set(`${O1}..0`, playOrder(`${O1}..0`, { start: t1, price: 9.99, revenue: 8.12 }));
    google.subs.set("tok-1", playSubscription({ orderId: `${O1}..0`, expiry: t1 + 30 * DAY, installId: INSTALL, start: t0 }));
    expect((await rtdn(subNote(2, "tok-1"))).status).toBe(200);
    const conv = await tx(`${O1}..0`);
    expect(conv).toMatchObject({ kind: "conversion", original_transaction_id: O1, gross_usd: 9.99, proceeds_reported: 1, period: "P1M", price_milli: 9990, currency: "USD" });
    expect(conv.proceeds_usd).toBeCloseTo(8.12, 5);
    expect(await sub(O1)).toMatchObject({ status: "active", auto_renew: 1 });
    expect((await sub(O1)).mrr_usd).toBeCloseTo(9.99, 5);
    // Product titles from the Orders API name the product.
    expect((await rows("SELECT name, subscription_group, period FROM products WHERE app_id = ? AND product_id = 'premium:monthly'", appId))[0]).toEqual({ name: "Premium", subscription_group: "premium", period: "P1M" });

    // A renewal whose predecessor "..1" was never notified: the gap is filled from the Orders API.
    const t2 = t1 + 30 * DAY;
    google.orders.set(`${O1}..1`, playOrder(`${O1}..1`, { start: t2, price: 9.99, revenue: 8.12 }));
    google.orders.set(`${O1}..2`, playOrder(`${O1}..2`, { start: t2 + 30 * DAY, price: 9.99, revenue: 8.12 }));
    google.subs.set("tok-1", playSubscription({ orderId: `${O1}..2`, expiry: t2 + 60 * DAY, installId: INSTALL, start: t0 }));
    expect((await rtdn(subNote(2, "tok-1"))).status).toBe(200);
    expect((await tx(`${O1}..1`)).kind).toBe("renewal");
    expect((await tx(`${O1}..2`)).kind).toBe("renewal");
    expect(google.apiCalls.some((c) => c.startsWith("/orders:batchGet") && c.includes(encodeURIComponent(`${O1}..1`)))).toBe(true);
    const kinds = pushes.map((p) => p.msg.titleKey);
    expect(kinds).toContain("PUSH_TITLE_TRIAL");
    expect(kinds).toContain("PUSH_TITLE_CONVERSION");
  });

  it("follows cancellation, grace, account hold and expiry", async () => {
    const order = `${O1}..2`;
    const base = google.subs.get("tok-1")!;
    const expiry = Date.parse(base.lineItems![0].expiryTime!);
    google.subs.set(
      "tok-1",
      playSubscription({ state: "SUBSCRIPTION_STATE_CANCELED", orderId: order, expiry, autoRenew: false, installId: INSTALL, cancel: { userInitiatedCancellation: { cancelSurveyResult: { reason: "CANCEL_SURVEY_REASON_COST_RELATED" }, cancelTime: new Date().toISOString() } } }),
    );
    pushes.length = 0;
    expect((await rtdn(subNote(3, "tok-1"))).status).toBe(200);
    expect(await sub(O1)).toMatchObject({ status: "active", auto_renew: 0, cancel_reason: "user:COST_RELATED", expiration_reason: null });
    expect(pushes.map((p) => p.msg.titleKey)).toContain("PUSH_TITLE_CANCELLATION");

    google.subs.set("tok-1", playSubscription({ state: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD", orderId: order, expiry, installId: INSTALL }));
    await rtdn(subNote(6, "tok-1"));
    expect((await sub(O1)).status).toBe("grace");
    google.subs.set("tok-1", playSubscription({ state: "SUBSCRIPTION_STATE_ON_HOLD", orderId: order, expiry, installId: INSTALL }));
    await rtdn(subNote(5, "tok-1"));
    expect((await sub(O1)).status).toBe("billing_retry");
    google.subs.set("tok-1", playSubscription({ state: "SUBSCRIPTION_STATE_PAUSED", orderId: order, expiry, installId: INSTALL }));
    await rtdn(subNote(10, "tok-1"));
    expect(await sub(O1)).toMatchObject({ status: "expired", auto_renew: 1 });
    google.subs.set("tok-1", playSubscription({ state: "SUBSCRIPTION_STATE_ACTIVE", orderId: order, expiry, installId: INSTALL }));
    await rtdn(subNote(1, "tok-1"));
    expect(await sub(O1)).toMatchObject({ status: "active", auto_renew: 1 });

    // The customer page reads the Play notifications as history; the cancellation date is known.
    const cust = await call(owner, `/api/v1/customers/${(await tx(O1)).customer_id}`);
    expect(cust.status).toBe(200);
    expect(cust.json.transactions.every((t: any) => t.store === "play_store")).toBe(true);
    expect(cust.json.events.map((e: any) => e.type)).toContain("SUBSCRIPTION_CANCELED");
  });

  it("starts a new chain on upgrade and ends the replaced subscription", async () => {
    const t = Date.now() - 60_000;
    const fullExpiry = Date.parse(google.subs.get("tok-1")!.lineItems![0].expiryTime!);
    google.orders.set(O2, playOrder(O2, { start: t, end: t + 365 * DAY, price: 59.99, basePlanId: "yearly", revenue: 50.99 }));
    google.subs.set("tok-2", playSubscription({ orderId: O2, expiry: t + 365 * DAY, basePlanId: "yearly", linked: "tok-1", start: t }));
    expect((await rtdn(subNote(4, "tok-2"))).status).toBe(200);
    const yearly = await tx(O2);
    expect(yearly).toMatchObject({ kind: "new", product_id: "premium:yearly", period: "P1Y" });
    // Same customer (no install id on the new purchase: found through the replaced subscription).
    expect(yearly.customer_id).toBe((await tx(O1)).customer_id);
    expect(await sub(O1)).toMatchObject({ status: "expired", auto_renew: 0, cancel_reason: "replacement" });
    expect((await tx(`${O1}..2`)).expires_at).toBeLessThanOrEqual(t);
    expect((await sub(O2)).status).toBe("active");

    // Later, Google expires the replaced purchase (replacementCancellation). Its order is rebuilt with the full service
    // period: the cut and the upgraded flag stay (else MRR counts both subscriptions), even when Google reports the
    // full period's expiry...
    google.subs.set("tok-1", playSubscription({ state: "SUBSCRIPTION_STATE_EXPIRED", orderId: `${O1}..2`, expiry: fullExpiry, autoRenew: false, installId: INSTALL, cancel: { replacementCancellation: {} } }));
    expect((await rtdn(subNote(13, "tok-1"))).status).toBe(200);
    const replaced = await tx(`${O1}..2`);
    expect(replaced.expires_at).toBeLessThanOrEqual(t);
    expect(replaced.is_upgraded).toBe(1);
    expect(await sub(O1)).toMatchObject({ status: "expired", mrr_usd: 0, cancel_reason: "replacement" });
    expect((await sub(O1)).expires_at).toBeLessThanOrEqual(t);
    // ...or its own cut.
    google.subs.set("tok-1", playSubscription({ state: "SUBSCRIPTION_STATE_EXPIRED", orderId: `${O1}..2`, expiry: t - 1000, autoRenew: false, installId: INSTALL, cancel: { replacementCancellation: {} } }));
    expect((await rtdn(subNote(13, "tok-1"))).status).toBe(200);
    expect(await tx(`${O1}..2`)).toMatchObject({ is_upgraded: 1 });
    expect((await tx(`${O1}..2`)).expires_at).toBeLessThanOrEqual(t);
    expect(await sub(O1)).toMatchObject({ status: "expired", mrr_usd: 0 });
    expect((await sub(O2)).status).toBe("active");
  });

  it("records refunds: voided (full), partial refunds and revocations", async () => {
    const o = google.orders.get(`${O1}..1`)!;
    google.orders.set(`${O1}..1`, { ...o, state: "REFUNDED", orderHistory: { ...o.orderHistory, refundEvent: { eventTime: new Date().toISOString(), refundDetails: { total: o.total } } } });
    pushes.length = 0;
    expect((await rtdn({ voidedPurchaseNotification: { purchaseToken: "tok-1", orderId: `${O1}..1`, productType: 1, refundType: 1 } })).status).toBe(200);
    const full = await tx(`${O1}..1`);
    expect(full.refunded_at).toBeGreaterThan(0);
    expect(full.refund_milli).toBeNull();
    expect(pushes.map((p) => p.msg.titleKey)).toContain("PUSH_TITLE_REFUND");

    // A partial refund (40 %) of the yearly order, seen on the order's history.
    const y = google.orders.get(O2)!;
    google.orders.set(O2, { ...y, state: "PARTIALLY_REFUNDED", orderHistory: { ...y.orderHistory, partialRefundEvents: [{ createTime: new Date().toISOString(), processTime: new Date().toISOString(), state: "PROCESSED_SUCCESSFULLY", refundDetails: { total: { currencyCode: "USD", units: "23", nanos: 996000000 } } }] } });
    await rtdn(subNote(2, "tok-2"));
    expect((await tx(O2)).refund_milli).toBe(40_000);
    // A partial refund does not end the subscription: still active, still in MRR.
    expect((await sub(O2)).status).toBe("active");
    expect((await sub(O2)).mrr_usd).toBeGreaterThan(0);

    // Revoked: refunded at once.
    google.orders.set(O3, playOrder(O3, { start: Date.now() - DAY, price: 4.99 }));
    google.subs.set("tok-3", playSubscription({ orderId: O3, expiry: Date.now() + 29 * DAY }));
    await rtdn(subNote(4, "tok-3"));
    google.subs.set("tok-3", playSubscription({ state: "SUBSCRIPTION_STATE_EXPIRED", orderId: O3, expiry: Date.now() - 1000, autoRenew: false }));
    await rtdn(subNote(12, "tok-3"));
    expect((await tx(O3)).refunded_at).toBeGreaterThan(0);
    expect((await sub(O3)).status).toBe("refunded");
  });

  it("stores one-time purchases and test purchases; ignores pending ones", async () => {
    google.products.set("tok-ot", { productLineItem: [{ productId: "coins_100", productOfferDetails: { quantity: 1 } }], purchaseStateContext: { purchaseState: "PURCHASED" }, orderId: OT, obfuscatedExternalAccountId: INSTALL, regionCode: "DE" });
    google.orders.set(OT, playOrder(OT, { start: Date.now() - 1000, price: 4.99, currency: "EUR", country: "DE", oneTime: true, productId: "coins_100", revenue: 3.55 }));
    expect((await rtdn({ oneTimeProductNotification: { version: "1.0", notificationType: 1, purchaseToken: "tok-ot", sku: "coins_100" } })).status).toBe(200);
    expect(await tx(OT)).toMatchObject({ kind: "one_time", product_id: "coins_100", currency: "EUR", country: "DE", price_milli: 4990, proceeds_reported: 1 });

    // Three units in one order: the order's total covers all three (unit price stored, gross = the total).
    const OQ = "GPA.3377-1111-2222-33333";
    const multi = playOrder(OQ, { start: Date.now() - 1000, price: 2.97, oneTime: true, productId: "coins_100", revenue: 2.52 });
    multi.lineItems![0].oneTimePurchaseDetails = { quantity: 3 };
    google.orders.set(OQ, multi);
    google.products.set("tok-q", { productLineItem: [{ productId: "coins_100", productOfferDetails: { quantity: 3 } }], purchaseStateContext: { purchaseState: "PURCHASED" }, orderId: OQ, regionCode: "US" });
    expect((await rtdn({ oneTimeProductNotification: { version: "1.0", notificationType: 1, purchaseToken: "tok-q", sku: "coins_100" } })).status).toBe(200);
    const q = await tx(OQ);
    expect(q).toMatchObject({ quantity: 3, price_milli: 990, proceeds_reported: 1 });
    expect(q.gross_usd).toBeCloseTo(2.97, 5);
    expect(q.proceeds_usd).toBeCloseTo(2.52, 5);

    google.orders.set(OS, playOrder(OS, { start: Date.now() - 1000, price: 9.99 }));
    google.subs.set("tok-test-purchase", playSubscription({ orderId: OS, expiry: Date.now() + 5 * 60_000, test: true }));
    await rtdn(subNote(4, "tok-test-purchase"));
    expect((await tx(OS)).environment).toBe("Sandbox");

    // Pending (slow payment method): nothing until it is paid.
    google.subs.set("tok-pending", { ...playSubscription({ orderId: "GPA.3366-1111-2222-33333", expiry: Date.now() + 30 * DAY }), subscriptionState: "SUBSCRIPTION_STATE_PENDING" });
    const before = (await rows("SELECT COUNT(*) AS n FROM events WHERE app_id = ?", appId))[0].n;
    const p = await rtdn(subNote(4, "tok-pending"));
    expect(p.json).toMatchObject({ ok: true, ignored: "pending purchase" });
    expect((await rows("SELECT COUNT(*) AS n FROM events WHERE app_id = ?", appId))[0].n).toBe(before);
    expect(await tx("GPA.3366-1111-2222-33333")).toBeUndefined();
    // Another app's package: acknowledged (Pub/Sub would retry a 4xx for 7 days), nothing stored, an alert.
    const calls = google.apiCalls.length;
    const wrong = await rtdn(subNote(4, "tok-1"), { pkg: "com.example.other" });
    expect(wrong.status).toBe(200);
    expect(wrong.json.ignored).toMatch(/com\.example\.other/);
    expect(google.apiCalls.length).toBe(calls);
    const alerts = await call(owner, "/api/v1/alerts");
    expect(alerts.json.items.some((a: any) => a.kind === "google_play_package" && a.appId === appId)).toBe(true);
    // Malformed bodies: acknowledged and logged.
    const bad = await call(null, `/google/rtdn/${key}`, { body: { message: { data: "not base64 json", messageId: "msg-bad" } } });
    expect(bad.status).toBe(200);
    expect(bad.json.ignored).toBe("malformed push body");
    expect((await call(null, `/google/rtdn/${key}`, { body: { message: {} } })).json.ignored).toBe("malformed push body");
  });

  it("prices from the subscription alone without the Orders API: only free trials are free", async () => {
    google.ordersStatus = 403;
    try {
      const OI = "GPA.3388-1111-2222-33333";
      google.subs.set("tok-intro", playSubscription({ orderId: OI, expiry: Date.now() + 30 * DAY, phase: "intro", price: 9.99, start: Date.now() - 1000 }));
      expect((await rtdn(subNote(4, "tok-intro"))).status).toBe(200);
      // The introductory price is unknown here: the recurring price stands in (an estimate, proceeds not reported).
      expect(await tx(OI)).toMatchObject({ price_milli: 9990, offer_discount_type: "PAY_AS_YOU_GO", proceeds_reported: 0 });
      const OF = "GPA.3389-1111-2222-33333";
      google.subs.set("tok-free", playSubscription({ orderId: OF, expiry: Date.now() + 3 * DAY, phase: "free", price: 9.99, start: Date.now() - 1000 }));
      expect((await rtdn(subNote(4, "tok-free"))).status).toBe(200);
      expect(await tx(OF)).toMatchObject({ price_milli: 0, kind: "trial", gross_usd: 0 });
    } finally {
      google.ordersStatus = 200;
    }
  });

  it("raises an info alert for Google's test notification", async () => {
    pushes.length = 0;
    const r = await rtdn({ testNotification: { version: "1.0" } });
    expect(r.status).toBe(200);
    const alerts = await call(owner, "/api/v1/alerts");
    expect(alerts.json.items.some((a: any) => a.kind === "google_play_test" && a.title === "Google Play test notification received")).toBe(true);
    expect(pushes.some((p) => p.msg.kind === "test")).toBe(true);
  });

  it("verifies the Pub/Sub OIDC token when a push service account is set", async () => {
    const pubsub = "rtdn-push@example-project.iam.gserviceaccount.com";
    expect((await call(owner, `/api/v1/apps/${appId}/google-play`, { method: "PUT", body: { pushServiceAccount: "not an email" } })).status).toBe(400);
    expect((await call(owner, `/api/v1/apps/${appId}/google-play`, { method: "PUT", body: { pushServiceAccount: pubsub } })).json.pushServiceAccount).toBe(pubsub);
    const good = await rsaKeyPair();
    const other = await rsaKeyPair();
    const jwk = (await crypto.subtle.exportKey("jwk", good.publicKey)) as JsonWebKey;
    google.jwks = [{ kty: "RSA", alg: "RS256", use: "sig", kid: "kid-good", n: jwk.n, e: jwk.e }];
    const aud = `https://rf.test/google/rtdn/${key}`;
    const nowS = Math.floor(Date.now() / 1000);
    const claims = { iss: "https://accounts.google.com", aud, email: pubsub, email_verified: true, iat: nowS, exp: nowS + 3600, sub: "1" };
    const bearer = async (c: Record<string, unknown>, k = good.privateKey) => ({ authorization: `Bearer ${await signJwt(k, { kid: "kid-good" }, c)}` });
    const testNote = { testNotification: { version: "1.0" } };
    expect((await rtdn(testNote)).status).toBe(401);
    expect((await rtdn(testNote, { headers: await bearer(claims) })).status).toBe(200);
    expect((await rtdn(testNote, { headers: await bearer({ ...claims, aud: "https://elsewhere.example.com/push" }) })).status).toBe(401);
    expect((await rtdn(testNote, { headers: await bearer({ ...claims, email: "intruder@example-project.iam.gserviceaccount.com" }) })).status).toBe(401);
    expect((await rtdn(testNote, { headers: await bearer({ ...claims, exp: nowS - 3600, iat: nowS - 7200 }) })).status).toBe(401);
    expect((await rtdn(testNote, { headers: await bearer({ ...claims, email_verified: false }) })).status).toBe(401);
    expect((await rtdn(testNote, { headers: await bearer(claims, other.privateKey) })).status).toBe(401);
    expect((await rtdn(testNote, { headers: await bearer({ ...claims, iss: "https://evil.example.com" }) })).status).toBe(401);
    // An unknown key id refetches Google's certificates at most once a minute.
    const fetches = google.jwksFetches;
    const unknownKid = async () => ({ authorization: `Bearer ${await signJwt(good.privateKey, { kid: "kid-unknown" }, claims)}` });
    expect((await rtdn(testNote, { headers: await unknownKid() })).status).toBe(401);
    expect(google.jwksFetches).toBe(fetches + 1);
    expect((await rtdn(testNote, { headers: await unknownKid() })).status).toBe(401);
    expect((await rtdn(testNote, { headers: await unknownKid() })).status).toBe(401);
    expect(google.jwksFetches).toBe(fetches + 1);
    expect((await rtdn(testNote, { headers: await bearer(claims) })).status).toBe(200);
    await call(owner, `/api/v1/apps/${appId}/google-play`, { method: "PUT", body: { pushServiceAccount: null } });
  });

  it("links installs through /sdk/v1/report and the install referrer", async () => {
    const report = (body: object) => call(null, "/sdk/v1/report", { body: { sdkKey, platform: "android", ...body } });
    // Order ids (renewal suffix stripped) and purchase tokens.
    const viaOrder = "5b1c2a4e-0b7d-4c41-9a51-2f3e4d5c6b7a";
    const r1 = await report({ installId: viaOrder, orderIds: [`${O3}..4`, "not-an-order"], installReferrer: { referrer: "utm_source=google&utm_medium=cpc&utm_campaign=spring&gclid=EAIaIQexample", clickTs: 1_760_000_000, installTs: Math.floor(Date.now() / 1000) - 60 } });
    expect(r1.status).toBe(200);
    expect(r1.json.source).toBe("google_ads");
    expect(await rows("SELECT install_id FROM install_links WHERE app_id = ? AND original_transaction_id = ?", appId, O3)).toEqual([{ install_id: viaOrder }]);
    const a = (await rows("SELECT * FROM attributions WHERE app_id = ? AND install_id = ?", appId, viaOrder))[0];
    expect(a).toMatchObject({ referrer_source: "google_ads", utm_source: "google", utm_medium: "cpc", utm_campaign: "spring", gclid: "EAIaIQexample", referrer_click_at: 1_760_000_000_000, status: "resolved" });

    const viaToken = "6b1c2a4e-0b7d-4c41-9a51-2f3e4d5c6b7a";
    const r2 = await report({ installId: viaToken, purchaseTokens: ["tok-test-purchase"], installReferrer: { referrer: "utm_source=newsletter&utm_medium=email" } });
    expect(r2.json.source).toBe("referral");
    expect(await rows("SELECT install_id FROM install_links WHERE app_id = ? AND original_transaction_id = ?", appId, OS)).toEqual([{ install_id: viaToken }]);
    const organic = "7b1c2a4e-0b7d-4c41-9a51-2f3e4d5c6b7a";
    expect((await report({ installId: organic, installReferrer: { referrer: "utm_source=google-play&utm_medium=organic" } })).json.source).toBe("organic");
    // Debuggable builds: test data, nothing linked.
    const debug = "8b1c2a4e-0b7d-4c41-9a51-2f3e4d5c6b7a";
    expect((await report({ installId: debug, environment: "debug", orderIds: [O2] })).status).toBe(200);
    expect(await rows("SELECT install_id FROM install_links WHERE app_id = ? AND install_id = ?", appId, debug)).toEqual([]);
    expect((await rows("SELECT environment FROM attributions WHERE app_id = ? AND install_id = ?", appId, debug))[0].environment).toBe("debug");

    // The feed shows the purchase's source and store.
    const feed = await call(owner, `/api/v1/transactions?apps=${appId}&environment=all&limit=50`);
    const revoked = feed.json.items.find((x: any) => x.transactionId === O3);
    expect(revoked).toMatchObject({ store: "play_store", attribution: { source: "google_ads" } });
    expect((await call(owner, `/api/v1/transactions?apps=${appId}&source=google_ads`)).json.items.map((x: any) => x.transactionId)).toEqual([O3]);
  });

  it("polls voided purchases for refunds RTDN missed", async () => {
    google.voided = [{ kind: "androidpublisher#voidedPurchase", purchaseToken: "tok-1", orderId: `${O1}..0`, voidedTimeMillis: String(Date.now() - 3_600_000), voidedSource: 0, voidedReason: 1 }];
    const r = await call(owner, `/api/v1/apps/${appId}/google-play/voided`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ apps: 1, refunded: 1, errors: [] });
    expect((await tx(`${O1}..0`)).refunded_at).toBeGreaterThan(0);
    // Again: nothing new.
    expect((await call(owner, `/api/v1/apps/${appId}/google-play/voided`, { method: "POST" })).json.refunded).toBe(0);
  });

  it("shows Android revenue in MRR, the overview and the apps list", async () => {
    const apps = await call(owner, "/api/v1/apps");
    const droid = apps.json.items.find((a: any) => a.id === appId);
    expect(droid).toMatchObject({ platform: "android", googlePlay: { configured: true } });
    expect(droid.revenue28d).toBeGreaterThan(0);
    const chart = await call(owner, `/api/v1/charts/revenue?apps=${appId}&range=90d`);
    expect(chart.json.total).toBeGreaterThan(0);
    const overview = await call(owner, `/api/v1/overview?apps=${appId}`);
    expect(overview.json.topApps.find((a: any) => a.appId === appId)?.platform).toBe("android");
    const settings = await call(owner, `/api/v1/apps/${appId}/google-play`);
    expect(settings.json).toMatchObject({ packageName: PKG, pushServiceAccount: null, lastCheck: { ok: true } });
    expect(settings.json.voidedCheckedAt).toBeGreaterThan(0);
  });

  it("raises the silence alert for Android apps whose notifications stop", async () => {
    // Plenty of RTDNs this week (the test run's), the last one two days ago.
    await rows("UPDATE apps SET last_notification_at = ? WHERE id = ?", Date.now() - 2 * DAY, appId);
    await checkAlerts(env, {});
    const alert = (await rows<{ title: string; body: string }>("SELECT title, body FROM alerts WHERE app_id = ? AND kind = 'notifications_silent'", appId))[0];
    expect(alert.title).toBe("No Google Play notifications from Droid");
    expect(alert.body).toMatch(/Pub\/Sub/);
  });

  it("says whether the app has an effective Google Play credential", async () => {
    const droid = async () => (await call(owner, "/api/v1/apps")).json.items.find((a: any) => a.id === appId);
    expect((await droid()).googlePlay.configured).toBe(true);
    const keys = (await call(owner, "/api/v1/credentials")).json.items.filter((c: any) => c.kind === "google_play");
    for (const k of keys) expect((await call(owner, `/api/v1/credentials/${k.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await droid()).googlePlay.configured).toBe(false);
    expect((await call(owner, `/api/v1/apps/${appId}`)).json.googlePlay.configured).toBe(false);
    // The app's own key is gone; a workspace key added later is the effective one.
    const sa = await serviceAccountJson("other@example-project.iam.gserviceaccount.com");
    expect((await call(owner, "/api/v1/credentials", { body: { kind: "google_play", serviceAccount: sa.json } })).status).toBe(201);
    expect((await droid()).googlePlay.configured).toBe(true);
    expect((await call(owner, `/api/v1/apps/${appId}/google-play`)).json.credential).toMatchObject({ clientEmail: "other@example-project.iam.gserviceaccount.com", appSpecific: false });
  });
});
