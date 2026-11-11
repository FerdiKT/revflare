import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import migration from "../../migrations/0022_ads_names.sql?raw";
import { getDb } from "../../worker/lib/db";
import { splitStatements } from "../../worker/lib/migrate";
import { pushTestHooks, type PushMessage } from "../../worker/lib/push";
import { DAY, call, notification, ownerClient, type Client, type TxOptions } from "./helpers";

// In TEST_MODE an attribution token "test:<json>" resolves to <json> instead of calling Apple; other tokens stay pending.
const token = (json: object) => `test:${JSON.stringify(json)}`;
const db = () => getDb(env);
const rows = <T>(sql: string, ...params: (string | number)[]) =>
  db()
    .prepare(sql)
    .bind(...params)
    .all<T>()
    .then((r) => r.results);

/** Apple's AdServices test payload. */
const TEST_PAYLOAD = { attribution: true, orgId: 1234567890, campaignId: 1234567890, adGroupId: 1234567890, keywordId: 12323222, countryOrRegion: "US" };

const pushes: { deviceId: string; msg: PushMessage }[] = [];
beforeAll(() => {
  pushTestHooks.sink = pushes;
});
afterAll(() => {
  pushTestHooks.sink = null;
});

async function newApp(owner: Client, name: string, bundleId: string) {
  const app = await call(owner, "/api/v1/apps", { body: { name, bundleId } });
  expect(app.status).toBe(201);
  const sdkKey = app.json.sdkKey as string;
  const key = (app.json.revflareNotificationUrl as string).split("/").pop()!;
  return {
    appId: app.json.id as string,
    report: async (body: object) => {
      const r = await call(null, "/sdk/v1/report", { body: { sdkKey, ...body } });
      expect(r.status, r.text).toBe(200);
      return r.json;
    },
    buy: async (type: string, tx: TxOptions) => {
      const n = await notification(type, tx);
      expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: n.signedPayload } })).status).toBe(200);
    },
  };
}

describe("Apple Ads names", () => {
  it("upserts, writes only changed rows, deletes with an empty name, batches large requests and validates", async () => {
    const owner = await ownerClient();
    const put = (names: unknown) => call(owner, "/api/v1/attribution/names", { method: "PUT", body: { names } });
    let r = await put([
      { kind: "campaign", id: "9100001", name: "Brand  Search " },
      { kind: "adgroup", id: 9200001, name: "Exact" },
      { kind: "keyword", id: "9300001", name: "photo editor" },
    ]);
    expect(r.status, r.text).toBe(200);
    expect(r.json).toEqual({ updated: 3, deleted: 0 });
    const before = await rows<{ updated_at: number }>("SELECT updated_at FROM ads_names WHERE workspace_id = ? AND kind = 'adgroup' AND id = '9200001'", owner.workspaceId);
    // The same names again: nothing written.
    r = await put([
      { kind: "campaign", id: "9100001", name: "Brand Search" },
      { kind: "adgroup", id: "9200001", name: "Exact" },
    ]);
    expect(r.json).toEqual({ updated: 0, deleted: 0 });
    // A rename and a delete; deleting an unknown id deletes nothing.
    r = await put([
      { kind: "adgroup", id: "9200001", name: "Exact match" },
      { kind: "keyword", id: "9300001", name: "" },
      { kind: "keyword", id: "9399999", name: "" },
    ]);
    expect(r.json).toEqual({ updated: 1, deleted: 1 });
    const after = await rows<{ name: string; updated_at: number }>("SELECT name, updated_at FROM ads_names WHERE workspace_id = ? AND kind = 'adgroup' AND id = '9200001'", owner.workspaceId);
    expect(after[0].name).toBe("Exact match");
    expect(after[0].updated_at).toBeGreaterThanOrEqual(before[0].updated_at);

    // 1000 names in one request: chunked under 100 parameters per statement.
    const many = Array.from({ length: 1000 }, (_, i) => ({ kind: "keyword", id: String(9400000 + i), name: `kw ${i}` }));
    r = await put(many);
    expect(r.status, r.text).toBe(200);
    expect(r.json).toEqual({ updated: 1000, deleted: 0 });
    expect((await put(many)).json).toEqual({ updated: 0, deleted: 0 });
    expect((await put(many.map((n) => ({ ...n, name: "" })))).json).toEqual({ updated: 0, deleted: 1000 });

    const list = await call(owner, "/api/v1/attribution/names");
    expect(list.status).toBe(200);
    const mine = (list.json.names as { kind: string; id: string; name: string }[]).filter((n) => n.id.startsWith("9"));
    expect(mine).toEqual([
      { kind: "campaign", id: "9100001", name: "Brand Search" },
      { kind: "adgroup", id: "9200001", name: "Exact match" },
    ]);

    expect((await put([...many, { kind: "keyword", id: "1", name: "x" }])).status).toBe(400);
    expect((await put([{ kind: "creative", id: "1", name: "x" }])).json.error).toContain("kind must be one of");
    expect((await put([{ kind: "campaign", id: "abc", name: "x" }])).json.error).toContain("not an Apple Ads id");
    expect((await call(owner, "/api/v1/attribution/names", { method: "PUT", body: { nope: 1 } })).status).toBe(400);
  });
});

