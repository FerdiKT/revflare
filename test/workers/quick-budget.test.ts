import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DAY, call, notification, ownerClient } from "./helpers";

// Free plan budget of the feed's timing columns, its quick filter and the cancellations stream (kept out of
// budget.test.ts: the workers pool of that shard runs out of stack with one more heavy test).
const stats = () => env.DATABASE.get(env.DATABASE.idFromName("main")).stats();

describe("Free plan budget: quick buyers / cancellations", () => {
  it("keeps the feed page, its quick filter and the cancellations stream bounded, and a sale's writes free of the cancellation index", async () => {
    // Its own workspace: the other budget tests keep reading the shared one.
    const admin = await ownerClient();
    const owner = { ...admin, ws: (await call(admin, "/api/v1/workspaces", { body: { name: "Budget quick" } })).json.id as string };
    const bundleId = "com.example.budget.quick";
    const app = await call(owner, "/api/v1/apps", { body: { name: "Budget quick", bundleId } });
    const appId = app.json.id as string;
    const sdkKey = app.json.sdkKey as string;
    const key = (app.json.revflareNotificationUrl as string).split("/").pop()!;
    const post = async (p: string) => {
      const r = await call(null, `/apple/notifications/${key}`, { body: { signedPayload: p } });
      expect(r.status, r.text).toBe(200);
    };
    // 20 customers, 6 daily payments each (few requests: the workers pool overflows its stack after too many in one file), every third one installed through RevflareKit and every fourth cancelled
    // (2 minutes after its last payment). Signed dates stay within the test certificate's validity (recent days).
    const t0 = Date.now() - 10 * DAY;
    for (let c = 0; c < 20; c++) {
      const otid = `${96000 + c}00`;
      const install = `cccccccc-0000-4000-8000-${String(c).padStart(12, "0")}`;
      if (c % 3 === 0) {
        const r = await call(null, "/sdk/v1/report", { body: { sdkKey, installId: install, originalTransactionIds: [otid] } });
        expect(r.status, r.text).toBe(200);
      }
      for (let m = 0; m < 6; m++) {
        const at = t0 + c * 600_000 + m * DAY;
        const tx = { bundleId, transactionId: `${96000 + c}${String(m).padStart(2, "0")}`, originalTransactionId: otid, purchaseDate: at, expiresDate: at + DAY, transactionReason: (m ? "RENEWAL" : "PURCHASE") as "RENEWAL" | "PURCHASE" };
        await post((await notification(m ? "DID_RENEW" : "SUBSCRIBED", tx)).signedPayload);
        if (m === 5 && c % 4 === 0) await post((await notification("DID_CHANGE_RENEWAL_STATUS", tx, { subtype: "AUTO_RENEW_DISABLED", signedDate: at + 2 * 60_000, renewal: { autoRenewStatus: 0 } })).signedPayload);
      }
    }
    const cost = async (path: string) => {
      const before = await stats();
      const r = await call(owner, path);
      expect(r.status).toBe(200);
      const after = await stats();
      return { reads: after.rowsRead - before.rowsRead, writes: after.rowsWritten - before.rowsWritten, items: r.json.items.length as number };
    };
    await cost(`/api/v1/transactions?apps=${appId}`);
    const page = await cost(`/api/v1/transactions?apps=${appId}&limit=50`);
    const poll = await cost(`/api/v1/transactions?apps=${appId}&limit=20`);
    const quick = await cost(`/api/v1/transactions?apps=${appId}&quick=true`);
    const cancels = await cost(`/api/v1/transactions?apps=${appId}&cancellations=true`);
    const quickCancels = await cost(`/api/v1/transactions?apps=${appId}&cancellations=true&quick=true`);
    console.log(`feed page: ${JSON.stringify(page)}, poll: ${JSON.stringify(poll)}, quick: ${JSON.stringify(quick)}, cancellations: ${JSON.stringify(cancels)}, quick cancellations: ${JSON.stringify(quickCancels)}`);
    expect(cancels.items).toBe(5);
    expect(quickCancels.items).toBe(5);
    // The timing columns cost about one row per feed row (index seeks into cancellations only).
    expect(page.reads).toBeLessThan(600);
    expect(poll.reads).toBeLessThan(350);
    // At most SOURCE_SCAN (500) transactions looked at, each with primary-key / partial-index probes.
    expect(quick.reads).toBeLessThan(3000);
    expect(cancels.reads).toBeLessThan(500);
    expect(quickCancels.reads).toBeLessThan(500);
    for (const x of [page, poll, quick, cancels, quickCancels]) expect(x.writes).toBe(0);

    // A sale writes no row in the cancellation indexes (partial); a cancellation writes one in each of the two.
    let before = await stats();
    const sale = { bundleId, transactionId: "9699900", purchaseDate: Date.now() - 60_000, expiresDate: Date.now() + 30 * DAY };
    await post((await notification("SUBSCRIBED", sale)).signedPayload);
    let after = await stats();
    const saleWrites = after.rowsWritten - before.rowsWritten;
    expect(saleWrites).toBeLessThan(80);
    before = await stats();
    await post((await notification("DID_CHANGE_RENEWAL_STATUS", sale, { subtype: "AUTO_RENEW_ENABLED", renewal: { autoRenewStatus: 1 } })).signedPayload);
    after = await stats();
    const onWrites = after.rowsWritten - before.rowsWritten;
    before = await stats();
    await post((await notification("DID_CHANGE_RENEWAL_STATUS", sale, { subtype: "AUTO_RENEW_DISABLED", renewal: { autoRenewStatus: 0 } })).signedPayload);
    after = await stats();
    const offWrites = after.rowsWritten - before.rowsWritten;
    console.log(`sale: ${saleWrites} rows written, auto-renew on: ${onWrites}, off: ${offWrites}`);
    expect(offWrites - onWrites).toBeLessThanOrEqual(2);
    const ov = await call(owner, "/api/v1/overview");
    expect(ov.status, ov.text).toBe(200);
  }, 240_000);
});
