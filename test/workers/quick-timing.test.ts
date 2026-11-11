import { describe, expect, it } from "vitest";
import { DAY, call, notification, ownerClient } from "./helpers";

const MIN = 60_000;
const SEC = 1000;
const OFF = { subtype: "AUTO_RENEW_DISABLED", renewal: { autoRenewStatus: 0 } };

describe("customer timing and quick buyers / cancellers", () => {
  it("returns first / last seen with their sources, install time, durations and quick flags at 4:59 vs 5:01; feed rows, quick filter and cancellations", async () => {
    const owner = await ownerClient();
    const bundleId = "com.example.quick";
    const app = await call(owner, "/api/v1/apps", { body: { name: "Quick", bundleId } });
    const appId = app.json.id as string;
    const sdkKey = app.json.sdkKey as string;
    const key = (app.json.revflareNotificationUrl as string).split("/").pop()!;
    const post = async (n: { signedPayload: string }) => expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: n.signedPayload } })).status).toBe(200);
    const report = async (body: object) => expect((await call(null, "/sdk/v1/report", { body: { sdkKey, ...body } })).status).toBe(200);

    const t0 = Date.now() - 2 * DAY;
    // A: installed 4:59 before a trial, cancelled it 5:01 after.
    const A = "aaaaaaaa-0000-4000-8000-00000000000a";
    const aTrial = { bundleId, transactionId: "97000", purchaseDate: t0, expiresDate: t0 + 7 * DAY, price: 0, offerType: 1, offerDiscountType: "FREE_TRIAL", appAccountToken: A };
    // B: installed 5:01 before a purchase, cancelled it 4:59 after.
    const B = "bbbbbbbb-0000-4000-8000-00000000000b";
    const tB = t0 + 3 * 3_600_000;
    const bBuy = { bundleId, transactionId: "97100", purchaseDate: tB, expiresDate: tB + 30 * DAY, price: 4990 };
    // C: no install, bought and kept auto-renew on.
    const tC = t0 + 6 * 3_600_000;
    const cBuy = { bundleId, transactionId: "97200", purchaseDate: tC, expiresDate: tC + 30 * DAY, price: 4990 };

    await report({ installId: A, installedAt: t0 - (4 * MIN + 59 * SEC) });
    await report({ installId: B, installedAt: tB - (5 * MIN + 1 * SEC), originalTransactionIds: ["97100"] });
    await post(await notification("SUBSCRIBED", aTrial, { subtype: "INITIAL_BUY", signedDate: t0, renewal: { autoRenewStatus: 1 } }));
    await post(await notification("SUBSCRIBED", bBuy, { subtype: "INITIAL_BUY", signedDate: tB, renewal: { autoRenewStatus: 1 } }));
    await post(await notification("SUBSCRIBED", cBuy, { subtype: "INITIAL_BUY", signedDate: tC, renewal: { autoRenewStatus: 1 } }));
    await post(await notification("DID_CHANGE_RENEWAL_STATUS", aTrial, { ...OFF, signedDate: t0 + 5 * MIN + 1 * SEC }));
    await post(await notification("DID_CHANGE_RENEWAL_STATUS", bBuy, { ...OFF, signedDate: tB + 4 * MIN + 59 * SEC }));

    // Feed: sinceInstallMs on the first purchases, cancelledAfterMs, quick.
    const feed = await call(owner, `/api/v1/transactions?apps=${appId}`);
    expect(feed.status).toBe(200);
    const by = Object.fromEntries(feed.json.items.map((t: any) => [t.transactionId, t]));
    expect(by["97000"]).toMatchObject({ kind: "trial", sinceInstallMs: 299_000, cancelledAfterMs: 301_000, quick: true });
    expect(by["97100"]).toMatchObject({ kind: "new", sinceInstallMs: 301_000, cancelledAfterMs: 299_000, quick: true });
    expect(by["97200"]).toMatchObject({ sinceInstallMs: null, cancelledAfterMs: null, quick: false });

    const quick = await call(owner, `/api/v1/transactions?apps=${appId}&quick=true`);
    expect(quick.json.items.map((t: any) => t.transactionId)).toEqual(["97100", "97000"]);
    expect(quick.json.days).toEqual([]);

    // Customer A: bought 4:59 after installing (quick), cancelled 5:01 after (not quick).
    const a = await call(owner, `/api/v1/customers/${by["97000"].customerId}`);
    expect(a.json).toMatchObject({ installedAt: t0 - 299_000, installedAtSource: "device", firstSeenAt: t0 - 299_000, firstSeenSource: "install", lastSeenSource: "app" });
    expect(a.json.lastSeenAt).toBeGreaterThan(Date.now() - MIN);
    expect(a.json.timing).toMatchObject({
      firstPurchaseAt: t0,
      firstPurchaseKind: "trial",
      installToPurchaseMs: 299_000,
      purchaseToCancelMs: 301_000,
      cancelledAt: t0 + 301_000,
      purchaseToRefundMs: null,
      quickPurchase: true,
      quickCancel: false,
    });
    expect(a.json.subscriptions[0]).toMatchObject({ autoRenewOffAt: t0 + 301_000, cancelledAfterMs: 301_000 });
    expect(a.json.transactions[0].sinceInstallMs).toBe(299_000);

    // Customer B: 5:01 after installing (not quick), cancelled 4:59 after buying (quick).
    const b = await call(owner, `/api/v1/customers/${by["97100"].customerId}`);
    expect(b.json.timing).toMatchObject({ installToPurchaseMs: 301_000, purchaseToCancelMs: 299_000, quickPurchase: false, quickCancel: true });

    // Customer C: no install; first / last seen from the store.
    const c = await call(owner, `/api/v1/customers/${by["97200"].customerId}`);
    expect(c.json).toMatchObject({ installedAt: null, installedAtSource: null, firstSeenAt: tC, firstSeenSource: "purchase", lastSeenAt: tC });
    expect(["purchase", "notification"]).toContain(c.json.lastSeenSource);
    expect(c.json.timing).toMatchObject({ installToPurchaseMs: null, purchaseToCancelMs: null, quickPurchase: false, quickCancel: false });

    // Cancellations stream: newest first, linked to the customer, with the time since the purchase.
    const cancels = await call(owner, `/api/v1/transactions?apps=${appId}&cancellations=true`);
    expect(cancels.json.items.map((t: any) => [t.kind, t.transactionId, t.sincePurchaseMs, t.purchaseKind, t.quick])).toEqual([
      ["cancellation", "97100", 299_000, "new", true],
      ["cancellation", "97000", 301_000, "trial", false],
    ]);
    expect(cancels.json.items[0]).toMatchObject({ customerId: by["97100"].customerId, purchasedAt: tB + 299_000, autoRenew: false, price: 0 });
    expect(cancels.json.days.reduce((n: number, d: any) => n + d.count, 0)).toBe(2);
    const quickCancels = await call(owner, `/api/v1/transactions?apps=${appId}&cancellations=true&quick=true`);
    expect(quickCancels.json.items.map((t: any) => t.transactionId)).toEqual(["97100"]);
    // Cursor pages.
    const p1 = await call(owner, `/api/v1/transactions?apps=${appId}&cancellations=true&limit=1`);
    expect(p1.json.items.map((t: any) => t.transactionId)).toEqual(["97100"]);
    const p2 = await call(owner, `/api/v1/transactions?apps=${appId}&cancellations=true&limit=1&cursor=${p1.json.nextCursor}`);
    expect(p2.json.items.map((t: any) => t.transactionId)).toEqual(["97000"]);

    // Tenancy: another workspace sees neither the customer nor the cancellations; no session, no access.
    const ws2 = await call(owner, "/api/v1/workspaces", { body: { name: "Quick other", currency: "USD" } });
    const other = { ...owner, ws: ws2.json.id as string };
    expect((await call(other, `/api/v1/customers/${by["97100"].customerId}`)).status).toBe(404);
    expect((await call(other, "/api/v1/transactions?cancellations=true")).json.items).toEqual([]);
    expect((await call(other, "/api/v1/transactions?quick=true")).json.items).toEqual([]);
    expect((await call(null, `/api/v1/transactions?cancellations=true`)).status).toBe(401);
  }, 120_000);

  it("measures purchase → refund", async () => {
    const owner = await ownerClient();
    const bundleId = "com.example.quick.refund";
    const app = await call(owner, "/api/v1/apps", { body: { name: "Quick refund", bundleId } });
    const key = (app.json.revflareNotificationUrl as string).split("/").pop()!;
    const post = async (n: { signedPayload: string }) => expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: n.signedPayload } })).status).toBe(200);
    const t0 = Date.now() - DAY;
    const tx = { bundleId, transactionId: "97300", type: "Non-Consumable", purchaseDate: t0, price: 990 };
    await post(await notification("ONE_TIME_CHARGE", tx));
    await post(await notification("REFUND", { ...tx, revocationDate: t0 + 3 * 3_600_000, revocationReason: 0 }));
    const feed = await call(owner, `/api/v1/transactions?apps=${app.json.id}`);
    const cust = await call(owner, `/api/v1/customers/${feed.json.items[0].customerId}`);
    expect(cust.json.timing).toMatchObject({ purchaseToRefundMs: 3 * 3_600_000, refundedAt: t0 + 3 * 3_600_000, quickPurchase: false, quickCancel: false });
  });
});