describe("attribution in the feed, the customer and attributed revenue", () => {
  it("resolves sources and names, filters the feed by source, keeps test attribution out unless includeTest", async () => {
    const owner = await ownerClient();
    const bundleId = "com.example.adsfeed";
    const { appId, report, buy } = await newApp(owner, "Ads Feed", bundleId);
    await call(owner, "/api/v1/attribution/names", {
      method: "PUT",
      body: {
        names: [
          { kind: "campaign", id: "8100001", name: "Brand" },
          { kind: "adgroup", id: "8200001", name: "Exact" },
        ],
      },
    });
    const ads = "a1000000-0000-4000-8000-000000000001";
    const organic = "a1000000-0000-4000-8000-000000000002";
    const pending = "a1000000-0000-4000-8000-000000000003";
    const testAds = "a1000000-0000-4000-8000-000000000004";
    const noName = "a1000000-0000-4000-8000-000000000005";
    await report({ installId: ads, environment: "production", attributionToken: token({ attribution: true, campaignId: 8100001, adGroupId: 8200001, keywordId: 8300001 }) });
    await report({ installId: organic, environment: "production", attributionToken: token({ attribution: false }) });
    // Never sent to Apple in TEST_MODE: stays pending (unknown).
    await report({ installId: pending, environment: "production", attributionToken: "real-token-that-stays-pending" });
    // Apple's test payload from a production build (counted as test attribution, not as production Apple Ads).
    await report({ installId: testAds, environment: "production", attributionToken: token(TEST_PAYLOAD) });
    await report({ installId: noName, environment: "production", attributionToken: token({ attribution: true, campaignId: 8100002 }) });
    const testRow = await rows<{ test_attribution: number; attributed: number }>("SELECT test_attribution, attributed FROM attributions WHERE app_id = ? AND install_id = ?", appId, testAds);
    expect(testRow).toEqual([{ test_attribution: 1, attributed: 1 }]);
    // Remote config conditions keep seeing it as Apple Ads.
    expect(await report({ installId: testAds })).toMatchObject({ source: "apple_ads", campaignId: "1234567890" });

    const t = Date.now() - 3_600_000;
    const sub = (id: string, install: string | undefined, at: number) => buy("SUBSCRIBED", { bundleId, transactionId: id, purchaseDate: at, expiresDate: at + 30 * DAY, price: 9990, appAccountToken: install });
    await sub("6100001", ads, t);
    await sub("6100002", organic, t + 1000);
    await sub("6100003", pending, t + 2000);
    await sub("6100004", testAds, t + 3000);
    await sub("6100005", undefined, t + 4000);
    await sub("6100006", noName, t + 5000);

    const feed = await call(owner, `/api/v1/transactions?apps=${appId}&limit=50`);
    expect(feed.status).toBe(200);
    const byId = new Map((feed.json.items as any[]).map((x) => [x.transactionId, x.attribution]));
    expect(byId.get("6100001")).toEqual({
      source: "apple_ads",
      test: false,
      campaignId: "8100001",
      campaignName: "Brand",
      adGroupId: "8200001",
      adGroupName: "Exact",
      keywordId: "8300001",
      keywordName: null,
    });
    expect(byId.get("6100002")).toMatchObject({ source: "organic", test: false, campaignId: null, campaignName: null });
    expect(byId.get("6100003")).toMatchObject({ source: "unknown", campaignId: null });
    expect(byId.get("6100004")).toMatchObject({ source: "apple_ads", test: true, campaignId: "1234567890" });
    expect(byId.get("6100005")).toMatchObject({ source: "unknown", test: false });
    expect(byId.get("6100006")).toMatchObject({ source: "apple_ads", campaignId: "8100002", campaignName: null, adGroupId: null });

    const filtered = async (source: string) => {
      const r = await call(owner, `/api/v1/transactions?apps=${appId}&source=${source}&limit=1`);
      expect(r.status, r.text).toBe(200);
      const ids: string[] = r.json.items.map((x: any) => x.transactionId);
      let cursor = r.json.nextCursor;
      while (cursor) {
        const next = await call(owner, `/api/v1/transactions?apps=${appId}&source=${source}&limit=1&cursor=${encodeURIComponent(cursor)}`);
        ids.push(...next.json.items.map((x: any) => x.transactionId));
        cursor = next.json.nextCursor;
      }
      return { ids, days: r.json.days };
    };
    const adsOnly = await filtered("apple_ads");
    expect(adsOnly.ids).toEqual(["6100006", "6100004", "6100001"]);
    // Day totals follow the filter.
    expect(adsOnly.days.reduce((s: number, d: any) => s + d.count, 0)).toBe(3);
    expect((await filtered("organic")).ids).toEqual(["6100002"]);
    expect((await filtered("unknown")).ids).toEqual(["6100005", "6100003"]);
    expect((await call(owner, `/api/v1/transactions?source=facebook`)).status).toBe(400);

    // Customer: the install of their first linked transaction.
    const customerId = (feed.json.items as any[]).find((x) => x.transactionId === "6100001").customerId;
    const customer = await call(owner, `/api/v1/customers/${customerId}`);
    expect(customer.json.attribution).toMatchObject({ source: "apple_ads", campaignName: "Brand", adGroupName: "Exact" });
    expect(customer.json.transactions[0].attribution.source).toBe("apple_ads");
    const unlinked = (feed.json.items as any[]).find((x) => x.transactionId === "6100005").customerId;
    expect((await call(owner, `/api/v1/customers/${unlinked}`)).json.attribution).toMatchObject({ source: "unknown" });

    // Attributed revenue: names on rows; the test install is left out (and counted in testInstalls).
    let r = await call(owner, `/api/v1/revenue/attributed?apps=${appId}&range=7d`);
    expect(r.json.coverage).toEqual({ installs: 4, attributed: 2, testInstalls: 1 });
    expect(r.json.rows.map((x: any) => [x.campaignId, x.campaignName, x.adGroupName, x.revenue, x.installs]).sort()).toEqual([
      ["8100001", "Brand", "Exact", 9.99, 1],
      ["8100002", null, null, 9.99, 1],
    ]);
    expect(r.json.rows.every((x: any) => x.test === undefined)).toBe(true);
    r = await call(owner, `/api/v1/revenue/attributed?apps=${appId}&range=7d&includeTest=true`);
    expect(r.json.includeTest).toBe(true);
    expect(r.json.coverage).toEqual({ installs: 5, attributed: 2, testInstalls: 1 });
    const test = r.json.rows.find((x: any) => x.campaignId === "1234567890");
    expect(test).toMatchObject({ test: true, revenue: 9.99, installs: 1, payers: 1 });
    expect(r.json.rows.find((x: any) => x.campaignId === "8100001").test).toBe(false);

    // LTV leaves the test attribution install out too.
    const ltv = await call(owner, `/api/v1/ltv/summary?apps=${appId}&by=campaign&range=7d`);
    expect(ltv.json.rows.map((x: any) => x.group)).not.toContain("1234567890");
    expect(ltv.json.coverage.installs).toBe(4);
  });

  it("takes the customer's first attributed transaction, and flags sandbox purchases of production installs as test", async () => {
    const owner = await ownerClient();
    const bundleId = "com.example.adsfirst";
    const { appId, report, buy } = await newApp(owner, "Ads First", bundleId);
    const ads = "a4000000-0000-4000-8000-000000000001";
    // An appAccountToken that is no install (no attribution row).
    const unrelated = "a4000000-0000-4000-8000-0000000000ff";
    await report({ installId: ads, environment: "production", attributionToken: token({ attribution: true, campaignId: 8100201 }) });
    const t = Date.now() - 3_600_000;
    await buy("SUBSCRIBED", { bundleId, transactionId: "6400001", purchaseDate: t, expiresDate: t + 30 * DAY, price: 9990, appAccountToken: unrelated });
    // A later purchase of the same customer (same token), linked to the attributed install by the SDK.
    await report({ installId: ads, originalTransactionIds: ["6400002"] });
    await buy("ONE_TIME_CHARGE", { bundleId, transactionId: "6400002", type: "Non-Consumable", productId: "lifetime", purchaseDate: t + 1000, price: 4990, appAccountToken: unrelated });
    const feed = await call(owner, `/api/v1/transactions?apps=${appId}&limit=50`);
    const items = feed.json.items as any[];
    const first = items.find((x) => x.transactionId === "6400001");
    expect(first.attribution.source).toBe("unknown");
    expect(items.find((x) => x.transactionId === "6400002").customerId).toBe(first.customerId);
    expect((await call(owner, `/api/v1/customers/${first.customerId}`)).json.attribution).toMatchObject({ source: "apple_ads", campaignId: "8100201" });

    // A sandbox purchase from the production install: left out by default, a test row with includeTest.
    await report({ installId: ads, originalTransactionIds: ["6400003"] });
    await buy("SUBSCRIBED", { bundleId, transactionId: "6400003", productId: "yearly", purchaseDate: t + 2000, expiresDate: t + 365 * DAY, price: 29990, environment: "Sandbox" });
    let r = await call(owner, `/api/v1/revenue/attributed?apps=${appId}&range=7d`);
    expect(r.json.rows.map((x: any) => [x.campaignId, x.revenue, x.payers])).toEqual([["8100201", 4.99, 1]]);
    r = await call(owner, `/api/v1/revenue/attributed?apps=${appId}&range=7d&includeTest=true`);
    const rows8 = r.json.rows.filter((x: any) => x.campaignId === "8100201");
    expect(rows8.find((x: any) => !x.test)).toMatchObject({ revenue: 4.99, installs: 1, payers: 1 });
    expect(rows8.find((x: any) => x.test)).toMatchObject({ revenue: 29.99, installs: 0, payers: 1 });
  });

  it("migration 0022 marks existing installs with Apple's test payload", async () => {
    const owner = await ownerClient();
    const { appId, report } = await newApp(owner, "Ads Backfill", "com.example.adsbackfill");
    const install = "a2000000-0000-4000-8000-000000000001";
    await report({ installId: install, attributionToken: token(TEST_PAYLOAD) });
    await db().prepare("UPDATE attributions SET test_attribution = 0 WHERE app_id = ?").bind(appId).run();
    const update = splitStatements(migration).find((s) => s.startsWith("UPDATE attributions"))!;
    expect(update).toContain("1234567890");
    await db().prepare(update).run();
    expect(await rows("SELECT test_attribution FROM attributions WHERE app_id = ?", appId)).toEqual([{ test_attribution: 1 }]);
  });
});

