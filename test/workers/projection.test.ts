import { describe, expect, it } from "vitest";
import { DAY, call, notification, ownerClient, type Client, type TxOptions } from "./helpers";

// GET /projection end to end: real notifications → ledger → projection (worker/lib/projection.ts), per app and for
// the whole workspace, the summary line and the backtest.

async function workspace(owner: Client, name: string): Promise<Client> {
  const ws = await call(owner, "/api/v1/workspaces", { body: { name, currency: "USD" } });
  expect(ws.status, ws.text).toBe(200);
  return { ...owner, ws: ws.json.id as string };
}

async function newApp(client: Client, bundleId: string) {
  const app = await call(client, "/api/v1/apps", { body: { name: bundleId, bundleId } });
  expect(app.status).toBe(201);
  return { id: app.json.id as string, notifKey: (app.json.revflareNotificationUrl as string).split("/").pop()! };
}

describe("projection", () => {
  it("projects existing subscriptions, new subscribers and one-time purchases per app and for the workspace", async () => {
    const owner = await ownerClient();
    const client = await workspace(owner, "Projection WS");
    const bundleId = "com.example.projection";
    const { id, notifKey } = await newApp(client, bundleId);
    let seq = 0;
    const post = async (type: string, tx: Omit<TxOptions, "bundleId" | "transactionId"> & { transactionId?: string }, opts: { subtype?: string } = {}) => {
      const n = await notification(type, { bundleId, transactionId: tx.transactionId ?? `66${String(++seq).padStart(6, "0")}`, ...tx }, opts);
      expect((await call(null, `/apple/notifications/${notifKey}`, { body: { signedPayload: n.signedPayload } })).status).toBe(200);
    };
    const t = Date.now();
    // 12 monthly subscribers: bought 75 days ago, renewed 45 and 15 days ago (8 of them), the others lapsed after one month.
    for (let i = 0; i < 12; i++) {
      const orig = `6699${String(i).padStart(4, "0")}`;
      const start = t - 75 * DAY + i * 3_600_000;
      await post("SUBSCRIBED", { transactionId: orig, purchaseDate: start, expiresDate: start + 30 * DAY, price: 9990 });
      await post("DID_RENEW", { transactionId: `${orig}1`, originalTransactionId: orig, originalPurchaseDate: start, transactionReason: "RENEWAL", purchaseDate: start + 30 * DAY, expiresDate: start + 60 * DAY, price: 9990 });
      if (i < 8)
        await post("DID_RENEW", { transactionId: `${orig}2`, originalTransactionId: orig, originalPurchaseDate: start, transactionReason: "RENEWAL", purchaseDate: start + 60 * DAY, expiresDate: start + 90 * DAY, price: 9990 });
    }
    // A trial started 2 days ago (new subscriber flow, and an active trial).
    await post("SUBSCRIBED", { purchaseDate: t - 2 * DAY, expiresDate: t + DAY, price: 0, offerType: 1, offerDiscountType: "FREE_TRIAL" });

    const res = await call(client, `/api/v1/projection?apps=${id}`);
    expect(res.status, res.text).toBe(200);
    const p = res.json;
    expect(p).toMatchObject({ currency: "USD", days: 365 });
    expect(p.daily).toHaveLength(365);
    expect(p.weekly).toHaveLength(53);
    expect(p.inputs.activeSubscriptions).toBe(9);
    expect(p.inputs.trials).toBe(1);
    // The 8 active monthly subscribers renew in the next 30 days: some proceeds expected, at most their full price.
    const d30 = p.totals.d30;
    expect(d30.existing.expected).toBeGreaterThan(0);
    expect(d30.existingGross).toBeLessThanOrEqual(8 * 9.99 + 9.99 + 1e-6);
    expect(d30.existing.low).toBeLessThanOrEqual(d30.existing.expected);
    expect(d30.existing.high).toBeGreaterThanOrEqual(d30.existing.expected);
    expect(d30.withNew.expected).toBeGreaterThan(d30.existing.expected);
    expect(p.totals.d365.existing.expected).toBeGreaterThan(d30.existing.expected);
    expect(p.summary.next30).toBe(d30.withNew.expected);
    expect(p.summary.mrrNow).toBeCloseTo(8 * 9.99, 6);
    // Segments: monthly first renewals measured (12 due, 12 renewed), second renewals (12 due, 8 renewed): little data,
    // leaning on the portfolio.
    const r1 = p.segments.find((s: { period: string; stage: string }) => s.period === "P1M" && s.stage === "r1");
    expect(r1).toMatchObject({ observed: 12, renewed: 12, lowData: true });
    const r2 = p.segments.find((s: { period: string; stage: string }) => s.period === "P1M" && s.stage === "r2");
    expect(r2).toMatchObject({ observed: 12, renewed: 8, lowData: true });
    expect(p.notes.join(" ")).toContain("fewer than 30 observed renewals");
    expect(p.apps).toHaveLength(1);
    expect(p.apps[0]).toMatchObject({ appId: id, name: bundleId });
    // Backtest from 30 days ago (60 days ago there were not 30 days of history before).
    expect(p.backtest.map((b: { days: number }) => b.days)).toEqual([30]);
    expect(p.backtest[0].withNew.actual).toBeGreaterThan(0);

    // The workspace scope and the summary line (served from the day's computation).
    const all = await call(client, "/api/v1/projection");
    expect(all.status).toBe(200);
    expect(all.json.totals.d30.withNew.expected).toBeCloseTo(d30.withNew.expected, 6);
    const summary = await call(client, `/api/v1/projection/summary?apps=${id}`);
    expect(summary.json).toMatchObject({ currency: "USD", next30: p.summary.next30, next30Previous: null, next30Change: null });
    expect(summary.json.next30Band.expected).toBe(p.summary.next30);
  });
});
