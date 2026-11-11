import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../worker/lib/db";
import { OFFER_LOG_SIZE, OFFER_LOG_TRIM_EVERY, OFFER_RATE_LIMITS, REFUSAL_LOG_PER_HOUR, REFUSAL_SAMPLE, SEPARATOR, legacyPayload, logSignature, logWeight, resetOffersState } from "../../worker/lib/offers";
import { DAY, call, notification, ownerClient, type Client } from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(() => resetOffersState());

const ISSUER = "5f0c2a7e-3b9d-4e61-9a84-2d7c1e6b0f53";
const KEY_ID = "OFFERKEY01";

const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const fromB64url = (s: string) => fromB64(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));

/** DER SEQUENCE { INTEGER r, INTEGER s } → raw r‖s (32 + 32 bytes) for WebCrypto. */
function derToRaw(der: Uint8Array): Uint8Array {
  expect(der[0]).toBe(0x30);
  expect(der[1]).toBe(der.length - 2);
  const out = new Uint8Array(64);
  let i = 2;
  for (const at of [0, 32]) {
    expect(der[i]).toBe(0x02);
    const len = der[i + 1];
    let v = der.subarray(i + 2, i + 2 + len);
    if (v.length === 33) {
      expect(v[0]).toBe(0);
      v = v.subarray(1);
    }
    expect(v.length).toBeLessThanOrEqual(32);
    out.set(v, at + 32 - v.length);
    i += 2 + len;
  }
  expect(i).toBe(der.length);
  return out;
}

/** A fresh P-256 key: the PEM for the credential, the public key to verify. */
async function testKey() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  return { pem: `-----BEGIN PRIVATE KEY-----\n${b64(pkcs8)}\n-----END PRIVATE KEY-----`, publicKey: pair.publicKey };
}

async function setup(name: string, opts: { iapKey?: boolean } = {}) {
  const owner = await ownerClient();
  const ws = await call(owner, "/api/v1/workspaces", { body: { name, currency: "USD" } });
  expect(ws.status).toBe(200);
  const client: Client = { ...owner, ws: ws.json.id };
  const key = await testKey();
  if (opts.iapKey !== false) {
    const cred = await call(client, "/api/v1/credentials", { body: { kind: "appstore_iap", name: "IAP", keyId: KEY_ID, issuerId: ISSUER, privateKey: key.pem } });
    expect(cred.status).toBe(201);
  }
  return { client, key };
}

async function createApp(client: Client, bundleId: string) {
  const app = await call(client, "/api/v1/apps", { body: { name: bundleId, bundleId } });
  expect(app.status).toBe(201);
  return { id: app.json.id as string, sdkKey: app.json.sdkKey as string, key: (app.json.revflareNotificationUrl as string).split("/").pop()! };
}

const sign = (sdkKey: string, body: unknown) => call(null, "/sdk/v1/offers/sign", { body, headers: { "x-revflare-key": sdkKey } });
const uuid = () => crypto.randomUUID();
const post = (key: string, signedPayload: string) => call(null, `/apple/notifications/${key}`, { body: { signedPayload } });

/** The log row of an install (written after the response). */
async function logOf(client: Client, appId: string, installId: string) {
  for (let i = 0; i < 100; i++) {
    const r = await call(client, `/api/v1/apps/${appId}/offers/log`);
    const row = (r.json.items as any[]).find((x) => x.installId === installId);
    if (row) return row;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`no log row for ${installId}`);
}

