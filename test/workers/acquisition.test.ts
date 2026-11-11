import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import chain from "../fixtures/apple-test-chain.json";
import { DAY, call, ownerClient } from "./helpers";

// App Store acquisition: App Analytics report requests, report instances and segments (synthetic data).

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const ASC = "https://api.appstoreconnect.apple.com";
const FILES = "https://reports.example.com";
const APPLE_ID = "1234567890";
const day = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const gzip = async (text: string) => new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
const tsv = (head: string[], rows: (string | number)[][]) => [head.join("\t"), ...rows.map((r) => r.join("\t"))].join("\n") + "\n";
const DL = ["Date", "App Apple Identifier", "Download Type", "Device", "Source Type", "Page Type", "Territory", "Counts"];
const ENG = ["Date", "App Apple Identifier", "Event", "Page Type", "Source Type", "Source Info", "Campaign", "Engagement Type", "Device", "Territory", "Counts", "Unique Counts"];
const dbExec = (sql: string, params: (string | number)[] = []) => env.DATABASE.get(env.DATABASE.idFromName("main")).exec([{ sql, params, mode: "run" }], false);

// The owner's workspace is shared by the whole suite (isolatedStorage: false): late in a full run its reads take
// seconds, so these tests get the same 60 s budget as the other slow worker tests.
describe("App Store acquisition (App Analytics reports)", () => {
  it("requests reports, imports instances oldest first (newer ones replace their days) and serves them", async () => {
    const owner = await ownerClient();
    const pem = `-----BEGIN PRIVATE KEY-----\n${chain.leafKey}\n-----END PRIVATE KEY-----`;
    // Main key (Admin) and a reports-only key (Sales): the reports key is tried first.
    expect((await call(owner, "/api/v1/credentials", { body: { kind: "appstore_connect", name: "Main", keyId: "MAINKEY001", issuerId: "5f0c2a7e-3b9d-4e61-9a84-2d7c1e6b0f53", privateKey: pem } })).status).toBe(201);
    const reportsKey = await call(owner, "/api/v1/credentials", {
      body: { kind: "appstore_reports", name: "Reports", keyId: "SALESKEY01", issuerId: "5f0c2a7e-3b9d-4e61-9a84-2d7c1e6b0f53", privateKey: pem, vendorNumber: "12345678" },
    });
    expect(reportsKey.status).toBe(201);
    const app = await call(owner, "/api/v1/apps", { body: { name: "Acquired", bundleId: "com.example.acquired", appleAppId: APPLE_ID } });
    const appId = app.json.id as string;

    // No request at Apple yet; the Sales key may not create one (403), the main key does.
    fetchMock
      .get(ASC)
      .intercept({ path: (p) => p.startsWith(`/v1/apps/${APPLE_ID}/analyticsReportRequests`), method: "GET" })
      .reply(200, { data: [] });
    fetchMock.get(ASC).intercept({ path: "/v1/analyticsReportRequests", method: "POST" }).reply(403, { errors: [{ status: "403", title: "Forbidden", detail: "The API key in use does not allow this request" }] });
    fetchMock.get(ASC).intercept({ path: "/v1/analyticsReportRequests", method: "POST" }).reply(201, { data: { type: "analyticsReportRequests", id: "req-1" } });
    const req = await call(owner, "/api/v1/acquisition/requests", { body: { appIds: [appId] } });
    expect(req.status).toBe(200);
    expect(req.json).toMatchObject({ created: [{ appId, name: "Acquired" }], existing: [], failed: [], remaining: 0 });
    // Already requested: nothing to do.
    expect((await call(owner, "/api/v1/acquisition/requests", { body: { appIds: [appId] } })).json).toMatchObject({ created: [], existing: [], failed: [] });
    expect((await call(owner, `/api/v1/apps/${appId}`)).json.acquisition).toMatchObject({ state: "requested", requestId: "req-1", reports: [], lastDay: null });
    const empty = await call(owner, `/api/v1/acquisition?apps=${appId}`);
    expect(empty.json).toMatchObject({ firstDay: null, rows: [], level: "standard" });

    // Apple's reports: downloads (Standard) with two daily instances, engagement (Detailed) with one.
    fetchMock
      .get(ASC)
      .intercept({ path: (p) => p.startsWith("/v1/analyticsReportRequests/req-1/reports"), method: "GET" })
      .reply(200, {
        data: [
          { type: "analyticsReports", id: "rep-dl", attributes: { name: "App Downloads Standard", category: "COMMERCE" } },
          { type: "analyticsReports", id: "rep-eng-d", attributes: { name: "App Store Discovery and Engagement Detailed", category: "APP_STORE_ENGAGEMENT" } },
          { type: "analyticsReports", id: "rep-sessions", attributes: { name: "App Sessions Standard", category: "APP_USAGE" } },
        ],
      });
    fetchMock
      .get(ASC)
      .intercept({ path: (p) => p.startsWith("/v1/analyticsReports/rep-dl/instances"), method: "GET" })
      .reply(200, {
        data: [
          { type: "analyticsReportInstances", id: "inst-2", attributes: { granularity: "DAILY", processingDate: day(1) } },
          { type: "analyticsReportInstances", id: "inst-1", attributes: { granularity: "DAILY", processingDate: day(2) } },
        ],
      });
    // inst-1 (older): days 4 and 3; inst-2 (newer): day 3 again (complete now) and day 2.
    fetchMock.get(ASC).intercept({ path: (p) => p.startsWith("/v1/analyticsReportInstances/inst-1/segments") }).reply(200, { data: [{ type: "analyticsReportSegments", id: "seg-1", attributes: { url: `${FILES}/seg-1.gz` } }] });
    fetchMock.get(ASC).intercept({ path: (p) => p.startsWith("/v1/analyticsReportInstances/inst-2/segments") }).reply(200, { data: [{ type: "analyticsReportSegments", id: "seg-2", attributes: { url: `${FILES}/seg-2.gz` } }] });
    fetchMock
      .get(FILES)
      .intercept({ path: "/seg-1.gz" })
      .reply(
        200,
        await gzip(
          tsv(DL, [
            [day(4), APPLE_ID, "First-time download", "iPhone", "App Store search", "Product page", "US", 10],
            [day(4), APPLE_ID, "Redownload", "iPhone", "App Store search", "Product page", "US", 2],
            [day(3), APPLE_ID, "First-time download", "iPhone", "App Store browse", "Product page", "US", 1],
          ]),
        ),
      );
    fetchMock
      .get(FILES)
      .intercept({ path: "/seg-2.gz" })
      .reply(
        200,
        await gzip(
          tsv(DL, [
            [day(3), APPLE_ID, "First-time download", "iPhone", "App Store browse", "Product page", "US", 5],
            [day(3), APPLE_ID, "First-time download", "iPad", "Web referrer", "Product page", "DE", 4],
            [day(2), APPLE_ID, "First-time download", "iPhone", "App Store search", "Product page", "US", 6],
            [day(2), APPLE_ID, "Manual update", "iPhone", "App Store search", "Product page", "US", 50],
          ]),
        ),
      );
    fetchMock
      .get(ASC)
      .intercept({ path: (p) => p.startsWith("/v1/analyticsReports/rep-eng-d/instances") })
      .reply(200, { data: [{ type: "analyticsReportInstances", id: "inst-3", attributes: { granularity: "DAILY", processingDate: day(1) } }] });
    fetchMock.get(ASC).intercept({ path: (p) => p.startsWith("/v1/analyticsReportInstances/inst-3/segments") }).reply(200, { data: [{ type: "analyticsReportSegments", id: "seg-3", attributes: { url: `${FILES}/seg-3.gz` } }] });
    fetchMock
      .get(FILES)
      .intercept({ path: "/seg-3.gz" })
      .reply(
        200,
        await gzip(
          tsv(ENG, [
            [day(3), APPLE_ID, "Page view", "Product page", "Web referrer", "example.com", "launch_post", "", "iPhone", "US", 40, 30],
            [day(3), APPLE_ID, "Impression", "No page", "App Store search", "", "", "", "iPhone", "US", 500, 400],
          ]),
        ),
      );
    const sync = await call(owner, "/api/v1/acquisition/sync", { body: { appIds: [appId] } });
    expect(sync.status).toBe(200);
    expect(sync.json).toMatchObject({ apps: 1, instances: 3, more: false, errors: [] });

    const bySource = await call(owner, `/api/v1/acquisition?apps=${appId}&range=7d&by=source&currency=USD`);
    expect(bySource.json.level).toBe("standard");
    expect(bySource.json.firstDay).toBe(day(4));
    expect(bySource.json.lastDay).toBe(day(2));
    // Day 3 comes from inst-2 only (5 browse + 4 web), not 1 + 5 + 4.
    expect(bySource.json.totals).toMatchObject({ downloads: 25, redownloads: 2 });
    expect(bySource.json.rows.map((r: any) => [r.sourceType, r.downloads])).toEqual([
      ["App Store search", 16],
      ["App Store browse", 5],
      ["Web referrer", 4],
    ]);
    const byDay = await call(owner, `/api/v1/acquisition?apps=${appId}&range=7d&by=day`);
    expect(byDay.json.rows.map((r: any) => [r.day, r.downloads])).toEqual([
      [day(4), 10],
      [day(3), 9],
      [day(2), 6],
    ]);
    const byCampaign = await call(owner, `/api/v1/acquisition?apps=${appId}&range=7d&by=campaign`);
    expect(byCampaign.json.level).toBe("detailed");
    expect(byCampaign.json.rows).toEqual([
      expect.objectContaining({ campaign: "launch_post", pageViews: 40, pageViewsUnique: 30 }),
      expect.objectContaining({ campaign: "", impressions: 500, pageViews: 0 }),
    ]);
    const byReferrer = await call(owner, `/api/v1/acquisition?apps=${appId}&range=7d&by=source,referrer`);
    expect(byReferrer.json.rows).toContainEqual(expect.objectContaining({ sourceType: "Web referrer", referrer: "example.com", pageViews: 40 }));
    expect((await call(owner, `/api/v1/acquisition?by=country`)).status).toBe(400);

    const campaigns = await call(owner, `/api/v1/acquisition/campaigns?apps=${appId}`);
    expect(campaigns.json.items).toEqual([expect.objectContaining({ campaign: "launch_post", appId, appleAppId: APPLE_ID, firstSeen: day(3), lastSeen: day(3), pageViews: 40 })]);
    const status = await call(owner, `/api/v1/acquisition/status?apps=${appId}`);
    expect(status.json.items).toEqual([
      expect.objectContaining({ appId, state: "producing", requestId: "req-1", reports: ["downloads", "engagement_detailed"], lastProcessingDate: day(1), firstDay: day(4), lastDay: day(2), error: null }),
    ]);

    // Next round: the four missing reports are looked for again; no new instances, nothing downloaded.
    fetchMock
      .get(ASC)
      .intercept({ path: (p) => p.startsWith("/v1/analyticsReportRequests/req-1/reports") })
      .reply(200, { data: [{ type: "analyticsReports", id: "rep-dl", attributes: { name: "App Downloads Standard" } }] });
    fetchMock
      .get(ASC)
      .intercept({ path: (p) => p.startsWith("/v1/analyticsReports/rep-dl/instances") })
      .reply(200, { data: [{ type: "analyticsReportInstances", id: "inst-2", attributes: { processingDate: day(1) } }, { type: "analyticsReportInstances", id: "inst-1", attributes: { processingDate: day(2) } }] });
    fetchMock
      .get(ASC)
      .intercept({ path: (p) => p.startsWith("/v1/analyticsReports/rep-eng-d/instances") })
      .reply(200, { data: [{ type: "analyticsReportInstances", id: "inst-3", attributes: { processingDate: day(1) } }] });
    const again = await call(owner, "/api/v1/acquisition/sync", { body: { appIds: [appId] } });
    expect(again.json).toMatchObject({ apps: 1, instances: 0, requests: 3 });
  }, 60_000);

  it("stops when the background budget is used up", async () => {
    const owner = await ownerClient();
    const key = `bg:${new Date().toISOString().slice(0, 10)}`;
    const prev = (await env.DATABASE.get(env.DATABASE.idFromName("main")).exec([{ sql: "SELECT value FROM settings WHERE key = ?", params: [key], mode: "first" }], false)) as unknown as { results: { value?: string }[] }[];
    await dbExec("INSERT INTO settings (key, value) VALUES (?, json_object('w', 1e9, 'r', 0)) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key]);
    try {
      const r = await call(owner, "/api/v1/acquisition/sync", { body: {} });
      expect(r.status).toBe(429);
      expect(r.json).toMatchObject({ code: "budget", instances: 0, requests: 0 });
    } finally {
      const old = prev[0].results[0]?.value;
      if (old) await dbExec("UPDATE settings SET value = ? WHERE key = ?", [old, key]);
      else await dbExec("DELETE FROM settings WHERE key = ?", [key]);
    }
  }, 60_000);

  it("records apps Apple refuses (no Admin key) as failed with the reason", async () => {
    const owner = await ownerClient();
    const app = await call(owner, "/api/v1/apps", { body: { name: "Refused", bundleId: "com.example.refused", appleAppId: "1234567899" } });
    fetchMock
      .get(ASC)
      .intercept({ path: (p) => p.startsWith("/v1/apps/1234567899/analyticsReportRequests") })
      .reply(403, { errors: [{ status: "403", detail: "The API key in use does not allow this request" }] })
      .times(2);
    const r = await call(owner, "/api/v1/acquisition/requests", { body: { appIds: [app.json.id] } });
    expect(r.json.failed).toEqual([expect.objectContaining({ appId: app.json.id, error: expect.stringContaining("Admin role") })]);
    expect((await call(owner, `/api/v1/apps/${app.json.id}`)).json.acquisition).toMatchObject({ state: "failed" });
    // Calling again right away moves on instead of retrying the app that just failed.
    expect((await call(owner, "/api/v1/acquisition/requests", { body: { appIds: [app.json.id], retry: true } })).json).toMatchObject({ failed: [], remaining: 0 });
  }, 60_000);
});
