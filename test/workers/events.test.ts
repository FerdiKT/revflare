import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eventsTestHooks, RATE_LIMITS, resetEventsState, sdkAppStats } from "../../worker/lib/events";
import { resetFunnelCache } from "../../worker/lib/funnels";
import { resetWaeCache, waeStats } from "../../worker/lib/wae";
import { DAY, call, notification, ownerClient, type Client } from "./helpers";

const stats = () => env.DATABASE.get(env.DATABASE.idFromName("main")).stats();
const CF = "https://api.cloudflare.com";
const SQL_PATH = `/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`;
const MIN = 60_000;
const HOUR = 60 * MIN;
const uuid = (i: number, prefix = "00000000") => `${prefix}-0000-4000-8000-${String(i).padStart(12, "0")}`;

const points: AnalyticsEngineDataPoint[] = [];

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
beforeEach(() => {
  points.length = 0;
  eventsTestHooks.binding = { writeDataPoint: (p?: AnalyticsEngineDataPoint) => void points.push(p!) };
  resetEventsState();
  resetWaeCache();
  resetFunnelCache();
});
afterEach(() => {
  eventsTestHooks.binding = null;
  fetchMock.assertNoPendingInterceptors();
});

const send = (key: string | null, body: unknown) =>
  call(null, "/sdk/v1/events", { body, headers: key ? { "x-revflare-key": key } : {} });

async function newApp(owner: Client, bundleId: string) {
  const app = await call(owner, "/api/v1/apps", { body: { name: bundleId, bundleId } });
  expect(app.status).toBe(201);
  return { id: app.json.id as string, sdkKey: app.json.sdkKey as string, notifKey: (app.json.revflareNotificationUrl as string).split("/").pop()! };
}

type Sql = { sql: string; auth: string };

/** Answers Analytics Engine SQL API calls with `answer(sql)` (rows), recording them. */
function interceptSql(times: number, answer: (sql: string) => Record<string, unknown>[], sink: Sql[]) {
  fetchMock
    .get(CF)
    .intercept({ path: SQL_PATH, method: "POST" })
    .reply((opts) => {
      const h = opts.headers as Record<string, string> | string[] | undefined;
      let auth = "";
      if (Array.isArray(h)) for (let i = 0; i < h.length; i += 2) if (h[i].toLowerCase() === "authorization") auth = h[i + 1];
      if (!Array.isArray(h)) auth = String(Object.entries(h ?? {}).find(([k]) => k.toLowerCase() === "authorization")?.[1] ?? "");
      const sql = String(opts.body);
      sink.push({ sql, auth });
      return { statusCode: 200, data: JSON.stringify({ meta: [], data: answer(sql), rows: 0 }) };
    })
    .times(times);
}

describe("events ingest", { timeout: 60_000 }, () => {
  it("validates, writes one data point per event, caches the SDK key and rate limits", async () => {
    const owner = await ownerClient();
    const { id, sdkKey } = await newApp(owner, "com.example.events");
    const install = uuid(1, "aaaaaaaa");
    const now = Date.now();
    const ev = (i: number, over: Record<string, unknown> = {}) => ({ id: uuid(i), name: "paywall_view", ts: now - MIN, sessionId: uuid(99), props: { placement: "onboarding" }, ...over });

    expect((await send(null, { installId: install, events: [ev(1)] })).status).toBe(400);
    expect((await call(null, "/sdk/v1/events", { method: "POST", headers: { "x-revflare-key": sdkKey, "content-type": "application/json" } })).status).toBe(400);
    expect((await send(sdkKey, { installId: "not-a-uuid", events: [] })).status).toBe(400);
    expect((await send(sdkKey, { installId: install, events: Array.from({ length: 201 }, (_, i) => ev(i)) })).status).toBe(413);
    expect((await send("rfp_unknown", { installId: install, events: [ev(1)] })).status).toBe(404);

    const ok = await send(sdkKey, {
      installId: install,
      appVersion: "2.1",
      appBuild: "77",
      osVersion: "18.1",
      locale: "en_US",
      events: [ev(1, { props: { placement: "onboarding", step: 1, color: "blue" } }), ev(2, { name: "bad name" }), ev(3, { ts: now - 8 * DAY }), ev(4, { ts: now + 2 * HOUR }), ev(5, { name: "onboarding_step" })],
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ ok: true, accepted: 2, dropped: 3 });
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({
      indexes: [id],
      blobs: ["paywall_view", install, uuid(99), "2.1", "77", "18.1", expect.any(String), "en_US", uuid(1), owner.workspaceId, '{"placement":"onboarding","step":"1","color":"blue"}', "onboarding", "", "", "1", "", "", "production"],
      doubles: [now - MIN, expect.any(Number), 2],
    });
    expect(points[1].blobs![0]).toBe("onboarding_step");
    // The build's environment (top level of the body) goes to blob18.
    expect((await send(sdkKey, { installId: install, environment: "sandbox", events: [ev(6)] })).status).toBe(200);
    expect(points[2].blobs![17]).toBe("sandbox");

    // The SDK key is cached (unknown keys too): no database reads per request without key events (app_open is not one).
    const dbBefore = sdkAppStats.database;
    let before = await stats();
    for (let i = 0; i < 3; i++) expect((await send(sdkKey, { installId: install, events: [ev(10 + i, { name: "app_open" })] })).status).toBe(200);
    expect((await send("rfp_unknown", { installId: install, events: [ev(1)] })).status).toBe(404);
    let after = await stats();
    expect(after.rowsRead - before.rowsRead).toBe(0);
    expect(after.rowsWritten - before.rowsWritten).toBe(0);
    expect(sdkAppStats.database).toBe(dbBefore);

    // Status: binding and query settings, last event noted.
    const status = await call(owner, `/api/v1/apps/${id}/analytics/status`);
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ ingest: true, query: true, dataset: "revflare_events", missing: [], sdkKey });
    expect(status.json.lastEventAt).toBeGreaterThan(now - MIN);
    // The sandbox batch above: test builds are noted apart.
    expect(status.json.lastTestEventAt).toBeGreaterThan(now - MIN);

    // Rate limit: an install sending more than its bucket gets 429 with Retry-After; another install is fine.
    const noisy = uuid(2, "bbbbbbbb");
    const batch = (start: number) => ({ installId: noisy, events: Array.from({ length: 200 }, (_, i) => ev(start + i)) });
    for (let k = 0; k < RATE_LIMITS.install.capacity / 200; k++) expect((await send(sdkKey, batch(1000 + k * 200))).status).toBe(200);
    const limited = await send(sdkKey, batch(5000));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await send(sdkKey, { installId: uuid(3, "cccccccc"), events: [ev(1)] })).status).toBe(200);

    // Without the binding: accepted with 200, nothing written.
    eventsTestHooks.binding = null;
    points.length = 0;
    expect((await send(sdkKey, { installId: install, events: [ev(20)] })).json).toEqual({ ok: true, accepted: 0, dropped: 1 });
    expect(points).toHaveLength(0);
    before = await stats();
    after = await stats();
    expect(after.rowsWritten - before.rowsWritten).toBe(0);
  });
});