describe("promotional offers", () => {
  it("signs allowlisted offers (legacy signature and JWS) and refuses the rest", async () => {
    const { client, key } = await setup("Offers sign");
    const bundleId = "com.example.offers";
    const app = await createApp(client, bundleId);
    const url = `/api/v1/apps/${app.id}/offers`;

    // Settings: empty, validation, save.
    const initial = await call(client, url);
    expect(initial.json).toMatchObject({ appId: app.id, offers: [], strict: false, keyConfigured: true, bundleId, sdkKey: app.sdkKey });
    expect((await call(client, url, { method: "PUT", body: { offers: [{ productId: "has space", offerId: "x" }] } })).status).toBe(400);
    expect((await call(client, url, { method: "PUT", body: { offers: [{ productId: "p", offerId: "x", kind: "other" }] } })).status).toBe(400);
    expect((await call(client, url, { method: "PUT", body: { strict: "yes" } })).status).toBe(400);
    const saved = await call(client, url, {
      method: "PUT",
      body: {
        offers: [
          { productId: `${bundleId}.annual`, offerId: "save50", label: "50 % off" },
          { productId: `${bundleId}.annual`, offerId: "comeback", kind: "win_back" },
        ],
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.json.offers).toEqual([
      { productId: `${bundleId}.annual`, offerId: "save50", label: "50 % off", kind: "promotional" },
      { productId: `${bundleId}.annual`, offerId: "comeback", label: null, kind: "win_back" },
    ]);

    // Bad requests.
    expect((await sign(app.sdkKey, { productId: "x" })).status).toBe(400);
    expect((await call(null, "/sdk/v1/offers/sign", { body: { installId: uuid(), productId: "p", offerId: "o" } })).status).toBe(400);
    expect((await sign(app.sdkKey, { installId: uuid(), productId: "p", offerId: "o", appAccountToken: "not-a-uuid" })).status).toBe(400);
    expect((await sign("rfp_unknown", { installId: uuid(), productId: "p", offerId: "o" })).status).toBe(404);

    // Not on the allowlist (win-back entries are never signed).
    const deniedInstall = uuid();
    const denied = await sign(app.sdkKey, { installId: deniedInstall, productId: `${bundleId}.annual`, offerId: "other" });
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe("offer_not_allowed");
    expect((await sign(app.sdkKey, { installId: uuid(), productId: `${bundleId}.annual`, offerId: "comeback" })).json.code).toBe("offer_not_allowed");
    expect(await logOf(client, app.id, deniedInstall)).toMatchObject({ status: "not_allowed", offerId: "other" });

    // Signed.
    const installId = uuid();
    const token = uuid().toUpperCase();
    const before = Date.now();
    const r = await sign(app.sdkKey, { installId, productId: `${bundleId}.annual`, offerId: "save50", appAccountToken: token });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(r.json).sort()).toEqual(["jws", "keyId", "nonce", "offerId", "productId", "signature", "timestamp"]);
    expect(r.json).toMatchObject({ productId: `${bundleId}.annual`, offerId: "save50", keyId: KEY_ID });
    expect(r.json.nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(r.json.timestamp).toBeGreaterThanOrEqual(before);
    expect(r.json.timestamp).toBeLessThanOrEqual(Date.now());

    // Legacy: the exact payload, U+2063 separators, lowercase token and nonce, verified against the public key.
    const payload = [bundleId, KEY_ID, `${bundleId}.annual`, "save50", token.toLowerCase(), r.json.nonce, String(r.json.timestamp)].join("⁣");
    expect(SEPARATOR).toBe("⁣");
    expect(legacyPayload({ bundleId, keyId: KEY_ID, productId: `${bundleId}.annual`, offerId: "save50", appAccountToken: token, nonce: r.json.nonce, timestamp: r.json.timestamp })).toBe(payload);
    const der = fromB64(r.json.signature);
    const algo = { name: "ECDSA", hash: "SHA-256" };
    expect(await crypto.subtle.verify(algo, key.publicKey, derToRaw(der), new TextEncoder().encode(payload))).toBe(true);
    expect(await crypto.subtle.verify(algo, key.publicKey, derToRaw(der), new TextEncoder().encode(payload.replace("save50", "save60")))).toBe(false);

    // JWS: header, claims (no exp, iat in seconds), signature.
    const [h, p, s] = (r.json.jws as string).split(".");
    expect(JSON.parse(new TextDecoder().decode(fromB64url(h)))).toEqual({ alg: "ES256", kid: KEY_ID, typ: "JWT" });
    expect(JSON.parse(new TextDecoder().decode(fromB64url(p)))).toEqual({
      iss: ISSUER,
      iat: Math.floor(r.json.timestamp / 1000),
      aud: "promotional-offer",
      bid: bundleId,
      nonce: r.json.nonce,
      productId: `${bundleId}.annual`,
      offerIdentifier: "save50",
      appAccountToken: token.toLowerCase(),
    });
    expect(await crypto.subtle.verify(algo, key.publicKey, fromB64url(s), new TextEncoder().encode(`${h}.${p}`))).toBe(true);
    expect(await logOf(client, app.id, installId)).toMatchObject({ status: "signed", productId: `${bundleId}.annual`, offerId: "save50" });

    // Without appAccountToken the token field is empty.
    const plain = await sign(app.sdkKey, { installId: uuid(), productId: `${bundleId}.annual`, offerId: "save50" });
    expect(plain.status).toBe(200);
    const plainPayload = [bundleId, KEY_ID, `${bundleId}.annual`, "save50", "", plain.json.nonce, String(plain.json.timestamp)].join("⁣");
    expect(await crypto.subtle.verify(algo, key.publicKey, derToRaw(fromB64(plain.json.signature)), new TextEncoder().encode(plainPayload))).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(fromB64url((plain.json.jws as string).split(".")[1])))).not.toHaveProperty("appAccountToken");

    // Oversized bodies.
    expect((await sign(app.sdkKey, { installId: uuid(), productId: `${bundleId}.annual`, offerId: "save50", pad: "x".repeat(5000) })).status).toBe(413);

    // Deleting the In-App Purchase key stops signing at once (the isolate's cache is cleared).
    const creds = await call(client, "/api/v1/credentials");
    const iap = (creds.json.items as any[]).find((x) => x.kind === "appstore_iap");
    expect((await call(client, `/api/v1/credentials/${iap.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await sign(app.sdkKey, { installId: uuid(), productId: `${bundleId}.annual`, offerId: "save50" })).status).toBe(409);
  });

  it("samples refusals in the log (signatures always), carrying the count", () => {
    const t = Date.UTC(2026, 0, 1, 10);
    expect(logWeight("app_s", "signed", t)).toBe(1);
    for (let i = 0; i < REFUSAL_LOG_PER_HOUR; i++) expect(logWeight("app_s", "not_allowed", t + i)).toBe(1);
    for (let i = 1; i < REFUSAL_SAMPLE; i++) expect(logWeight("app_s", "not_subscribed", t + 100 + i)).toBe(0);
    expect(logWeight("app_s", "signed", t + 200)).toBe(1);
    expect(logWeight("app_s", "not_allowed", t + 300)).toBe(REFUSAL_SAMPLE);
    expect(logWeight("app_s", "not_allowed", t + 301)).toBe(0);
    expect(logWeight("other", "not_allowed", t + 301)).toBe(1);
    // Next hour: logged in full again, the skipped refusal is carried over.
    expect(logWeight("app_s", "not_configured", t + 3_600_000)).toBe(2);
    expect(logWeight("app_s", "not_configured", t + 3_600_001)).toBe(1);
  });

  it("stops logging (not signing) once the day's background budget is used up", async () => {
    const { client } = await setup("Offers budget");
    const bundleId = "com.example.offers.budget";
    const app = await createApp(client, bundleId);
    await call(client, `/api/v1/apps/${app.id}/offers`, { method: "PUT", body: { offers: [{ productId: `${bundleId}.annual`, offerId: "save50" }] } });
    const db = getDb(env);
    const k = `bg:${new Date().toISOString().slice(0, 10)}`;
    const old = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(k).first<{ value: string }>();
    await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, JSON.stringify({ w: 1e9, r: 0 })).run();
    try {
      expect((await sign(app.sdkKey, { installId: uuid(), productId: `${bundleId}.annual`, offerId: "save50" })).status).toBe(200);
      await new Promise((res) => setTimeout(res, 100));
      expect((await call(client, `/api/v1/apps/${app.id}/offers/log`)).json.items).toEqual([]);
    } finally {
      if (old) await db.prepare("UPDATE settings SET value = ? WHERE key = ?").bind(old.value, k).run();
      else await db.prepare("DELETE FROM settings WHERE key = ?").bind(k).run();
    }
  });

  it("answers 409 without an In-App Purchase key or bundle id", async () => {
    const { client } = await setup("Offers no key", { iapKey: false });
    const app = await createApp(client, "com.example.offers.nokey");
    expect((await call(client, `/api/v1/apps/${app.id}/offers`)).json.keyConfigured).toBe(false);
    await call(client, `/api/v1/apps/${app.id}/offers`, { method: "PUT", body: { offers: [{ productId: "com.example.offers.nokey.annual", offerId: "save50" }] } });
    const installId = uuid();
    const r = await sign(app.sdkKey, { installId, productId: "com.example.offers.nokey.annual", offerId: "save50" });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("not_configured");
    expect(await logOf(client, app.id, installId)).toMatchObject({ status: "not_configured" });

    // An app without a bundle id, in a workspace with a key.
    const { client: c2 } = await setup("Offers no bundle");
    const created = await call(c2, "/api/v1/apps", { body: { name: "No bundle", bundleId: "com.example.offers.nobundle" } });
    expect(created.status).toBe(201);
    // Apps imported from RevenueCat can lack a bundle id.
    await getDb(env).prepare("UPDATE apps SET bundle_id = NULL WHERE id = ?").bind(created.json.id).run();
    await call(c2, `/api/v1/apps/${created.json.id}/offers`, { method: "PUT", body: { offers: [{ productId: "p.annual", offerId: "save50" }] } });
    const nb = await sign(created.json.sdkKey, { installId: uuid(), productId: "p.annual", offerId: "save50" });
    expect(nb.status).toBe(409);
    expect(nb.json.code).toBe("not_configured");
  });

  it("rate limits per install and per app", async () => {
    const { client } = await setup("Offers rate");
    const bundleId = "com.example.offers.rate";
    const app = await createApp(client, bundleId);
    await call(client, `/api/v1/apps/${app.id}/offers`, { method: "PUT", body: { offers: [{ productId: `${bundleId}.annual`, offerId: "save50" }] } });
    const body = (installId: string) => ({ installId, productId: `${bundleId}.annual`, offerId: "save50" });
    const installId = uuid();
    for (let i = 0; i < OFFER_RATE_LIMITS.install.capacity; i++) expect((await sign(app.sdkKey, body(installId))).status).toBe(200);
    const limited = await sign(app.sdkKey, body(installId));
    expect(limited.status).toBe(429);
    expect(limited.json.code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await sign(app.sdkKey, body(uuid()))).status).toBe(200);

    const saved = OFFER_RATE_LIMITS.app.capacity;
    try {
      OFFER_RATE_LIMITS.app.capacity = 3;
      resetOffersState();
      for (let i = 0; i < 3; i++) expect((await sign(app.sdkKey, body(uuid()))).status).toBe(200);
      expect((await sign(app.sdkKey, body(uuid()))).status).toBe(429);
    } finally {
      OFFER_RATE_LIMITS.app.capacity = saved;
      resetOffersState();
    }
  });

  it("strict mode signs only for installs linked to a subscription of the product's group", async () => {
    const { client } = await setup("Offers strict");
    const bundleId = "com.example.offers.strict";
    const app = await createApp(client, bundleId);
    const annual = `${bundleId}.annual`;
    const saved = await call(client, `/api/v1/apps/${app.id}/offers`, {
      method: "PUT",
      body: { strict: true, offers: [{ productId: annual, offerId: "save50" }, { productId: `${bundleId}.other`, offerId: "save50" }] },
    });
    expect(saved.json.strict).toBe(true);

    // Subscriber: bought the monthly plan of group G1 with appAccountToken = install id (links the install).
    const subscriber = uuid();
    const g1 = { bundleId, subscriptionGroupIdentifier: "21000001" };
    const n = await notification("SUBSCRIBED", { ...g1, transactionId: "9100", productId: `${bundleId}.monthly`, purchaseDate: Date.now() - 40 * DAY, expiresDate: Date.now() - 10 * DAY, appAccountToken: subscriber });
    expect((await post(app.key, n.signedPayload)).status).toBe(200);
    // The annual plan is in G1 too (known from another sale); "other" is in group G2.
    const n2 = await notification("SUBSCRIBED", { ...g1, transactionId: "9101", productId: annual, purchaseDate: Date.now() - DAY, expiresDate: Date.now() + 300 * DAY });
    expect((await post(app.key, n2.signedPayload)).status).toBe(200);
    const n3 = await notification("SUBSCRIBED", { bundleId, subscriptionGroupIdentifier: "21000002", transactionId: "9102", productId: `${bundleId}.other`, purchaseDate: Date.now() - DAY, expiresDate: Date.now() + 30 * DAY });
    expect((await post(app.key, n3.signedPayload)).status).toBe(200);

    expect((await sign(app.sdkKey, { installId: subscriber, productId: annual, offerId: "save50" })).status).toBe(200);
    const stranger = uuid();
    const s = await sign(app.sdkKey, { installId: stranger, productId: annual, offerId: "save50" });
    expect(s.status).toBe(403);
    expect(s.json.code).toBe("offer_not_allowed");
    expect(await logOf(client, app.id, stranger)).toMatchObject({ status: "not_subscribed" });
    // Subscriber of G1 only: not for a product of G2.
    expect((await sign(app.sdkKey, { installId: subscriber, productId: `${bundleId}.other`, offerId: "save50" })).status).toBe(403);
  });

  it("keeps the last OFFER_LOG_SIZE log rows per app", async () => {
    const { client } = await setup("Offers log");
    const app = await createApp(client, "com.example.offers.log");
    const db = getDb(env);
    await db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO offer_signatures (app_id, seq, install_id, product_id, offer_id, status, at) SELECT ?, i, 'old', 'p', 'o', 'signed', i FROM n`,
      )
      .bind(OFFER_LOG_SIZE + OFFER_LOG_TRIM_EVERY - 2, app.id)
      .run();
    const span = () => db.prepare("SELECT COUNT(*) AS n, MIN(seq) AS lo, MAX(seq) AS hi FROM offer_signatures WHERE app_id = ?").bind(app.id).first<{ n: number; lo: number; hi: number }>();
    // Trimmed only when seq is a multiple of OFFER_LOG_TRIM_EVERY.
    await logSignature(db, app.id, { installId: "newer", productId: "p", offerId: "o", status: "not_allowed", at: Date.now(), count: 50 });
    expect(await span()).toEqual({ n: OFFER_LOG_SIZE + OFFER_LOG_TRIM_EVERY - 1, lo: 1, hi: OFFER_LOG_SIZE + OFFER_LOG_TRIM_EVERY - 1 });
    await logSignature(db, app.id, { installId: "newest", productId: "p", offerId: "o", status: "signed", at: Date.now() });
    expect(await span()).toEqual({ n: OFFER_LOG_SIZE, lo: OFFER_LOG_TRIM_EVERY + 1, hi: OFFER_LOG_SIZE + OFFER_LOG_TRIM_EVERY });
    const log = await call(client, `/api/v1/apps/${app.id}/offers/log?limit=3`);
    expect(log.json.items.map((x: any) => [x.installId, x.count])).toEqual([
      ["newest", 1],
      ["newer", 50],
      ["old", 1],
    ]);
  });

  it("lists lapsed subscribers (grace and billing retry excluded)", async () => {
    const { client } = await setup("Offers lapsed");
    const app = await createApp(client, "com.example.offers.lapsed");
    const ws = client.ws!;
    const db = getDb(env);
    const t = Date.now();
    const subs: [string, string, string, number, number, string][] = [
      // id, product, status, auto_renew, expires_at, environment
      ["l1", "monthly", "expired", 0, t - 5 * DAY, "Production"],
      ["l2", "monthly", "expired", 0, t - 20 * DAY, "Production"],
      ["l3", "annual", "expired", 0, t - 40 * DAY, "Production"],
      ["old", "monthly", "expired", 0, t - 200 * DAY, "Production"],
      ["renewing", "monthly", "expired", 1, t - 3 * DAY, "Production"],
      ["grace", "monthly", "grace", 0, t - 2 * DAY, "Production"],
      ["retry", "monthly", "billing_retry", 0, t - 2 * DAY, "Production"],
      ["refunded", "monthly", "refunded", 0, t - 2 * DAY, "Production"],
      ["sandbox", "monthly", "expired", 0, t - 2 * DAY, "Sandbox"],
      // Lapsed on one plan but subscribed again (another plan): not lapsed.
      ["back_old", "monthly", "expired", 0, t - 6 * DAY, "Production"],
      ["back_new", "annual", "active", 1, t + 300 * DAY, "Production"],
    ];
    const customerOf = (id: string) => (id === "l1" ? `cus_lapsed_${app.id}` : id.startsWith("back_") ? `cus_back_${app.id}` : null);
    await db.batch([
      db.prepare("INSERT INTO customers (id, workspace_id, app_id, first_seen_at, last_seen_at, total_usd) VALUES (?, ?, ?, ?, ?, ?)").bind(`cus_lapsed_${app.id}`, ws, app.id, t - 100 * DAY, t, 59.9),
      db.prepare("INSERT INTO customers (id, workspace_id, app_id, first_seen_at, last_seen_at, total_usd) VALUES (?, ?, ?, ?, ?, ?)").bind(`cus_back_${app.id}`, ws, app.id, t - 100 * DAY, t, 99.9),
      ...subs.map(([id, product, status, autoRenew, expires, environment]) =>
        db
          .prepare(
            `INSERT INTO subscriptions (id, workspace_id, app_id, customer_id, environment, original_transaction_id, product_id, status, auto_renew, started_at, expires_at, country, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'US', ?)`,
          )
          .bind(`sub_${id}_${app.id}`, ws, app.id, customerOf(id), environment, `ot_${id}`, product, status, autoRenew, t - 300 * DAY, expires, t),
      ),
    ]);
    const r = await call(client, `/api/v1/apps/${app.id}/lapsed?days=90`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ appId: app.id, days: 90, currency: "USD", total: 3 });
    expect(r.json.byProduct).toEqual([
      { productId: "monthly", productName: null, count: 2 },
      { productId: "annual", productName: null, count: 1 },
    ]);
    expect(r.json.items.map((i: any) => i.originalTransactionId)).toEqual(["ot_l1", "ot_l2", "ot_l3"]);
    expect(r.json.items[0]).toMatchObject({ customerId: `cus_lapsed_${app.id}`, totalPaid: 59.9, country: "US", productId: "monthly" });
    expect((await call(client, `/api/v1/apps/${app.id}/lapsed?days=10`)).json.total).toBe(1);
  });

  it("counts promotional and win-back redemptions per offer and labels them in the feed", async () => {
    const { client } = await setup("Offers stats");
    const bundleId = "com.example.offers.stats";
    const app = await createApp(client, bundleId);
    await call(client, `/api/v1/apps/${app.id}/offers`, { method: "PUT", body: { offers: [{ productId: `${bundleId}.annual`, offerId: "save50", label: "Half price" }] } });
    const sale = async (transactionId: string, offerType: number | undefined, offerIdentifier: string | undefined, price: number, daysAgo = 2) => {
      const n = await notification("SUBSCRIBED", {
        bundleId,
        transactionId,
        productId: `${bundleId}.annual`,
        purchaseDate: Date.now() - daysAgo * DAY,
        expiresDate: Date.now() + 300 * DAY,
        price,
        offerType,
        offerIdentifier,
        offerDiscountType: offerType ? "PAY_UP_FRONT" : undefined,
      });
      expect((await post(app.key, n.signedPayload)).status).toBe(200);
    };
    await sale("9300", 2, "save50", 29990);
    await sale("9301", 2, "save50", 29990);
    await sale("9302", 4, "comeback", 19990);
    await sale("9303", 1, undefined, 9990);
    await sale("9304", undefined, undefined, 59990);
    await sale("9305", 2, "save50", 29990, 200);

    const r = await call(client, `/api/v1/apps/${app.id}/offers/stats?range=90d`);
    expect(r.status).toBe(200);
    expect(r.json.totals.redemptions).toBe(3);
    expect(r.json.items).toHaveLength(2);
    const promo = r.json.items.find((i: any) => i.offerType === 2);
    expect(promo).toMatchObject({ offerTypeLabel: "Promotional", offerId: "save50", productId: `${bundleId}.annual`, label: "Half price", redemptions: 2 });
    expect(promo.revenue).toBeCloseTo(59.98, 2);
    expect(r.json.items.find((i: any) => i.offerType === 4)).toMatchObject({ offerTypeLabel: "Win-back", offerId: "comeback", label: null, redemptions: 1 });

    const feed = await call(client, `/api/v1/transactions?apps=${app.id}&limit=20`);
    const byId = new Map((feed.json.items as any[]).map((t) => [t.transactionId, t]));
    expect(byId.get("9302")).toMatchObject({ offerType: 4, offerId: "comeback", offer: "win-back (pay up front)" });
    expect(byId.get("9300")).toMatchObject({ offerType: 2, offerId: "save50", offer: "promotional (pay up front)" });
    expect(byId.get("9303").offer).toBe("pay up front");
    expect(byId.get("9304").offer).toBeNull();
  });

  it("imports promotional and win-back offers from App Store Connect", async () => {
    const { client } = await setup("Offers import");
    const created = await call(client, "/api/v1/apps", { body: { name: "Import", bundleId: "com.example.offers.import", appleAppId: "6400000001" } });
    expect(created.status).toBe(201);
    const appId = created.json.id as string;
    expect((await call(client, `/api/v1/apps/${appId}/offers/import`, { method: "POST" })).status).toBe(409);
    const key = await testKey();
    expect((await call(client, "/api/v1/credentials", { body: { kind: "appstore_connect", name: "ASC", keyId: "ASCKEY0001", issuerId: ISSUER, privateKey: key.pem } })).status).toBe(201);
    await call(client, `/api/v1/apps/${appId}/offers`, { method: "PUT", body: { offers: [{ productId: "com.example.offers.import.annual", offerId: "save50" }] } });

    const asc = fetchMock.get("https://api.appstoreconnect.apple.com");
    asc
      .intercept({ path: (p) => p.startsWith("/v1/apps/6400000001/subscriptionGroups") })
      .reply(200, { data: [], included: [{ type: "subscriptions", id: "sub1", attributes: { productId: "com.example.offers.import.annual" } }] });
    asc
      .intercept({ path: (p) => p.startsWith("/v1/subscriptions/sub1/promotionalOffers") })
      .reply(200, { data: [{ attributes: { name: "Half price", offerCode: "save50" } }, { attributes: { name: "Loyal", offerCode: "loyal20" } }] });
    asc.intercept({ path: (p) => p.startsWith("/v1/subscriptions/sub1/winBackOffers") }).reply(200, { data: [{ attributes: { referenceName: "Come back", offerId: "comeback" } }] });

    const r = await call(client, `/api/v1/apps/${appId}/offers/import`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ added: 2, found: 3, errors: [] });
    expect(r.json.settings.offers).toEqual([
      { productId: "com.example.offers.import.annual", offerId: "save50", label: "Half price", kind: "promotional" },
      { productId: "com.example.offers.import.annual", offerId: "loyal20", label: "Loyal", kind: "promotional" },
      { productId: "com.example.offers.import.annual", offerId: "comeback", label: "Come back", kind: "win_back" },
    ]);
  });
});
