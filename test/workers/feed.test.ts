import { describe, expect, it } from "vitest";
import { DAY, call, notification, ownerClient } from "./helpers";

describe("transactions feed", () => {
  it("keeps renewals announced ahead of their period out of the feed and the totals until they start", async () => {
    const owner = await ownerClient();
    const bundleId = "com.example.feed";
    const app = await call(owner, "/api/v1/apps", { body: { name: "Feed", bundleId } });
    const key = (app.json.revflareNotificationUrl as string).split("/").pop()!;
    const post = async (n: { signedPayload: string }) => expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: n.signedPayload } })).status).toBe(200);
    const now = Date.now();
    await post(await notification("ONE_TIME_CHARGE", { bundleId, transactionId: "9500", type: "Non-Consumable", purchaseDate: now - 60_000, price: 1990 }));
    await post(await notification("ONE_TIME_CHARGE", { bundleId, transactionId: "9501", type: "Non-Consumable", purchaseDate: now - DAY - 60_000, price: 2990 }));
    // Apple bills a renewal ahead of time: its period (purchaseDate) starts in 3 hours.
    await post(await notification("DID_RENEW", { bundleId, transactionId: "9503", originalTransactionId: "9502", purchaseDate: now + 3 * 3_600_000, expiresDate: now + 33 * DAY, price: 4990, transactionReason: "RENEWAL" }));

    const feed = await call(owner, `/api/v1/transactions?apps=${app.json.id}`);
    expect(feed.json.items.map((t: any) => t.transactionId)).toEqual(["9500", "9501"]);
    expect(feed.json.days.map((d: any) => [d.revenue, d.count])).toEqual([[1.99, 1], [2.99, 1]]);
    const upcoming = await call(owner, `/api/v1/transactions?apps=${app.json.id}&upcoming=true`);
    expect(upcoming.json.items.map((t: any) => t.transactionId)).toEqual(["9503"]);
    expect(upcoming.json.days).toEqual([]);
    const ov = await call(owner, `/api/v1/overview?apps=${app.json.id}`);
    expect(ov.json.today.revenue).toBeCloseTo(1.99, 2);
    // Local days (tzOffset): from the transactions, the announced renewal still left out.
    const local = await call(owner, `/api/v1/overview?apps=${app.json.id}&tzOffset=0`);
    expect([local.json.today.revenue, local.json.today.sales, local.json.yesterday.revenue]).toEqual([1.99, 1, 2.99]);
  });

  it("marks cancelled trials: feed autoRenew, customer autoRenewOffAt and the Apple history", async () => {
    const owner = await ownerClient();
    const bundleId = "com.example.cancelled";
    const app = await call(owner, "/api/v1/apps", { body: { name: "Cancelled", bundleId } });
    const key = (app.json.revflareNotificationUrl as string).split("/").pop()!;
    const post = async (n: { signedPayload: string }) => expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: n.signedPayload } })).status).toBe(200);
    const t0 = Date.now() - 2 * DAY;
    const trial = { bundleId, transactionId: "9600", purchaseDate: t0, expiresDate: t0 + 7 * DAY, price: 0, offerType: 1, offerDiscountType: "FREE_TRIAL", storefront: "CHN", currency: "CNY" };
    await post(await notification("SUBSCRIBED", trial, { subtype: "INITIAL_BUY", signedDate: t0, renewal: { autoRenewStatus: 1 } }));
    // A second trial that keeps auto-renew on, and a one-time purchase (no autoRenew).
    await post(await notification("SUBSCRIBED", { ...trial, transactionId: "9610", purchaseDate: t0 + 1000 }, { subtype: "INITIAL_BUY", renewal: { autoRenewStatus: 1 } }));
    await post(await notification("ONE_TIME_CHARGE", { bundleId, transactionId: "9620", type: "Consumable", purchaseDate: t0 + 2000, price: 990 }));
    const offAt = t0 + DAY;
    await post(await notification("DID_CHANGE_RENEWAL_STATUS", trial, { subtype: "AUTO_RENEW_DISABLED", signedDate: offAt, renewal: { autoRenewStatus: 0 } }));

    const feed = await call(owner, `/api/v1/transactions?apps=${app.json.id}`);
    const by = Object.fromEntries(feed.json.items.map((t: any) => [t.transactionId, t]));
    expect(by["9600"]).toMatchObject({ kind: "trial", autoRenew: false });
    expect(by["9610"]).toMatchObject({ kind: "trial", autoRenew: true });
    expect(by["9620"].autoRenew).toBeUndefined();

    const cust = await call(owner, `/api/v1/customers/${by["9600"].customerId}`);
    expect(cust.json.subscriptions).toHaveLength(1);
    expect(cust.json.subscriptions[0]).toMatchObject({ status: "trial", autoRenew: false, autoRenewOffAt: offAt });
    expect(cust.json.events.map((e: any) => [e.type, e.subtype, e.at])).toEqual([
      ["DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_DISABLED", offAt],
      ["SUBSCRIBED", "INITIAL_BUY", t0],
    ]);
    expect(cust.json.events[0]).toMatchObject({ productId: "monthly", environment: "Production", transactionId: "9600" });
    // Auto-renew back on: no longer cancelled.
    await post(await notification("DID_CHANGE_RENEWAL_STATUS", trial, { subtype: "AUTO_RENEW_ENABLED", signedDate: offAt + 1000, renewal: { autoRenewStatus: 1 } }));
    const again = await call(owner, `/api/v1/customers/${by["9600"].customerId}`);
    expect(again.json.subscriptions[0]).toMatchObject({ autoRenew: true, autoRenewOffAt: null });
    expect(again.json.events).toHaveLength(3);
    const other = await call(owner, `/api/v1/customers/${by["9610"].customerId}`);
    expect(other.json.subscriptions[0]).toMatchObject({ autoRenew: true, autoRenewOffAt: null });
    expect(other.json.events.map((e: any) => e.type)).toEqual(["SUBSCRIBED"]);
  });
});