describe("funnels", { timeout: 60_000 }, () => {
  it("CRUD with validation, report from Analytics Engine plus revenue steps, cached", async () => {
    const owner = await ownerClient();
    const bundleId = "com.example.funnels";
    const { id, notifKey } = await newApp(owner, bundleId);
    const base = `/api/v1/apps/${id}/funnels`;

    for (const bad of [
      {},
      { name: "x", steps: [{ type: "event", name: "a" }] },
      { name: "x", steps: [{ type: "revenue", kind: "paid" }, { type: "event", name: "a" }] },
      { name: "x", steps: [{ type: "event", name: "a'; DROP" }, { type: "event", name: "b" }] },
      { name: "x", steps: [{ type: "event", name: "a", filters: [{ key: "step", value: "1' OR '1'='1" }] }, { type: "event", name: "b" }] },
      { name: "x", steps: [{ type: "event", name: "a" }, { type: "event", name: "b" }], window: "1y" },
    ]) {
      const r = await call(owner, base, { body: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.json.error).toBeTruthy();
    }
    const created = await call(owner, base, {
      body: {
        name: "Onboarding to trial",
        steps: [{ type: "event", name: "onboarding_step", filters: [{ key: "step", value: "1" }] }, { type: "event", name: "paywall_view" }, { type: "revenue", kind: "trial_started" }],
        window: "7d",
      },
    });
    expect(created.status).toBe(201);
    const fid = created.json.id as string;
    expect(created.json).toMatchObject({ appId: id, name: "Onboarding to trial", windowSeconds: 7 * 86_400, ordered: true });
    expect((await call(owner, base)).json.items.map((f: { id: string }) => f.id)).toEqual([fid]);
    const patched = await call(owner, `${base}/${fid}`, { method: "PATCH", body: { name: "Onboarding" } });
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({ name: "Onboarding", steps: created.json.steps });
    expect((await call(owner, `${base}/${fid}`, { method: "PATCH", body: { steps: [] } })).status).toBe(400);
    expect((await call(owner, `${base}/nope`)).status).toBe(404);
    expect((await call(owner, `/api/v1/apps/other/funnels/${fid}`)).status).toBe(404);

    // Install A started a trial (appAccountToken = install id) after the paywall; B saw the paywall; C dropped.
    const now = Date.now();
    const [a, b, c] = [uuid(11, "dddddddd"), uuid(12, "dddddddd"), uuid(13, "dddddddd")];
    const n = await notification("SUBSCRIBED", {
      bundleId,
      transactionId: `${now}77`,
      productId: `${bundleId}.annual`,
      purchaseDate: now - 2 * HOUR,
      expiresDate: now + 5 * DAY,
      price: 0,
      offerType: 1,
      offerDiscountType: "FREE_TRIAL",
      appAccountToken: a.toUpperCase(),
    });
    expect((await call(null, `/apple/notifications/${notifKey}`, { body: { signedPayload: n.signedPayload } })).status).toBe(200);

    const sqls: Sql[] = [];
    interceptSql(2, (sql) => {
      if (sql.includes("blob1 = 'onboarding_step'"))
        return [
          { install: a, first: now - 3 * HOUR, last: now - 3 * HOUR, n: "1", si: 1, b: "2.0" },
          { install: b, first: now - 3 * HOUR, last: now - 3 * HOUR, n: "1", si: 1, b: "2.0" },
          { install: c, first: now - 3 * HOUR, last: now - 3 * HOUR, n: "1", si: 1, b: "1.9" },
        ];
      if (sql.includes("blob1 = 'paywall_view'"))
        return [
          { install: a, first: now - 170 * MIN, last: now - 170 * MIN, n: 1, si: 1 },
          { install: b, first: now - 160 * MIN, last: now - 160 * MIN, n: 1, si: 1 },
        ];
      return [];
    }, sqls);
    const report = await call(owner, `${base}/${fid}/report?range=7d&breakdown=app_version`);
    expect(report.status, report.text).toBe(200);
    expect(sqls).toHaveLength(2);
    for (const q of sqls) {
      expect(q.auth).toBe(`Bearer ${env.CF_ANALYTICS_TOKEN}`);
      expect(q.sql).toContain(`FROM revflare_events WHERE index1 = '${id}'`);
    }
    expect(sqls.find((q) => q.sql.includes("onboarding_step"))!.sql).toContain("blob15 = '1'");
    expect(report.json.steps).toEqual([
      { index: 0, label: "onboarding_step (step=1)", users: 3, conversionFromPrevious: 1, conversionFromFirst: 1, dropOff: 0, medianSecondsFromPrevious: null },
      { index: 1, label: "paywall_view", users: 2, conversionFromPrevious: 2 / 3, conversionFromFirst: 2 / 3, dropOff: 1, medianSecondsFromPrevious: 15 * 60 },
      { index: 2, label: "Trial started", users: 1, conversionFromPrevious: 0.5, conversionFromFirst: 1 / 3, dropOff: 1, medianSecondsFromPrevious: 50 * 60 },
    ]);
    expect(report.json.groups.map((g: { value: string; steps: { users: number }[] }) => [g.value, g.steps.map((s) => s.users)])).toEqual([
      ["2.0", [2, 2, 1]],
      ["1.9", [1, 0, 0]],
    ]);
    expect(report.json.approximate).toBe(false);

    // Same report again: from the cache, no SQL API call (net connect is disabled).
    const again = await call(owner, `${base}/${fid}/report?range=7d&breakdown=app_version`);
    expect(again.status).toBe(200);
    expect(again.json.steps).toEqual(report.json.steps);
    expect((await call(owner, `${base}/${fid}/report?breakdown=blob1`)).status).toBe(400);

    // SQL API errors are reported as 502.
    fetchMock.get(CF).intercept({ path: SQL_PATH, method: "POST" }).reply(403, { errors: [{ message: "Authentication error" }] })
      .times(2);
    const denied = await call(owner, `${base}/${fid}/report?range=3d`);
    expect(denied.status).toBe(502);
    expect(denied.json.error).toContain("Account Analytics Read");

    expect((await call(owner, `${base}/${fid}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(owner, `${base}/${fid}`, { method: "DELETE" })).status).toBe(404);
  });

  it("events summary: top events and a per-day series, cached", async () => {
    const owner = await ownerClient();
    const { id } = await newApp(owner, "com.example.eventsummary");
    const today = new Date().toISOString().slice(0, 10);
    const sqls: Sql[] = [];
    interceptSql(3, (sql) => {
      if (sql.includes("GROUP BY name ORDER BY events DESC"))
        return [
          { name: "app_open", events: "120", installs: "40", si: 1, last: Date.now() },
          { name: "paywall_view", events: "30", installs: "25", si: 1, last: Date.now() },
        ];
      if (sql.includes("GROUP BY day, name"))
        return [
          { day: `${today} 00:00:00`, name: "app_open", events: "100" },
          { day: `${today} 00:00:00`, name: "paywall_view", events: "30" },
        ];
      return [{ events: "150", installs: "41", si: 1 }];
    }, sqls);
    const r = await call(owner, `/api/v1/apps/${id}/events/summary?range=7d`);
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ appId: id, days: 7, to: today, totalEvents: 150, uniqueInstalls: 41, approximate: false });
    expect(r.json.events.map((e: { name: string; count: number; installs: number }) => [e.name, e.count, e.installs])).toEqual([
      ["app_open", 120, 40],
      ["paywall_view", 30, 25],
    ]);
    expect(r.json.daily).toHaveLength(7);
    expect(r.json.daily.at(-1)).toEqual({ date: today, count: 130, byEvent: { app_open: 100, paywall_view: 30 } });
    const requests = waeStats.requests;
    expect((await call(owner, `/api/v1/apps/${id}/events/summary?range=7d`)).status).toBe(200);
    expect(waeStats.requests).toBe(requests);
    expect((await call(owner, `/api/v1/apps/${id}/events/summary?range=1y`)).status).toBe(400);
  });
});
