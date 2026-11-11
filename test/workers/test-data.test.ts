import { SELF, env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { retryAttributions } from "../../worker/lib/attribution";
import { getDb } from "../../worker/lib/db";
import { resetEventsState } from "../../worker/lib/events";
import { parseSignRequest } from "../../worker/lib/offers";
import { resetWaeCache } from "../../worker/lib/wae";
import { ORIGIN, call, notification, ownerClient, type TxOptions } from "./helpers";

// In TEST_MODE an attribution token "test:<json>" resolves to <json> instead of calling Apple; other tokens are never
// sent (they stay pending).
const token = (json: object) => `test:${JSON.stringify(json)}`;
const dbExec = (sql: string, params: (string | number)[] = []) => env.DATABASE.get(env.DATABASE.idFromName("main")).exec([{ sql, params, mode: "run" }], false);
const rows = <T>(sql: string, ...params: (string | number)[]) =>
  getDb(env)
    .prepare(sql)
    .bind(...params)
    .all<T>()
    .then((r) => r.results);
const CF = "https://api.cloudflare.com";
const SQL_PATH = `/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
beforeEach(() => {
  resetEventsState();
  resetWaeCache();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function newApp(name: string, bundleId: string) {
  const owner = await ownerClient();
  const app = await call(owner, "/api/v1/apps", { body: { name, bundleId } });
  expect(app.status).toBe(201);
  return { owner, appId: app.json.id as string, sdkKey: app.json.sdkKey as string, key: (app.json.revflareNotificationUrl as string).split("/").pop()! };
}

describe("acquisition source in /sdk/v1/report", () => {
  it("answers unknown while Apple has not answered, then the Apple Ads ids; organic otherwise", async () => {
    const { sdkKey } = await newApp("Source", "com.example.source");
    const report = (body: object) => call(null, "/sdk/v1/report", { body: { sdkKey, ...body } });
    const pending = "a0000000-0000-4000-8000-000000000001";
    const organic = "a0000000-0000-4000-8000-000000000002";
    const noToken = "a0000000-0000-4000-8000-000000000003";

    // A token Apple does not know yet: pending → unknown.
    const first = await report({ installId: pending, attributionToken: "not-yet-known-token" });
    expect(first.json).toEqual({ ok: true, attribution: "pending", source: "unknown", campaignId: null, adGroupId: null, keywordId: null });
    // Apple answers on the cron's retry.
    await dbExec("UPDATE attributions SET token = ?, updated_at = ? WHERE install_id = ?", [token({ attribution: true, campaignId: 1001, adGroupId: 2001, keywordId: 3001 }), Date.now() - 120_000, pending]);
    expect((await retryAttributions(env, { limit: 50 })).retried).toBeGreaterThanOrEqual(1);
    // The next launch's token-less report gets the source and the ids.
    expect((await report({ installId: pending })).json).toEqual({ ok: true, attribution: "resolved", source: "apple_ads", campaignId: "1001", adGroupId: "2001", keywordId: "3001" });

    expect((await report({ installId: organic, attributionToken: token({ attribution: false, campaignId: 5 }) })).json).toEqual({
      ok: true,
      attribution: "resolved",
      source: "organic",
      campaignId: null,
      adGroupId: null,
      keywordId: null,
    });
    // No token (simulator, ads tracking unavailable): failed → organic.
    expect((await report({ installId: noToken })).json).toMatchObject({ attribution: "failed", source: "organic" });
  });

  it("xcode builds: no install links, no Apple resolution; the first report's environment is kept (production never downgrades)", async () => {
    const { sdkKey, appId } = await newApp("Xcode", "com.example.xcode");
    const report = (body: object) => call(null, "/sdk/v1/report", { body: { sdkKey, ...body } });
    const xcode = "b0000000-0000-4000-8000-000000000001";
    const sandbox = "b0000000-0000-4000-8000-000000000002";
    const legacy = "b0000000-0000-4000-8000-000000000003";
    const r = await report({ installId: xcode, environment: "xcode", originalTransactionIds: ["2000000000000001", "2000000000000002"], attributionToken: token({ attribution: true, campaignId: 1 }) });
    expect(r.json).toMatchObject({ ok: true, attribution: "failed", source: "organic", campaignId: null });
    // Sandbox (TestFlight): resolved normally, links kept.
    expect((await report({ installId: sandbox, environment: "sandbox", originalTransactionIds: ["2000000000000003"], attributionToken: token({ attribution: true, campaignId: 7 }) })).json).toMatchObject({
      source: "apple_ads",
      campaignId: "7",
    });
    // Older SDKs send no environment: production; invalid values too.
    await report({ installId: legacy, environment: "staging" });
    // A later report cannot move it away from production.
    await report({ installId: legacy, environment: "sandbox" });
    await report({ installId: legacy, environment: "xcode" });
    await report({ installId: xcode, environment: "sandbox" });
    const attr = await rows<{ install_id: string; environment: string | null; status: string; token: string | null }>("SELECT install_id, environment, status, token FROM attributions WHERE app_id = ? ORDER BY install_id", appId);
    expect(attr.map((a) => [a.install_id, a.environment, a.status, a.token])).toEqual([
      [xcode, "xcode", "failed", null],
      [sandbox, "sandbox", "resolved", null],
      [legacy, "production", "failed", null],
    ]);
    const links = await rows<{ install_id: string; original_transaction_id: string }>("SELECT install_id, original_transaction_id FROM install_links WHERE app_id = ?", appId);
    expect(links).toEqual([{ install_id: sandbox, original_transaction_id: "2000000000000003" }]);
    // Later reports of the xcode install still link nothing.
    await report({ installId: xcode, originalTransactionIds: ["2000000000000004"] });
    expect(await rows("SELECT 1 FROM install_links WHERE app_id = ? AND install_id = ?", appId, xcode)).toHaveLength(0);
  });
});

describe("remote config by acquisition source and environment", () => {
  it("evaluates the device's query in the Worker, ignores invalid values, previews and lists Apple Ads ids", async () => {
    const { owner, appId, sdkKey } = await newApp("Config source", "com.example.configsource");
    const put = await call(owner, `/api/v1/apps/${appId}/config`, {
      method: "PUT",
      body: {
        conditions: [
          { name: "brand", rules: [{ type: "apple_ads_campaign", values: ["1001"] }] },
          { name: "ads", rules: [{ type: "source", values: ["apple_ads"] }] },
          { name: "first launch", rules: [{ type: "source", values: ["unknown"] }] },
          { name: "debug", rules: [{ type: "environment", values: ["sandbox", "xcode"] }] },
        ],
        parameters: [
          { key: "paywall", type: "string", defaultValue: "soft", conditionalValues: { brand: "brand", ads: "hard", "first launch": "soft_wait" } },
          { key: "debug_menu", type: "boolean", defaultValue: false, conditionalValues: { debug: true } },
        ],
      },
    });
    expect(put.status).toBe(200);
    const get = (q: string) =>
      SELF.fetch(`${ORIGIN}/sdk/v1/config?installId=c0000000-0000-4000-8000-000000000001${q}`, { headers: { "x-revflare-key": sdkKey } }).then(async (r) => ({
        status: r.status,
        etag: r.headers.get("etag"),
        json: (await r.json()) as { values: Record<string, unknown>; version: string },
      }));
    const ads = await get("&source=apple_ads&campaign=1001&adGroup=2001&keyword=3001");
    expect(ads.json.values).toEqual({ paywall: "brand", debug_menu: false });
    expect((await get("&source=apple_ads&campaign=9")).json.values.paywall).toBe("hard");
    const unknown = await get("&source=unknown");
    expect(unknown.json.values.paywall).toBe("soft_wait");
    expect(unknown.etag).not.toBe(ads.etag);
    expect((await get("&source=organic&environment=sandbox")).json.values).toEqual({ paywall: "soft", debug_menu: true });
    // Invalid values are ignored: no source, production.
    const invalid = await get("&source=facebook&campaign=12x&environment=debug");
    expect(invalid.json.values).toEqual({ paywall: "soft", debug_menu: false });
    expect(invalid.etag).toBe((await get("")).etag);

    // Preview as.
    const preview = await call(owner, `/api/v1/apps/${appId}/config/evaluate`, { body: { source: "apple_ads", campaign: "1001", environment: "xcode" } });
    expect(preview.json.values).toEqual({ paywall: "brand", debug_menu: true });
    expect(preview.json.parameters.paywall.condition).toBe("brand");

    // Picker options: Apple Ads ids of the app's production installs.
    const report = (body: object) => call(null, "/sdk/v1/report", { body: { sdkKey, ...body } });
    await report({ installId: "c0000000-0000-4000-8000-000000000011", attributionToken: token({ attribution: true, campaignId: 1001, adGroupId: 2001, keywordId: 3001 }) });
    await report({ installId: "c0000000-0000-4000-8000-000000000012", attributionToken: token({ attribution: true, campaignId: 1001, adGroupId: 2001, keywordId: 3002 }) });
    await report({ installId: "c0000000-0000-4000-8000-000000000013", attributionToken: token({ attribution: true, campaignId: 1002, adGroupId: 2002 }) });
    await report({ installId: "c0000000-0000-4000-8000-000000000014", environment: "sandbox", attributionToken: token({ attribution: true, campaignId: 1999 }) });
    await report({ installId: "c0000000-0000-4000-8000-000000000015", attributionToken: token({ attribution: false }) });
    const opts = await call(owner, `/api/v1/apps/${appId}/config/attribution-options`);
    expect(opts.status).toBe(200);
    expect(opts.json).toEqual({
      appId,
      days: 30,
      campaigns: [
        { id: "1001", name: null, installs: 2 },
        { id: "1002", name: null, installs: 1 },
      ],
      adGroups: [
        { id: "2001", campaignId: "1001", name: null, installs: 2 },
        { id: "2002", campaignId: "1002", name: null, installs: 1 },
      ],
      keywords: [
        { id: "3001", campaignId: "1001", adGroupId: "2001", name: null, installs: 1 },
        { id: "3002", campaignId: "1001", adGroupId: "2001", name: null, installs: 1 },
      ],
    });
    expect((await call(owner, `/api/v1/apps/${appId}/config/attribution-options?days=0`)).status).toBe(400);
  });
});

describe("test data", () => {
  it("test devices: validated, at most 50, per app of the workspace", async () => {
    const { owner, appId } = await newApp("Devices", "com.example.devices");
    const path = `/api/v1/apps/${appId}/test-devices`;
    expect((await call(owner, path)).json).toEqual({ appId, installIds: [], limit: 50 });
    const id = "D0000000-0000-4000-8000-000000000001";
    const put = await call(owner, path, { method: "PUT", body: { installIds: [id, id.toLowerCase()] } });
    expect(put.json).toEqual({ appId, installIds: [id.toLowerCase()], limit: 50 });
    expect((await call(owner, path, { method: "PUT", body: { installIds: ["nope"] } })).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => `d0000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect((await call(owner, path, { method: "PUT", body: { installIds: many } })).status).toBe(400);
    expect((await call(owner, "/api/v1/apps/nope/test-devices")).status).toBe(404);
    expect((await call(null, path)).status).toBe(401);
  });

  it("events summary and funnel reports: production by default, test devices left out, everything with includeTest", async () => {
    const { owner, appId } = await newApp("Events test data", "com.example.eventstest");
    const device = "e0000000-0000-4000-8000-000000000001";
    await call(owner, `/api/v1/apps/${appId}/test-devices`, { method: "PUT", body: { installIds: [device] } });
    const sqls: string[] = [];
    fetchMock
      .get(CF)
      .intercept({ path: SQL_PATH, method: "POST" })
      .reply((opts) => {
        sqls.push(String(opts.body));
        return { statusCode: 200, data: JSON.stringify({ meta: [], data: [], rows: 0 }) };
      })
      .times(6);
    const prod = await call(owner, `/api/v1/apps/${appId}/events/summary?range=7d`);
    expect(prod.status).toBe(200);
    expect(prod.json.includeTest).toBe(false);
    expect(sqls).toHaveLength(3);
    for (const q of sqls) expect(q).toContain(`AND (blob18 = 'production' OR double3 < 2) AND blob2 NOT IN ('${device}')`);
    const all = await call(owner, `/api/v1/apps/${appId}/events/summary?range=7d&includeTest=true`);
    expect(all.json.includeTest).toBe(true);
    expect(sqls).toHaveLength(6);
    for (const q of sqls.slice(3)) expect(q).not.toContain("blob18");
  });

  it("LTV, attributed revenue and coverage count production installs only (legacy rows included), test devices left out", async () => {
    const { owner, appId, sdkKey, key } = await newApp("Revenue test data", "com.example.revtest");
    const report = async (body: object) => {
      const res = await SELF.fetch(`${ORIGIN}/sdk/v1/report`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sdkKey, ...body }) });
      expect(res.status).toBe(200);
    };
    const post = async (tx: TxOptions) =>
      expect((await call(null, `/apple/notifications/${key}`, { body: { signedPayload: (await notification("ONE_TIME_CHARGE", { type: "Non-Consumable", ...tx })).signedPayload } })).status).toBe(200);
    const prod = "f0000000-0000-4000-8000-000000000001";
    const legacy = "f0000000-0000-4000-8000-000000000002";
    const sandbox = "f0000000-0000-4000-8000-000000000003";
    const xcode = "f0000000-0000-4000-8000-000000000004";
    const device = "f0000000-0000-4000-8000-000000000005";
    const ads = (c: number) => token({ attribution: true, campaignId: c, adGroupId: c + 1 });
    await report({ installId: prod, environment: "production", attributionToken: ads(100) });
    await report({ installId: legacy, attributionToken: ads(200) });
    await report({ installId: sandbox, environment: "sandbox", attributionToken: ads(300) });
    await report({ installId: xcode, environment: "xcode", attributionToken: ads(400) });
    await report({ installId: device, attributionToken: ads(500) });
    // Rows from before the SDK sent its environment.
    await dbExec("UPDATE attributions SET environment = NULL WHERE install_id = ?", [legacy]);
    const t = Date.now() - 60_000;
    // Production purchases (environment Production) linked by appAccountToken to every install.
    for (const [i, install] of [prod, legacy, sandbox, xcode, device].entries())
      await post({ bundleId: "com.example.revtest", transactionId: `77000${i}`, purchaseDate: t, price: 9990, appAccountToken: install });

    const read = async () => {
      const attributed = await call(owner, `/api/v1/revenue/attributed?apps=${appId}&range=7d`);
      const ltv = await call(owner, `/api/v1/ltv/summary?apps=${appId}&by=campaign&range=7d`);
      return { attributed: attributed.json, ltv: ltv.json };
    };
    let r = await read();
    // Before the device is marked: production + legacy + the (production) device.
    expect(r.attributed.coverage).toEqual({ installs: 3, attributed: 3, testInstalls: 0 });
    expect(r.attributed.rows.filter((x: any) => x.revenue > 0).map((x: any) => x.campaignId).sort()).toEqual(["100", "200", "500"]);
    expect(r.ltv.coverage.installs).toBe(3);
    expect(r.ltv.rows.map((x: any) => x.group).sort()).toEqual(["100", "200", "500"]);

    await call(owner, `/api/v1/apps/${appId}/test-devices`, { method: "PUT", body: { installIds: [device] } });
    r = await read();
    expect(r.attributed.coverage).toEqual({ installs: 2, attributed: 2, testInstalls: 0 });
    expect(r.attributed.rows.filter((x: any) => x.revenue > 0).map((x: any) => [x.campaignId, x.revenue]).sort()).toEqual([
      ["100", 9.99],
      ["200", 9.99],
    ]);
    expect(r.ltv.coverage.installs).toBe(2);
    expect(r.ltv.rows.map((x: any) => [x.group, x.installs, x.revenue]).sort()).toEqual([
      ["100", 1, 9.99],
      ["200", 1, 9.99],
    ]);
  });

  it("an install moves toward production only: sandbox → production counts at once, NULL rows are filled", async () => {
    const { owner, appId, sdkKey, key } = await newApp("Env upgrade", "com.example.envupgrade");
    const report = async (body: object) => expect((await call(null, "/sdk/v1/report", { body: { sdkKey, ...body } })).status).toBe(200);
    const envOf = async (id: string) => (await rows<{ environment: string | null }>("SELECT environment FROM attributions WHERE install_id = ?", id))[0]?.environment;
    const tf = "f1000000-0000-4000-8000-000000000001";
    const legacySandbox = "f1000000-0000-4000-8000-000000000002";
    const legacyProd = "f1000000-0000-4000-8000-000000000003";
    await report({ installId: tf, environment: "sandbox", attributionToken: token({ attribution: true, campaignId: 600, adGroupId: 601 }) });
    await report({ installId: legacySandbox });
    await report({ installId: legacyProd });
    await dbExec("UPDATE attributions SET environment = NULL WHERE install_id IN (?, ?)", [legacySandbox, legacyProd]);
    await call(null, `/apple/notifications/${key}`, {
      body: {
        signedPayload: (
          await notification("ONE_TIME_CHARGE", { type: "Non-Consumable", bundleId: "com.example.envupgrade", transactionId: "781000", purchaseDate: Date.now() - 60_000, price: 4990, appAccountToken: tf })
        ).signedPayload,
      },
    });
    const read = async () => ({
      attributed: (await call(owner, `/api/v1/revenue/attributed?apps=${appId}&range=7d`)).json,
      ltv: (await call(owner, `/api/v1/ltv/summary?apps=${appId}&by=campaign&range=7d`)).json,
    });
    // TestFlight install: left out (and its reads cached).
    let r = await read();
    expect(r.attributed.rows.filter((x: any) => x.campaignId === "600")).toEqual([]);
    expect(r.ltv.rows.map((x: any) => x.group)).not.toContain("600");

    // The same install now reports from the App Store build: production, counted at once.
    await report({ installId: tf, environment: "production" });
    expect(await envOf(tf)).toBe("production");
    r = await read();
    expect(r.attributed.rows.filter((x: any) => x.revenue > 0).map((x: any) => [x.campaignId, x.revenue])).toEqual([["600", 4.99]]);
    // (The two legacy installs are organic production installs.)
    expect(r.ltv.rows.filter((x: any) => x.group === "600").map((x: any) => [x.group, x.installs, x.revenue])).toEqual([["600", 1, 4.99]]);
    // Never back.
    await report({ installId: tf, environment: "sandbox" });
    expect(await envOf(tf)).toBe("production");

    // Legacy NULL rows take the next report's environment (an older SDK sends none: production).
    await report({ installId: legacySandbox, environment: "sandbox" });
    await report({ installId: legacyProd });
    expect([await envOf(legacySandbox), await envOf(legacyProd)]).toEqual(["sandbox", "production"]);
    // ... and can still move to production later.
    await report({ installId: legacySandbox, environment: "production" });
    expect(await envOf(legacySandbox)).toBe("production");
  });

  it("offer signature requests carry the build's environment", () => {
    const base = { installId: "f1000000-0000-4000-8000-000000000001", productId: "com.example.pro", offerId: "save50" };
    expect(parseSignRequest({ ...base, environment: "sandbox" })).toMatchObject({ environment: "sandbox" });
    expect(parseSignRequest(base)).toMatchObject({ environment: "production" });
  });
});


