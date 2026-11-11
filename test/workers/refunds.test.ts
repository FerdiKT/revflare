import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import chain from "../fixtures/apple-test-chain.json";
import { getDb } from "../../worker/lib/db";
import { sendConsumptionInfo } from "../../worker/lib/refunds";
import { DAY, call, notification, ownerClient, type Client, type TxOptions } from "./helpers";

const STOREKIT = "https://api.storekit.itunes.apple.com";
const SANDBOX = "https://api.storekit-sandbox.itunes.apple.com";
const MIN = 60_000;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

type Sent = { body: Record<string, unknown>; auth: string };

/** Intercepts one Send Consumption Information request and records it. */
function interceptConsumption(host: string, transactionId: string, statusCode: number, sink: Sent[], data = "") {
  fetchMock
    .get(host)
    .intercept({ path: `/inApps/v2/transactions/consumption/${transactionId}`, method: "PUT" })
    .reply((opts) => {
      const h = opts.headers as Record<string, string> | string[] | undefined;
      let auth = "";
      if (Array.isArray(h)) for (let i = 0; i < h.length; i += 2) (h[i].toLowerCase() === "authorization" ? (auth = h[i + 1]) : null);
      else for (const [k, v] of Object.entries(h ?? {})) if (k.toLowerCase() === "authorization") auth = String(v);
      sink.push({ body: JSON.parse(String(opts.body)), auth });
      return { statusCode, data };
    });
}

async function addIapKey(client: Client) {
  const pem = `-----BEGIN PRIVATE KEY-----\n${chain.leafKey}\n-----END PRIVATE KEY-----`;
  const cred = await call(client, "/api/v1/credentials", { body: { kind: "appstore_iap", name: "IAP", keyId: "REFUNDKEY1", issuerId: "5f0c2a7e-3b9d-4e61-9a84-2d7c1e6b0f53", privateKey: pem } });
  expect(cred.status).toBe(201);
}

async function setup(name: string, opts: { iapKey?: boolean } = {}) {
  const owner = await ownerClient();
  const ws = await call(owner, "/api/v1/workspaces", { body: { name, currency: "USD" } });
  expect(ws.status).toBe(200);
  const client: Client = { ...owner, ws: ws.json.id };
  if (opts.iapKey !== false) await addIapKey(client);
  return client;
}

async function createApp(client: Client, name: string, bundleId: string) {
  const app = await call(client, "/api/v1/apps", { body: { name, bundleId } });
  expect(app.status).toBe(201);
  return { id: app.json.id as string, key: (app.json.revflareNotificationUrl as string).split("/").pop()! };
}

const post = (key: string, signedPayload: string) => call(null, `/apple/notifications/${key}`, { body: { signedPayload } });

/** Waits for the log row of a transaction to match (the first answer runs in waitUntil after the webhook). */
async function logRow(client: Client, appId: string, transactionId: string, until: (r: any) => boolean) {
  let row: any = null;
  for (let i = 0; i < 250; i++) {
    const log = await call(client, `/api/v1/apps/${appId}/integrations/refunds/log`);
    row = (log.json.items as any[]).find((x) => x.transactionId === transactionId) ?? null;
    if (row && until(row)) return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`log row for ${transactionId}: ${JSON.stringify(row)}`);
}

const request = (tx: TxOptions, opts: { signedDate?: number; reason?: string } = {}) =>
  notification("CONSUMPTION_REQUEST", tx, { signedDate: opts.signedDate, data: { consumptionRequestReason: opts.reason ?? "UNINTENDED_PURCHASE" } });

