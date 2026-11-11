import { describe, expect, it } from "vitest";
import { DAY, call, notification, ownerClient, signJws } from "./helpers";
import chain from "../fixtures/apple-test-chain.json";

async function createApp(bundleId: string) {
  const owner = await ownerClient();
  const r = await call(owner, "/api/v1/apps", { body: { name: bundleId.split(".").pop(), bundleId } });
  expect([200, 201]).toContain(r.status);
  const key = (r.json.revflareNotificationUrl as string).split("/").pop()!;
  return { owner, appId: r.json.id as string, key };
}

const post = (key: string, signedPayload: string) => call(null, `/apple/notifications/${key}`, { body: { signedPayload } });

describe("App Store Server Notifications", () => {
  it("accepts a TEST notification and marks the app connected", async () => {
    const { owner, appId, key } = await createApp("app.test.ping");
    const n = await notification("TEST", null, { bundleId: "app.test.ping" });
    const r = await post(key, n.signedPayload);
    expect(r.status).toBe(200);
    const app = await call(owner, `/api/v1/apps/${appId}`);
    expect(app.json.notificationUrlStatus).toBe("revflare");
    expect(app.json.lastNotificationAt).toBeGreaterThan(0);
  });

  it("rejects bad signatures, foreign chains, other bundles and unknown URLs", async () => {
    const { key } = await createApp("app.test.reject");
    const n = await notification("TEST", null, { bundleId: "app.test.reject" });
    const [h, p, s] = n.signedPayload.split(".");
    const tampered = `${h}.${p}.${s.slice(0, -4)}AAAA`;
    expect((await post(key, tampered)).status).toBe(400);
    // A chain whose root is not trusted (the intermediate posing as root).
    const foreign = await signJws({ notificationType: "TEST", notificationUUID: "x", signedDate: Date.now(), data: { bundleId: "app.test.reject" } }, [chain.leaf, chain.intermediate, chain.intermediate]);
    expect((await post(key, foreign)).status).toBe(400);
    const other = await notification("TEST", null, { bundleId: "app.test.other" });
    expect((await post(key, other.signedPayload)).status).toBe(400);
    expect((await post("nope", n.signedPayload)).status).toBe(404);
  });

  it("turns a trial, its conversion, a duplicate and a refund into the ledger", async () => {
    const bundleId = "app.test.subs";
    const { owner, appId, key } = await createApp(bundleId);
    const t0 = Date.now() - 10 * DAY;
    const trial = await notification(
      "SUBSCRIBED",
      { bundleId, transactionId: "1000", purchaseDate: t0, expiresDate: t0 + 7 * DAY, price: 0, offerType: 1, offerDiscountType: "FREE_TRIAL", storefront: "DEU", currency: "EUR" },
      { subtype: "INITIAL_BUY", renewal: { autoRenewStatus: 1 } },
    );
    expect((await post(key, trial.signedPayload)).status).toBe(200);
    const paid = await notification(
      "DID_RENEW",
      { bundleId, transactionId: "1001", originalTransactionId: "1000", purchaseDate: t0 + 7 * DAY, expiresDate: t0 + 37 * DAY, price: 9990, currency: "EUR", storefront: "DEU", transactionReason: "RENEWAL" },
      { renewal: { autoRenewStatus: 1 } },
    );
    expect((await post(key, paid.signedPayload)).status).toBe(200);
    // Apple retries: same UUID twice is stored once.
    const again = await post(key, paid.signedPayload);
    expect(again.json.duplicate).toBe(true);

    const feed = await call(owner, `/api/v1/transactions?apps=${appId}`);
    expect(feed.status).toBe(200);
    expect(feed.json.items.map((t: any) => t.kind)).toEqual(["conversion", "trial"]);
    const conversion = feed.json.items[0];
    expect(conversion.country).toBe("DE");
    expect(conversion.storePrice).toBeCloseTo(9.99);
    // Proceeds: VAT (19%) and the 15% commission removed.
    expect(conversion.proceeds).toBeCloseTo((conversion.price / 1.19) * 0.85, 4);

    const ov = await call(owner, `/api/v1/overview?apps=${appId}`);
    expect(ov.status).toBe(200);
    const mrr = ov.json.kpis.find((k: any) => k.id === "mrr");
    expect(mrr.value).toBeCloseTo(conversion.price, 4);
    expect(ov.json.kpis.find((k: any) => k.id === "active_subscriptions").value).toBe(1);

    // Customer page has both transactions and the subscription.
    const cust = await call(owner, `/api/v1/customers/${conversion.customerId}`);
    expect(cust.json.transactions).toHaveLength(2);
    expect(cust.json.subscriptions[0].status).toBe("active");

    // Auto-renew off → at risk.
    const off = await notification("DID_CHANGE_RENEWAL_STATUS", { bundleId, transactionId: "1001", originalTransactionId: "1000", purchaseDate: t0 + 7 * DAY, expiresDate: t0 + 37 * DAY, price: 9990, currency: "EUR", storefront: "DEU" }, { subtype: "AUTO_RENEW_DISABLED", renewal: { autoRenewStatus: 0 } });
    expect((await post(key, off.signedPayload)).status).toBe(200);
    const risk = await call(owner, `/api/v1/at-risk?apps=${appId}`);
    expect(risk.json.groups.find((g: any) => g.reason === "cancelled").subscriptions).toBe(1);

    // Refund of the paid period.
    const refund = await notification("REFUND", {
      bundleId,
      transactionId: "1001",
      originalTransactionId: "1000",
      purchaseDate: t0 + 7 * DAY,
      expiresDate: t0 + 37 * DAY,
      price: 9990,
      currency: "EUR",
      storefront: "DEU",
      revocationDate: Date.now() - DAY,
      revocationReason: 0,
    });
    expect((await post(key, refund.signedPayload)).status).toBe(200);
    const after = await call(owner, `/api/v1/overview?apps=${appId}`);
    expect(after.json.kpis.find((k: any) => k.id === "mrr").value).toBe(0);
    const refunds = await call(owner, `/api/v1/charts/refunds?apps=${appId}&range=30d`);
    expect(refunds.json.total).toBe(1);
  });

  it("handles one-time purchases", async () => {
    const bundleId = "app.test.lifetime";
    const { owner, appId, key } = await createApp(bundleId);
    const n = await notification("ONE_TIME_CHARGE", { bundleId, transactionId: "2000", productId: "full", type: "Non-Consumable", purchaseDate: Date.now() - 60_000, price: 4990, storefront: "USA" });
    expect((await post(key, n.signedPayload)).status).toBe(200);
    const feed = await call(owner, `/api/v1/transactions?apps=${appId}`);
    expect(feed.json.items[0].kind).toBe("one_time");
    const ov = await call(owner, `/api/v1/overview?apps=${appId}`);
    expect(ov.json.today.revenue).toBeCloseTo(4.99, 4);
    expect(ov.json.today.sales).toBe(1);
  });
});