describe("sale pushes name Apple Ads", () => {
  it("adds 'Apple Ads · <ad group>' for builds with pushVersion 2; older builds and test attribution keep the plain text", async () => {
    const owner = await ownerClient();
    const bundleId = "com.example.adspush";
    const { report, buy } = await newApp(owner, "Ads Push", bundleId);
    const device = async (pushVersion: number, n: number) => {
      const r = await call(owner, "/api/v1/devices", { body: { apnsToken: `ad5${n}`.padEnd(64, "0"), name: `Ads ${n}`, prefs: { timezone: "UTC", pushVersion } } });
      expect(r.status, r.text).toBe(200);
      return r.json.id as string;
    };
    const v2 = await device(2, 1);
    const v1 = await device(1, 2);
    await call(owner, "/api/v1/attribution/names", { method: "PUT", body: { names: [{ kind: "adgroup", id: "8200101", name: "Competitors" }] } });
    const ads = "a3000000-0000-4000-8000-000000000001";
    const noGroupName = "a3000000-0000-4000-8000-000000000002";
    const testAds = "a3000000-0000-4000-8000-000000000003";
    await report({ installId: ads, attributionToken: token({ attribution: true, campaignId: 8100101, adGroupId: 8200101 }) });
    await report({ installId: noGroupName, attributionToken: token({ attribution: true, campaignId: 8100102, adGroupId: 8200102 }) });
    await report({ installId: testAds, attributionToken: token(TEST_PAYLOAD) });
    const t = Date.now() - 60_000;
    const msgsFor = (txId: string) => pushes.filter((p) => p.msg.data?.transactionId === txId);

    await buy("SUBSCRIBED", { bundleId, transactionId: "6200001", purchaseDate: t, expiresDate: t + 30 * DAY, price: 9990, appAccountToken: ads });
    let sent = msgsFor("6200001");
    expect(sent.find((p) => p.deviceId === v2)!.msg).toMatchObject({ bodyKey: "PUSH_BODY_SALE_ADS", bodyArgs: ["Monthly", "🇺🇸 United States", "$9.99", "Apple Ads · Competitors"] });
    expect(sent.find((p) => p.deviceId === v2)!.msg).not.toHaveProperty("newer");
    expect(sent.find((p) => p.deviceId === v1)!.msg).toMatchObject({ bodyKey: "PUSH_BODY_SALE", bodyArgs: ["Monthly", "🇺🇸 United States", "$9.99"] });

    await buy("ONE_TIME_CHARGE", { bundleId, transactionId: "6200002", type: "Non-Consumable", productId: "lifetime", purchaseDate: t, price: 4990, appAccountToken: noGroupName });
    sent = msgsFor("6200002");
    expect(sent.find((p) => p.deviceId === v2)!.msg.bodyArgs?.at(-1)).toBe("Apple Ads · #8200102");

    // Trial: PUSH_BODY_TRIAL_ADS (product, country, source).
    await buy("SUBSCRIBED", { bundleId, transactionId: "6200003", purchaseDate: t, expiresDate: t + 7 * DAY, price: 0, offerType: 1, offerDiscountType: "FREE_TRIAL", appAccountToken: ads });
    sent = msgsFor("6200003");
    expect(sent.find((p) => p.deviceId === v2)!.msg).toMatchObject({ bodyKey: "PUSH_BODY_TRIAL_ADS", bodyArgs: ["Monthly", "🇺🇸 United States", "Apple Ads · Competitors"] });
    expect(sent.find((p) => p.deviceId === v1)!.msg.bodyKey).toBe("PUSH_BODY_TRIAL");

    // Test attribution: no source in the text.
    await buy("SUBSCRIBED", { bundleId, transactionId: "6200004", purchaseDate: t, expiresDate: t + 30 * DAY, price: 9990, appAccountToken: testAds });
    expect(msgsFor("6200004").find((p) => p.deviceId === v2)!.msg.bodyKey).toBe("PUSH_BODY_SALE");
  });
});
