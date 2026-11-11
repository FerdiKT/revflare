import { fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import chain from "../fixtures/apple-test-chain.json";
import { DAY, call, notification, ownerClient, signJws, txPayload } from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const STOREKIT = "https://api.storekit.itunes.apple.com";

describe("Apple history sync (apps whose notifications go to RevenueCat)", () => {
  it("pulls Notification History, then each customer's Transaction History", async () => {
    const owner = await ownerClient();
    const pem = `-----BEGIN PRIVATE KEY-----\n${chain.leafKey}\n-----END PRIVATE KEY-----`;
    const cred = await call(owner, "/api/v1/credentials", { body: { kind: "appstore_iap", name: "IAP", keyId: "ABCDEFGHIJ", issuerId: "5f0c2a7e-3b9d-4e61-9a84-2d7c1e6b0f53", privateKey: pem } });
    expect(cred.status).toBe(201);
    const bundleId = "app.test.polled";
    const app = await call(owner, "/api/v1/apps", { body: { name: "Polled", bundleId } });
    const t0 = Date.now() - 400 * DAY;

    // Notification History: one renewal from 20 days ago (the customer started 400 days ago).
    const renewal = await notification("DID_RENEW", {
      bundleId,
      transactionId: "5003",
      originalTransactionId: "5000",
      productId: "yearly",
      purchaseDate: Date.now() - 20 * DAY,
      expiresDate: Date.now() + 345 * DAY,
      price: 29990,
      transactionReason: "RENEWAL",
      storefront: "TUR",
      currency: "TRY",
    });
    fetchMock
      .get(STOREKIT)
      .intercept({ path: "/inApps/v1/notifications/history", method: "POST" })
      .reply(200, { notificationHistory: [{ signedPayload: renewal.signedPayload }], hasMore: false });

    // Transaction History of that customer: the first purchase a year earlier (outside the 180 days) and the renewal.
    const first = await signJws(txPayload({ bundleId, transactionId: "5000", productId: "yearly", purchaseDate: t0, expiresDate: t0 + 365 * DAY, price: 24990, storefront: "TUR", currency: "TRY" }));
    const second = await signJws(
      txPayload({ bundleId, transactionId: "5003", originalTransactionId: "5000", productId: "yearly", purchaseDate: Date.now() - 20 * DAY, expiresDate: Date.now() + 345 * DAY, price: 29990, transactionReason: "RENEWAL", storefront: "TUR", currency: "TRY" }),
    );
    fetchMock
      .get(STOREKIT)
      .intercept({ path: (p) => p.startsWith("/inApps/v2/history/5000"), method: "GET" })
      .reply(200, { signedTransactions: [first, second], hasMore: false, revision: "r1" });
    const renewalInfo = await signJws({ originalTransactionId: "5000", autoRenewStatus: 0, autoRenewProductId: "yearly", signedDate: Date.now(), renewalPrice: 29990, currency: "TRY" });
    fetchMock
      .get(STOREKIT)
      .intercept({ path: "/inApps/v1/subscriptions/5000", method: "GET" })
      .reply(200, { data: [{ subscriptionGroupIdentifier: "g", lastTransactions: [{ originalTransactionId: "5000", status: 1, signedTransactionInfo: second, signedRenewalInfo: renewalInfo }] }] });

    const sync = await call(owner, `/api/v1/apps/${app.json.id}/sync`, { method: "POST" });
    expect(sync.status).toBe(200);
    expect(sync.json.history).toMatchObject({ processed: 1, done: true });
    expect(sync.json.transactions).toMatchObject({ customers: 1, transactions: 2, remaining: 0 });

    const feed = await call(owner, `/api/v1/transactions?apps=${app.json.id}`);
    expect(feed.json.items.map((t: any) => [t.transactionId, t.kind])).toEqual([
      ["5003", "renewal"],
      ["5000", "new"],
    ]);
    expect(feed.json.items[0].country).toBe("TR");
    // The status call learned that auto-renew is off: the yearly subscription is at risk.
    const risk = await call(owner, `/api/v1/at-risk?apps=${app.json.id}`);
    expect(risk.json.items).toHaveLength(1);
    const appRow = await call(owner, `/api/v1/apps/${app.json.id}`);
    expect(appRow.json.historyBackfilledFrom).toBeTruthy();
    expect(appRow.json.mrr).toBeGreaterThan(0);
  });
});

describe("unreleased apps", () => {
  it("marks an app Apple answers 401 for as not on the store yet", async () => {
    const owner = await ownerClient();
    const app = await call(owner, "/api/v1/apps", { body: { name: "Unreleased", bundleId: "app.test.unreleased" } });
    fetchMock.get(STOREKIT).intercept({ path: "/inApps/v1/notifications/history", method: "POST" }).reply(401, "");
    const sync = await call(owner, `/api/v1/apps/${app.json.id}/sync`, { method: "POST" });
    expect(sync.json.history).toMatchObject({ done: true, unavailable: true });
    expect((await call(owner, `/api/v1/apps/${app.json.id}`)).json.storeAvailable).toBe(false);
  });
});