describe("refund requests (CONSUMPTION_REQUEST → Send Consumption Information)", () => {
  it("answers Apple's requests by the app's policy, retries, skips and expires", async () => {
    const client = await setup("Refunds");
    const bundleId = "com.example.refunds";
    const app = await createApp(client, "Refunds", bundleId);
    const url = `/api/v1/apps/${app.id}/integrations/refunds`;
    const put = (body: object) => call(client, url, { method: "PUT", body });

    // Defaults and validation: off, no attestation; turning on needs the attestation.
    const initial = await call(client, url);
    expect(initial.json).toMatchObject({ enabled: false, consentAttested: false, refundPolicy: "none", sampleContentProvided: false, consumptionPercent: null, deliveryStatus: "DELIVERED", stats: { pending: 0, sent: 0, skipped: 0, failed: 0, expired: 0 } });
    expect((await put({ enabled: true })).status).toBe(400);
    expect((await put({ refundPolicy: "maybe" })).status).toBe(400);
    expect((await put({ consumptionPercent: 120 })).status).toBe(400);
    expect((await put({ consentAttested: true, enabled: true, refundPolicy: "decline_if_delivered_after_days" })).status).toBe(400);
    const saved = await put({ consentAttested: true, enabled: true, refundPolicy: "decline_if_delivered_after_days", declineAfterDays: 30, consumptionPercent: 50 });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ enabled: true, consentAttested: true, consentAttestedBy: "Owner <owner@rf.test>", refundPolicy: "decline_if_delivered_after_days", declineAfterDays: 30, consumptionPercent: 50 });
    expect(saved.json.consentAttestedAt).toBeGreaterThan(0);

    // 1. A subscription started 60 days ago: DECLINE, and no consumptionPercentage (auto-renewable).
    const sent: Sent[] = [];
    interceptConsumption(STOREKIT, "8100", 202, sent);
    const sub: TxOptions = { bundleId, transactionId: "8100", productId: "monthly", purchaseDate: Date.now() - 60 * DAY, expiresDate: Date.now() + 2 * DAY, price: 4990 };
    expect((await post(app.key, (await request(sub)).signedPayload)).status).toBe(200);
    const first = await logRow(client, app.id, "8100", (r) => r.status !== "pending");
    expect(first).toMatchObject({ status: "sent", httpStatus: 202, attempts: 1, environment: "Production", requestReason: "UNINTENDED_PURCHASE", productId: "monthly", reason: null });
    expect(first.dueAt - first.receivedAt).toBeLessThanOrEqual(12 * 3_600_000);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({ customerConsented: true, deliveryStatus: "DELIVERED", sampleContentProvided: false, refundPreference: "DECLINE" });
    expect(sent[0].auth).toMatch(/^Bearer ey/);
    expect(first.request).toEqual(sent[0].body);

    // 2. A Sandbox consumable bought yesterday: younger than 30 days (no preference), consumption 50 % in milliunits.
    interceptConsumption(SANDBOX, "8200", 202, sent);
    const consumable: TxOptions = { bundleId, transactionId: "8200", productId: "coins", type: "Consumable", purchaseDate: Date.now() - DAY, price: 990, environment: "Sandbox" };
    expect((await post(app.key, (await request(consumable)).signedPayload)).status).toBe(200);
    expect(await logRow(client, app.id, "8200", (r) => r.status !== "pending")).toMatchObject({ status: "sent", environment: "Sandbox" });
    expect(sent[1].body).toEqual({ customerConsented: true, deliveryStatus: "DELIVERED", sampleContentProvided: false, consumptionPercentage: 50000 });

    // 3. Apple answers 500: retried by the cron with GRANT_PRORATED (no percentage for a subscription).
    expect((await put({ refundPolicy: "grant_prorated", sampleContentProvided: true })).status).toBe(200);
    interceptConsumption(STOREKIT, "8300", 500, sent, JSON.stringify({ errorCode: 5000000, errorMessage: "An unknown error occurred." }));
    const sub2: TxOptions = { bundleId, transactionId: "8300", productId: "monthly", purchaseDate: Date.now() - 3 * DAY, expiresDate: Date.now() + 27 * DAY, price: 4990 };
    expect((await post(app.key, (await request(sub2)).signedPayload)).status).toBe(200);
    const retrying = await logRow(client, app.id, "8300", (r) => r.attempts === 1);
    expect(retrying).toMatchObject({ status: "pending", httpStatus: 500, reason: expect.stringContaining("Retrying") });
    expect(await sendConsumptionInfo(env, { at: Date.now() + 30_000 })).toMatchObject({ requests: 0 });
    interceptConsumption(STOREKIT, "8300", 202, sent);
    expect(await sendConsumptionInfo(env, { at: Date.now() + 2 * MIN })).toMatchObject({ requests: 1, sent: 1 });
    expect(sent[3].body).toEqual({ customerConsented: true, deliveryStatus: "DELIVERED", sampleContentProvided: true, refundPreference: "GRANT_PRORATED" });
    expect((await logRow(client, app.id, "8300", () => true)).status).toBe("sent");

    // 4. The customer withdrew consent: their next request is skipped (no Apple call).
    const feed = await call(client, `/api/v1/transactions?apps=${app.id}`);
    const customerId = (feed.json.items as any[]).find((t) => t.transactionId === "8100").customerId as string;
    expect((await call(client, `/api/v1/customers/${customerId}/refund-consent`, { method: "PUT", body: { consent: "no" } })).status).toBe(400);
    expect((await call(client, `/api/v1/customers/cus_unknown/refund-consent`, { method: "PUT", body: { consent: false } })).status).toBe(404);
    expect((await call(client, `/api/v1/customers/${customerId}/refund-consent`, { method: "PUT", body: { consent: false } })).json).toEqual({ id: customerId, refundDataConsent: false });
    expect((await call(client, `/api/v1/customers/${customerId}`)).json.refundDataConsent).toBe(false);
    const renewal: TxOptions = { ...sub, transactionId: "8101", originalTransactionId: "8100", purchaseDate: Date.now() - 30 * DAY, transactionReason: "RENEWAL" };
    expect((await post(app.key, (await request(renewal)).signedPayload)).status).toBe(200);
    expect(await logRow(client, app.id, "8101", (r) => r.status !== "pending")).toMatchObject({ status: "skipped", reason: expect.stringContaining("withdrew"), httpStatus: null, request: null });

    // 5. Older than Apple's 12 hours: expired.
    const late: TxOptions = { ...consumable, transactionId: "8400", environment: "Production" };
    expect((await post(app.key, (await request(late, { signedDate: Date.now() - 13 * 3_600_000 })).signedPayload)).status).toBe(200);
    expect(await logRow(client, app.id, "8400", (r) => r.status !== "pending")).toMatchObject({ status: "expired", reason: expect.stringContaining("12-hour") });

    // 6. Turned off: skipped. Withdrawing the attestation turns it off too.
    expect((await put({ consentAttested: false })).json).toMatchObject({ enabled: false, consentAttested: false, consentAttestedBy: null });
    expect((await put({ enabled: true })).status).toBe(400);
    const off: TxOptions = { ...consumable, transactionId: "8500", environment: "Production" };
    expect((await post(app.key, (await request(off)).signedPayload)).status).toBe(200);
    expect(await logRow(client, app.id, "8500", (r) => r.status !== "pending")).toMatchObject({ status: "skipped", reason: expect.stringContaining("off") });

    const status = (await call(client, url)).json;
    expect(status.stats).toEqual({ pending: 0, sent: 3, skipped: 2, failed: 0, expired: 1 });
    expect(status.notifications).toMatchObject({ status: "revflare", forwarded: false });
    const log = (await call(client, `${url}/log?limit=2`)).json.items as any[];
    expect(log.map((r) => r.transactionId)).toEqual(["8500", "8400"]);
  }, 60_000);

  it("keeps retrying while the In-App Purchase key is missing and honours a 429's Retry-After", async () => {
    const client = await setup("Refunds no key", { iapKey: false });
    const bundleId = "com.example.refunds.nokey";
    const app = await createApp(client, "No key", bundleId);
    expect((await call(client, `/api/v1/apps/${app.id}/integrations/refunds`, { method: "PUT", body: { consentAttested: true, enabled: true, refundPolicy: "grant_full" } })).status).toBe(200);
    const product: TxOptions = { bundleId, transactionId: "9100", type: "Non-Consumable", productId: "pro", purchaseDate: Date.now() - DAY, price: 1990 };

    // No key yet: pending with a clear reason, not failed.
    expect((await post(app.key, (await request(product)).signedPayload)).status).toBe(200);
    const waiting = await logRow(client, app.id, "9100", (r) => r.attempts === 1);
    expect(waiting).toMatchObject({ status: "pending", httpStatus: null, reason: expect.stringContaining("Retrying: No In-App Purchase key") });
    expect(await sendConsumptionInfo(env, { appId: app.id, at: Date.now() + 30_000 })).toMatchObject({ requests: 0, retrying: 0 });
    // Still missing at the next try: backs off (5 minutes after the second attempt).
    expect(await sendConsumptionInfo(env, { appId: app.id, at: Date.now() + 2 * MIN })).toMatchObject({ requests: 0, retrying: 1, failed: 0 });
    expect(await logRow(client, app.id, "9100", () => true)).toMatchObject({ status: "pending", attempts: 2 });

    // The key is added: the next due run answers.
    await addIapKey(client);
    const sent: Sent[] = [];
    interceptConsumption(STOREKIT, "9100", 202, sent);
    expect(await sendConsumptionInfo(env, { appId: app.id, at: Date.now() + 4 * MIN })).toMatchObject({ requests: 0 });
    expect(await sendConsumptionInfo(env, { appId: app.id, at: Date.now() + 8 * MIN })).toMatchObject({ requests: 1, sent: 1 });
    expect(await logRow(client, app.id, "9100", () => true)).toMatchObject({ status: "sent", httpStatus: 202, attempts: 3, reason: null });
    expect(sent[0].body).toMatchObject({ refundPreference: "GRANT_FULL" });

    // 429 with Retry-After: 600 s waits 10 minutes, not the table's 1 minute.
    fetchMock
      .get(STOREKIT)
      .intercept({ path: "/inApps/v2/transactions/consumption/9200", method: "PUT" })
      .reply(429, JSON.stringify({ errorCode: 4290000, errorMessage: "Rate limit exceeded." }), { headers: { "retry-after": "600" } });
    expect((await post(app.key, (await request({ ...product, transactionId: "9200" })).signedPayload)).status).toBe(200);
    expect(await logRow(client, app.id, "9200", (r) => r.attempts === 1)).toMatchObject({ status: "pending", httpStatus: 429, reason: expect.stringContaining("Retrying") });
    expect(await sendConsumptionInfo(env, { appId: app.id, at: Date.now() + 2 * MIN })).toMatchObject({ requests: 0 });
    expect(await sendConsumptionInfo(env, { appId: app.id, at: Date.now() + 9 * MIN })).toMatchObject({ requests: 0 });
    interceptConsumption(STOREKIT, "9200", 202, sent);
    expect(await sendConsumptionInfo(env, { appId: app.id, at: Date.now() + 11 * MIN })).toMatchObject({ requests: 1, sent: 1 });

    // Missing key and Apple's deadline before the next try: expired, with the cause.
    const late = await setup("Refunds no key late", { iapKey: false });
    const lateApp = await createApp(late, "No key late", "com.example.refunds.nokey.late");
    expect((await call(late, `/api/v1/apps/${lateApp.id}/integrations/refunds`, { method: "PUT", body: { consentAttested: true, enabled: true } })).status).toBe(200);
    const n = await request({ ...product, bundleId: "com.example.refunds.nokey.late", transactionId: "9300" }, { signedDate: Date.now() - 12 * 3_600_000 + 30_000 });
    expect((await post(lateApp.key, n.signedPayload)).status).toBe(200);
    expect(await logRow(late, lateApp.id, "9300", (r) => r.status !== "pending")).toMatchObject({ status: "expired", reason: expect.stringMatching(/12-hour window \(No In-App Purchase key/) });
  }, 60_000);

  it("answers forwarded and polled requests too, by the workspace defaults", async () => {
    const client = await setup("Refunds elsewhere");
    // Workspace defaults: need the attestation like an app; apps without their own settings use them.
    const defaults = "/api/v1/integrations/refunds/defaults";
    expect((await call(client, defaults)).json).toMatchObject({ enabled: false, consentAttested: false, refundPolicy: "none", apps: { total: 0, usingDefaults: 0 } });
    expect((await call(client, defaults, { method: "PUT", body: { enabled: true } })).status).toBe(400);
    const d = await call(client, defaults, { method: "PUT", body: { consentAttested: true, enabled: true, refundPolicy: "decline" } });
    expect(d.status).toBe(200);
    expect(d.json).toMatchObject({ enabled: true, consentAttested: true, consentAttestedBy: "Owner <owner@rf.test>", refundPolicy: "decline" });

    // Forwarded to RevenueCat (which may not answer): Revflare answers too.
    const fwdBundle = "com.example.refunds.forwarded";
    const fwd = await createApp(client, "Forwarded", fwdBundle);
    expect((await call(client, `/api/v1/apps/${fwd.id}`, { method: "PATCH", body: { forwardNotificationUrl: "https://rc.example.com/hook/refunds" } })).status).toBe(200);
    expect((await call(client, `/api/v1/apps/${fwd.id}/integrations/refunds`)).json).toMatchObject({ source: "workspace", enabled: true, refundPolicy: "decline" });
    let forwarded = 0;
    fetchMock
      .get("https://rc.example.com")
      .intercept({ path: "/hook/refunds", method: "POST" })
      .reply(() => (forwarded++, { statusCode: 200, data: "{}" }));
    const sent: Sent[] = [];
    interceptConsumption(STOREKIT, "8700", 202, sent);
    const n = await request({ bundleId: fwdBundle, transactionId: "8700", type: "Non-Consumable", productId: "pro", purchaseDate: Date.now() - 20 * MIN, price: 1990 });
    expect((await post(fwd.key, n.signedPayload)).status).toBe(200);
    expect(await logRow(client, fwd.id, "8700", (r) => r.status !== "pending")).toMatchObject({ status: "sent", httpStatus: 202 });
    expect(sent[0].body).toEqual({ customerConsented: true, deliveryStatus: "DELIVERED", sampleContentProvided: false, refundPreference: "DECLINE" });
    for (let i = 0; i < 250 && !forwarded; i++) await new Promise((r) => setTimeout(r, 20));
    expect(forwarded).toBe(1);

    // Notifications go to another server: a fresh request polled from Notification History is answered; an old one is history.
    const otherBundle = "com.example.refunds.other";
    const other = await createApp(client, "Other", otherBundle);
    const h = await request({ bundleId: otherBundle, transactionId: "8800", type: "Non-Consumable", productId: "pro", purchaseDate: Date.now() - DAY, price: 1990 });
    const old = await request({ bundleId: otherBundle, transactionId: "8801", type: "Non-Consumable", productId: "pro", purchaseDate: Date.now() - 3 * DAY }, { signedDate: Date.now() - 2 * DAY });
    fetchMock
      .get(STOREKIT)
      .intercept({ path: "/inApps/v1/notifications/history", method: "POST" })
      .reply(200, { notificationHistory: [{ signedPayload: old.signedPayload }, { signedPayload: h.signedPayload }], hasMore: false });
    const sync = await call(client, `/api/v1/apps/${other.id}/sync`, { method: "POST" });
    expect(sync.json.history).toMatchObject({ processed: 2, done: true });
    const polled = (await call(client, `/api/v1/apps/${other.id}/integrations/refunds/log`)).json.items as any[];
    expect(polled.map((r) => [r.transactionId, r.status])).toEqual([["8800", "pending"]]);
    interceptConsumption(STOREKIT, "8800", 202, sent);
    expect(await sendConsumptionInfo(env, { appId: other.id })).toMatchObject({ requests: 1, sent: 1 });

    // An app's own settings win; useDefaults goes back to the workspace's.
    expect((await call(client, `/api/v1/apps/${other.id}/integrations/refunds`, { method: "PUT", body: { refundPolicy: "none" } })).json).toMatchObject({ source: "app", enabled: true, consentAttested: true, refundPolicy: "none" });
    expect((await call(client, defaults)).json.apps).toEqual({ total: 2, usingDefaults: 1 });
    expect((await call(client, `/api/v1/apps/${other.id}/integrations/refunds`, { method: "PUT", body: { useDefaults: true } })).json).toMatchObject({ source: "workspace", refundPolicy: "decline" });
  }, 60_000);

  it("raises an alert when a production request goes unanswered, once per app and day", async () => {
    const client = await setup("Refunds unanswered");
    const bundleId = "com.example.refunds.unanswered";
    const app = await createApp(client, "Unanswered", bundleId);
    const alerts = async () => ((await call(client, "/api/v1/alerts")).json.items as any[]).filter((a) => a.kind === "refund_request_unanswered");

    // Off (no settings): skipped, and an alert says so.
    const tx: TxOptions = { bundleId, transactionId: "9500", type: "Non-Consumable", productId: "pro", purchaseDate: Date.now() - DAY, price: 1990 };
    expect((await post(app.key, (await request(tx)).signedPayload)).status).toBe(200);
    expect(await logRow(client, app.id, "9500", (r) => r.status !== "pending")).toMatchObject({ status: "skipped", reason: expect.stringContaining("off") });
    let list: any[] = [];
    for (let i = 0; i < 250 && !list.length; i++) (list = await alerts()), list.length || (await new Promise((r) => setTimeout(r, 20)));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ appId: app.id, severity: "warning", title: expect.stringContaining("Unanswered"), body: expect.stringContaining("9500") });
    // The overview shows it.
    expect(((await call(client, "/api/v1/overview")).json.alerts as any[]).some((a) => a.kind === "refund_request_unanswered")).toBe(true);

    // A second one the same day: still one alert. Sandbox requests never alert.
    expect((await post(app.key, (await request({ ...tx, transactionId: "9501" })).signedPayload)).status).toBe(200);
    expect((await post(app.key, (await request({ ...tx, transactionId: "9502", environment: "Sandbox" })).signedPayload)).status).toBe(200);
    await logRow(client, app.id, "9502", (r) => r.status !== "pending");
    await logRow(client, app.id, "9501", (r) => r.status !== "pending");
    expect(await alerts()).toHaveLength(1);

    // Apple refuses (4xx, not retried): failed, alert stays one per day; an accepted answer resolves it.
    expect((await call(client, `/api/v1/apps/${app.id}/integrations/refunds`, { method: "PUT", body: { consentAttested: true, enabled: true } })).status).toBe(200);
    const sent: Sent[] = [];
    interceptConsumption(STOREKIT, "9503", 400, sent, JSON.stringify({ errorCode: 4000000, errorMessage: "Invalid request." }));
    expect((await post(app.key, (await request({ ...tx, transactionId: "9503" })).signedPayload)).status).toBe(200);
    expect(await logRow(client, app.id, "9503", (r) => r.status !== "pending")).toMatchObject({ status: "failed", httpStatus: 400 });
    interceptConsumption(STOREKIT, "9504", 202, sent);
    expect((await post(app.key, (await request({ ...tx, transactionId: "9504" })).signedPayload)).status).toBe(200);
    await logRow(client, app.id, "9504", (r) => r.status === "sent");
    let open: any[] = [];
    for (let i = 0; i < 250; i++) {
      open = (await alerts()).filter((a) => !a.resolvedAt);
      if (!open.length) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(open).toEqual([]);
  }, 60_000);

  it("counts prorated refunds in part (revocationPercentage)", async () => {
    const client = await setup("Prorated");
    const bundleId = "com.example.refunds.prorated";
    const app = await createApp(client, "Prorated", bundleId);
    const purchase: TxOptions = { bundleId, transactionId: "8900", productId: "pack", type: "Consumable", purchaseDate: Date.now() - 2 * DAY, price: 10000 };
    expect((await post(app.key, (await notification("ONE_TIME_CHARGE", purchase)).signedPayload)).status).toBe(200);
    const revenue = async () => (await call(client, `/api/v1/charts/revenue?apps=${app.id}&range=7d`)).json.total as number;
    expect(await revenue()).toBeCloseTo(10, 4);

    // Apple granted 40 %: revenue keeps 6.00, refunds 4.00.
    const refund = await notification("REFUND", { ...purchase, revocationDate: Date.now() - 60_000, revocationReason: 0, revocationPercentage: 40000, revocationType: "REFUND_PRORATED" });
    expect((await post(app.key, refund.signedPayload)).status).toBe(200);
    expect(await revenue()).toBeCloseTo(6, 4);
    expect((await call(client, `/api/v1/charts/refunds_amount?apps=${app.id}&range=7d`)).json.total).toBeCloseTo(4, 4);
    expect((await call(client, `/api/v1/charts/refunds?apps=${app.id}&range=7d`)).json.total).toBe(1);
    // The refund event (and its push) carries the refunded part, not the full price.
    const refundEvents = await getDb(env).prepare("SELECT transaction_id, amount_usd FROM events WHERE app_id = ? AND type = 'REFUND' ORDER BY transaction_id").bind(app.id).all<{ transaction_id: string; amount_usd: number }>();
    expect(refundEvents.results).toHaveLength(1);
    expect(refundEvents.results[0].amount_usd).toBeCloseTo(4, 4);
    const feed = await call(client, `/api/v1/transactions?apps=${app.id}`);
    const tx = (feed.json.items as any[])[0];
    expect(tx).toMatchObject({ transactionId: "8900", refundPercentage: 40 });
    expect((await call(client, `/api/v1/customers/${tx.customerId}`)).json.totalSpent).toBeCloseTo(6, 4);
    const byProduct = await call(client, `/api/v1/breakdown?metric=revenue&by=product&apps=${app.id}&range=7d`);
    expect(byProduct.json.rows[0].value).toBeCloseTo(6, 4);

    // A full refund of another purchase still takes everything back.
    const other: TxOptions = { ...purchase, transactionId: "8901", price: 5000 };
    expect((await post(app.key, (await notification("ONE_TIME_CHARGE", other)).signedPayload)).status).toBe(200);
    expect(await revenue()).toBeCloseTo(11, 4);
    const full = await notification("REFUND", { ...other, revocationDate: Date.now() - 30_000, revocationReason: 1, revocationPercentage: 100000, revocationType: "REFUND_FULL" });
    expect((await post(app.key, full.signedPayload)).status).toBe(200);
    expect(await revenue()).toBeCloseTo(6, 4);
    expect((await call(client, `/api/v1/customers/${tx.customerId}`)).json.totalSpent).toBeCloseTo(6, 4);
    const fullEvent = await getDb(env).prepare("SELECT amount_usd FROM events WHERE app_id = ? AND type = 'REFUND' AND transaction_id = '8901'").bind(app.id).first<{ amount_usd: number }>();
    expect(fullEvent?.amount_usd).toBeCloseTo(5, 4);
  }, 60_000);
});
