import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { revenueStepData, revenueStepDataAll } from "../../worker/lib/funnels";
import { DAY, call, notification, ownerClient } from "./helpers";

describe("funnel revenue steps", () => {
  it("reads every linked install's purchases in one query, like the per-install read", async () => {
    const owner = await ownerClient();
    const bundleId = "com.example.funnelrev";
    const app = await call(owner, "/api/v1/apps", { body: { name: "Funnel revenue", bundleId } });
    const appId = app.json.id as string;
    const key = (app.json.revflareNotificationUrl as string).split("/").pop()!;
    const t0 = Date.now() - 3 * DAY;
    const installs = ["eeeeeeee-0000-4000-8000-000000000001", "eeeeeeee-0000-4000-8000-000000000002", "eeeeeeee-0000-4000-8000-000000000003"];
    // Install 1: trial then paid; install 2: paid; install 3: nothing.
    const sends = [
      { bundleId, transactionId: "99100", originalTransactionId: "99100", purchaseDate: t0, expiresDate: t0 + 3 * DAY, price: 0, offerType: 1, offerDiscountType: "FREE_TRIAL", appAccountToken: installs[0] },
      { bundleId, transactionId: "99101", originalTransactionId: "99100", purchaseDate: t0 + 3 * DAY - 60_000, expiresDate: t0 + 10 * DAY, price: 4990, appAccountToken: installs[0], transactionReason: "RENEWAL" as const },
      { bundleId, transactionId: "99200", originalTransactionId: "99200", purchaseDate: t0 + DAY, expiresDate: t0 + 8 * DAY, price: 990, appAccountToken: installs[1] },
    ];
    for (const tx of sends) {
      const n = await notification(tx.transactionId === "99101" ? "DID_RENEW" : "SUBSCRIBED", tx, { signedDate: tx.purchaseDate });
      expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: n.signedPayload } })).status).toBe(200);
    }
    const range = { fromMs: t0 - DAY, toMs: Date.now() };
    for (const kind of ["trial_started", "paid", "any_purchase"] as const) {
      const all = new Map(await revenueStepDataAll(env, { appId, kind, ...range }));
      const per = new Map(await revenueStepData(env, { appId, installs, kind, ...range }));
      expect([...all].sort(), kind).toEqual([...per].sort());
    }
    expect([...new Map(await revenueStepDataAll(env, { appId, kind: "paid", ...range })).keys()].sort()).toEqual([installs[0], installs[1]]);
  });
});
