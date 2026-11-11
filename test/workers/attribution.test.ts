import { describe, expect, it } from "vitest";
import { DAY, call, notification, ownerClient } from "./helpers";

// In TEST_MODE an attribution token "test:<json>" resolves to <json> instead of calling Apple.
const token = (json: object) => `test:${JSON.stringify(json)}`;

describe("Apple Ads attribution (RevflareKit)", () => {
  it("joins revenue to the campaign, ad group and keyword of the install", async () => {
    const owner = await ownerClient();
    const bundleId = "app.test.attribution";
    const app = await call(owner, "/api/v1/apps", { body: { name: "Attributed", bundleId } });
    const sdkKey = app.json.sdkKey as string;
    expect(sdkKey).toMatch(/^rfp_/);
    const key = (app.json.revflareNotificationUrl as string).split("/").pop()!;
    const report = (body: object) => call(null, "/sdk/v1/report", { body: { sdkKey, ...body } });

    const ad = "11111111-1111-4111-8111-111111111111";
    const organic = "22222222-2222-4222-8222-222222222222";
    const viaToken = "33333333-3333-4333-8333-333333333333";
    expect((await report({ installId: ad, attributionToken: token({ attribution: true, orgId: 1, campaignId: 501, adGroupId: 601, keywordId: 701, countryOrRegion: "US" }) })).json.attribution).toBe("resolved");
    expect((await report({ installId: organic, attributionToken: token({ attribution: false }) })).status).toBe(200);
    await report({ installId: viaToken, attributionToken: token({ attribution: true, campaignId: 502, adGroupId: 602 }) });
    expect((await report({ installId: "not-a-uuid" })).status).toBe(400);
    expect((await call(null, "/sdk/v1/report", { body: { sdkKey: "rfp_nope", installId: ad } })).status).toBe(404);

    const t = Date.now() - DAY;
    // Install 1 buys a subscription and reports its original transaction id afterwards.
    const n1 = await notification("SUBSCRIBED", { bundleId, transactionId: "8100", purchaseDate: t, expiresDate: t + 30 * DAY, price: 9990 });
    expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: n1.signedPayload } })).status).toBe(200);
    await report({ installId: ad, originalTransactionIds: ["8100"] });
    // Install 3 buys with appAccountToken = install id: no report needed.
    const n3 = await notification("ONE_TIME_CHARGE", { bundleId, transactionId: "8300", type: "Non-Consumable", purchaseDate: t, price: 4990, appAccountToken: viaToken });
    expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: n3.signedPayload } })).status).toBe(200);
    // The organic install buys too: not in the attributed revenue.
    const n2 = await notification("SUBSCRIBED", { bundleId, transactionId: "8200", purchaseDate: t, expiresDate: t + 30 * DAY, price: 9990 });
    await call(null, `/apple/notifications/${key}`, { body: { signedPayload: n2.signedPayload } });
    await report({ installId: organic, originalTransactionIds: ["8200"] });

    const r = await call(owner, `/api/v1/revenue/attributed?apps=${app.json.id}&range=7d`);
    expect(r.status).toBe(200);
    expect(r.json.coverage).toEqual({ installs: 3, attributed: 2, testInstalls: 0 });
    const sales = r.json.rows.filter((x: any) => x.revenue > 0);
    expect(sales.map((x: any) => [x.campaignId, x.adGroupId, x.keywordId, x.revenue, x.payers]).sort()).toEqual([
      ["501", "601", "701", 9.99, 1],
      ["502", "602", null, 4.99, 1],
    ]);
    expect(r.json.rows.reduce((s: number, x: any) => s + x.installs, 0)).toBe(2);
  });
});
