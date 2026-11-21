import { describe, expect, it } from "vitest";
import { DAY, call, notification, ownerClient } from "./helpers";

async function createApp(bundleId: string) {
  const owner = await ownerClient();
  const r = await call(owner, "/api/v1/apps", { body: { name: bundleId.split(".").pop(), bundleId } });
  expect([200, 201]).toContain(r.status);
  const key = (r.json.revflareNotificationUrl as string).split("/").pop()!;
  return { owner, appId: r.json.id as string, key };
}
const post = async (key: string, n: Promise<{ signedPayload: string }>) => {
  const r = await call(null, `/apple/notifications/${key}`, { body: { signedPayload: (await n).signedPayload } });
  expect(r.status, r.text).toBe(200);
};
const weeklyMonths = (7 * 12) / 365.25;

describe("MRR by product / country", () => {
  it("splits MRR and active subscriptions by product, adding up to the total", async () => {
    const bundleId = "com.example.byproduct";
    const { owner, appId, key } = await createApp(bundleId);
    const now = Date.now();
    // Annual subscriber since 100 days, weekly subscriber renewing weekly for 3 weeks, a lifetime purchase (no MRR).
    await post(key, notification("SUBSCRIBED", { bundleId, transactionId: "a1", productId: "annual", purchaseDate: now - 100 * DAY, expiresDate: now + 265 * DAY, price: 29990, storefront: "DEU", currency: "EUR" }, { subtype: "INITIAL_BUY" }));
    for (let i = 0; i < 3; i++) {
      const start = now - (20 - i * 7) * DAY;
      await post(key, notification(i ? "DID_RENEW" : "SUBSCRIBED", { bundleId, transactionId: `w${i}`, originalTransactionId: "w0", productId: "weekly", purchaseDate: start, expiresDate: start + 7 * DAY, price: 4990, transactionReason: i ? "RENEWAL" : "PURCHASE" }));
    }
    await post(key, notification("ONE_TIME_CHARGE", { bundleId, transactionId: "l1", productId: "lifetime", type: "Non-Consumable", purchaseDate: now - 5 * DAY, price: 49990 }));

    for (const metric of ["mrr", "active_subscriptions"]) {
      for (const by of ["product", "country"]) {
        const c = await call(owner, `/api/v1/charts/${metric}?apps=${appId}&range=30d&groupBy=${by}`);
        expect(c.status, c.text).toBe(200);
        expect(c.json.series.length).toBeGreaterThan(1);
        c.json.points.forEach((p: { value: number }, i: number) => {
          const sum = c.json.series.reduce((s: number, x: any) => s + x.points[i].value, 0);
          expect(sum, `${metric} by ${by} at ${p.value}`).toBeCloseTo(p.value, 6);
        });
        expect(c.json.points.at(-1).value).toBeGreaterThan(0);
      }
    }
    const c = await call(owner, `/api/v1/charts/mrr?apps=${appId}&range=30d&groupBy=product`);
    const last = Object.fromEntries(c.json.series.map((s: any) => [s.key, s.points.at(-1).value]));
    expect(last.weekly).toBeCloseTo(4.99 / weeklyMonths, 4);
    expect(last.annual).toBeGreaterThan(0);
    expect(last.lifetime ?? 0).toBe(0);
  });
});

describe("at risk", () => {
  it("values a billing retry after a trial at the renewal price over the product's period, not the trial's", async () => {
    const bundleId = "com.example.retry";
    const { owner, appId, key } = await createApp(bundleId);
    const now = Date.now();
    // The weekly product's period is learned from a paying subscriber.
    await post(key, notification("SUBSCRIBED", { bundleId, transactionId: "p1", productId: "weekly", purchaseDate: now - 2 * DAY, expiresDate: now + 5 * DAY, price: 4990 }));
    // A 3-day free trial that fails to renew: billing retry.
    const trial = { bundleId, transactionId: "t1", productId: "weekly", purchaseDate: now - 4 * DAY, expiresDate: now - DAY, price: 0, offerType: 1, offerDiscountType: "FREE_TRIAL", storefront: "NLD", currency: "EUR" };
    await post(key, notification("SUBSCRIBED", trial, { subtype: "INITIAL_BUY", renewal: { autoRenewStatus: 1 } }));
    await post(key, notification("DID_FAIL_TO_RENEW", trial, { renewal: { autoRenewStatus: 1, isInBillingRetryPeriod: true, renewalPrice: 4990, currency: "USD" } }));

    const risk = await call(owner, `/api/v1/at-risk?apps=${appId}`);
    expect(risk.status, risk.text).toBe(200);
    const row = risk.json.items.find((s: any) => s.status === "billing_retry");
    expect(row.period).toBe("P1W");
    expect(row.mrr).toBeCloseTo(4.99 / weeklyMonths, 4);
    const group = risk.json.groups.find((g: any) => g.reason === "billing_retry");
    expect(group.mrr).toBeCloseTo(row.mrr, 6);
    expect(risk.json.mrr).toBeCloseTo(risk.json.items.reduce((s: number, x: any) => s + x.mrr, 0), 6);
    // Recorded MRR is unchanged: only the paying weekly subscriber.
    const ov = await call(owner, `/api/v1/overview?apps=${appId}`);
    expect(ov.json.kpis.find((k: any) => k.id === "mrr").value).toBeCloseTo(4.99 / weeklyMonths, 4);
  });
});
