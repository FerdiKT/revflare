import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../worker/lib/db";
import { eventsTestHooks, resetEventsState } from "../../worker/lib/events";
import { resetFunnelCache } from "../../worker/lib/funnels";
import { exactExposures, exactFunnelSteps, keyEventsTestHooks, pruneKeyEvents, ROWS_PER_INSERT } from "../../worker/lib/key-events";
import { dayOf } from "../../worker/lib/money";
import { resetSummaryCache } from "../../worker/lib/event-summary";
import { resetWaeCache } from "../../worker/lib/wae";
import { DAY, call, ownerClient, type Client } from "./helpers";

// Exact key events (worker/lib/key-events.ts): stored in app_events besides Analytics Engine, read by funnels and the
// events page when they cover the range.

const CF = "https://api.cloudflare.com";
const SQL_PATH = `/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`;
const MIN = 60_000;
const HOUR = 60 * MIN;
const uuid = (i: number, prefix = "00000000") => `${prefix}-0000-4000-8000-${String(i).padStart(12, "0")}`;
const dbExec = (sql: string, params: (string | number | null)[] = []) => env.DATABASE.get(env.DATABASE.idFromName("main")).exec([{ sql, params, mode: "run" }], false);
const rows = <T = Record<string, unknown>>(sql: string, ...params: (string | number)[]) =>
  getDb(env)
    .prepare(sql)
    .bind(...params)
    .all<T>()
    .then((r) => r.results);
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

const points: AnalyticsEngineDataPoint[] = [];

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
beforeEach(() => {
  points.length = 0;
  eventsTestHooks.binding = { writeDataPoint: (p?: AnalyticsEngineDataPoint) => void points.push(p!) };
  keyEventsTestHooks.failStore = 0;
  keyEventsTestHooks.failWrite = false;
  resetEventsState();
  resetWaeCache();
  resetFunnelCache();
  resetSummaryCache();
});
afterEach(() => {
  eventsTestHooks.binding = null;
  keyEventsTestHooks.failStore = 0;
  keyEventsTestHooks.failWrite = false;
  fetchMock.assertNoPendingInterceptors();
});

const send = (key: string, body: unknown) => call(null, "/sdk/v1/events", { body, headers: { "x-revflare-key": key } });

async function newApp(owner: Client, bundleId: string) {
  const app = await call(owner, "/api/v1/apps", { body: { name: bundleId, bundleId } });
  expect(app.status).toBe(201);
  return { id: app.json.id as string, sdkKey: app.json.sdkKey as string };
}

let seq = 0;
const ev = (name: string, over: Record<string, unknown> = {}) => ({ id: uuid(++seq, "e0000000"), name, ts: Date.now() - MIN, ...over });
const stored = (appId: string) => rows<{ id: string; name: string; install_id: string; environment: string; placement: string; props: string }>("SELECT * FROM app_events WHERE app_id = ? ORDER BY name, id", appId);

function interceptSql(times: number, answer: (sql: string) => Record<string, unknown>[], sink: string[] = []) {
  fetchMock
    .get(CF)
    .intercept({ path: SQL_PATH, method: "POST" })
    .reply((opts) => {
      sink.push(String(opts.body));
      return { statusCode: 200, data: JSON.stringify({ meta: [], data: answer(String(opts.body)), rows: 0 }) };
    })
    .times(times);
  return sink;
}

describe("key events ingest", { timeout: 60_000 }, () => {
  it("stores allowlisted events (built-in and app patterns, any case), deduplicated, with their environment", async () => {
    const owner = await ownerClient();
    const { id, sdkKey } = await newApp(owner, "com.example.keyevents.ingest");
    const base = `/api/v1/apps/${id}/key-events`;

    const initial = await call(owner, base);
    expect(initial.status).toBe(200);
    // Default cap: min(50,000, background writes 55,000 / 3 rows an event / 2).
    expect(initial.json).toMatchObject({
      appId: id,
      patterns: [],
      dailyCap: 9_166,
      dailyCapIsDefault: true,
      defaultDailyCap: 9_166,
      backgroundWritesPerDay: 55_000,
      writesPerEvent: 3,
      retentionDays: 180,
      since: null,
      today: { count: 0, capped: false },
    });
    expect(initial.json.builtin).toContain("purchase_*");
    for (const bad of [{ patterns: ["a*b"] }, { patterns: ["**x"] }, { patterns: Array.from({ length: 21 }, (_, i) => `e${i}`) }, { dailyCap: -1 }, { retentionDays: 3 }, { other: 1 }]) {
      const r = await call(owner, base, { method: "PUT", body: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    const put = await call(owner, base, { method: "PUT", body: { patterns: ["*_paywall_view", "Paywall_Trigger", "paywall_trigger"] } });
    expect(put.status).toBe(200);
    expect(put.json.patterns).toEqual(["*_paywall_view", "Paywall_Trigger"]);

    const install = uuid(1, "aaaaaaaa");
    const batch = {
      installId: install,
      appVersion: "3.0",
      events: [
        ev("first_open"),
        ev("PURCHASE_started", { props: { product: "com.example.annual" } }),
        ev("app_open"),
        ev("home_paywall_view", { props: { placement: "home", color: "blue" } }),
        ev("paywall_trigger"),
        ev("screen_view"),
        ev("Onboarding_Step", { props: { step: 2 } }),
      ],
    };
    const r = await send(sdkKey, batch);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, accepted: 7, dropped: 0 });
    // Every event still goes to Analytics Engine.
    expect(points).toHaveLength(7);
    let list = await stored(id);
    expect(list.map((x) => x.name).sort()).toEqual(["Onboarding_Step", "PURCHASE_started", "first_open", "home_paywall_view", "paywall_trigger"].sort());
    const hp = list.find((x) => x.name === "home_paywall_view")!;
    expect(hp).toMatchObject({ install_id: install, environment: "production", placement: "home" });
    expect(JSON.parse(hp.props)).toEqual({ placement: "home", color: "blue" });

    // SDK retry of the same batch: nothing written twice.
    expect((await send(sdkKey, batch)).status).toBe(200);
    expect(await stored(id)).toHaveLength(5);
    const settings = await call(owner, base);
    expect(settings.json.today.count).toBe(5);
    // First stored key event: coverage starts with the first full day after other isolates' SDK-app cache expired.
    expect(settings.json.since).toBe(new Date(Date.now() + 5 * MIN + DAY).toISOString().slice(0, 10));
    // Per-name daily rollup (production builds in count).
    expect(await rows("SELECT name, count, test_count FROM app_event_counts WHERE app_id = ? ORDER BY name", id)).toEqual([
      { name: "Onboarding_Step", count: 1, test_count: 0 },
      { name: "PURCHASE_started", count: 1, test_count: 0 },
      { name: "first_open", count: 1, test_count: 0 },
      { name: "home_paywall_view", count: 1, test_count: 0 },
      { name: "paywall_trigger", count: 1, test_count: 0 },
    ]);

    // The build's environment is stored (readers filter it).
    expect((await send(sdkKey, { installId: install, environment: "sandbox", events: [ev("paywall_view")] })).status).toBe(200);
    list = await stored(id);
    expect(list.find((x) => x.name === "paywall_view")!.environment).toBe("sandbox");

    // More than 100 bound parameters: split into statements of ROWS_PER_INSERT rows.
    expect(ROWS_PER_INSERT).toBe(5);
    const many = Array.from({ length: 23 }, () => ev("paywall_close"));
    expect((await send(sdkKey, { installId: uuid(2, "aaaaaaaa"), events: many })).status).toBe(200);
    expect((await rows<{ n: number }>("SELECT COUNT(*) AS n FROM app_events WHERE app_id = ? AND name = 'paywall_close'", id))[0].n).toBe(23);

    // A database failure never fails the request: the events are in Analytics Engine.
    keyEventsTestHooks.failStore = Infinity;
    points.length = 0;
    const failed = await send(sdkKey, { installId: install, events: [ev("first_open"), ev("app_open")] });
    expect(failed.status).toBe(200);
    expect(failed.json.accepted).toBe(2);
    expect(points).toHaveLength(2);
    expect((await stored(id)).filter((x) => x.name === "first_open")).toHaveLength(1);
  });

  it("retries a failed store once, then flags the day incomplete so reads fall back to sampled data", async () => {
    const owner = await ownerClient();
    const { id, sdkKey } = await newApp(owner, "com.example.keyevents.failures");
    const base = `/api/v1/apps/${id}/key-events`;
    const install = uuid(1, "abababab");

    // One failure: the retry stores the batch.
    keyEventsTestHooks.failStore = 1;
    expect((await send(sdkKey, { installId: install, events: [ev("first_open")] })).status).toBe(200);
    expect(await stored(id)).toHaveLength(1);
    expect((await call(owner, base)).json.today).toMatchObject({ count: 1, capped: false });

    // Two failures (the retry too): remembered in the isolate; the app's next call flags the day (capped = 3).
    keyEventsTestHooks.failStore = 2;
    expect((await send(sdkKey, { installId: install, events: [ev("paywall_view")] })).status).toBe(200);
    expect(await stored(id)).toHaveLength(1);
    expect((await call(owner, base)).json.today.capped).toBe(false);
    expect((await send(sdkKey, { installId: uuid(2, "abababab"), events: [ev("paywall_view")] })).status).toBe(200);
    expect(await rows("SELECT capped FROM app_event_days WHERE app_id = ? AND day = ?", id, today())).toEqual([{ capped: 3 }]);
    expect((await call(owner, base)).json.today.capped).toBe(true);
    // The day is closed: nothing more stored today.
    expect(await stored(id)).toHaveLength(1);
    const alerts = (await call(owner, "/api/v1/alerts")).json.items.filter((a: { kind: string; appId: string }) => a.kind === "key_events_capped" && a.appId === id);
    expect(alerts.map((a: { title: string }) => a.title)).toEqual([`Key events incomplete for com.example.keyevents.failures on ${today()}`]);
    // Reads including the day use sampled data, with a note.
    await dbExec("UPDATE apps SET key_events_since = ? WHERE id = ?", [daysAgo(30), id]);
    interceptSql(3, () => []);
    const summary = await call(owner, `/api/v1/apps/${id}/events/summary?range=7d`);
    expect(summary.status, summary.text).toBe(200);
    expect(summary.json.events).toEqual([]);
    expect(summary.json.notes.join(" ")).toContain(`Key events are incomplete on ${today()}`);
  });

  it("flags the day when a write fails inside the database", async () => {
    const owner = await ownerClient();
    const { id, sdkKey } = await newApp(owner, "com.example.keyevents.writefail");
    keyEventsTestHooks.failWrite = true;
    expect((await send(sdkKey, { installId: uuid(1, "acacacac"), events: [ev("first_open")] })).status).toBe(200);
    expect(await stored(id)).toHaveLength(0);
    expect(await rows("SELECT capped FROM app_event_days WHERE app_id = ? AND day = ?", id, today())).toEqual([{ capped: 3 }]);
  });

  it("caps each install per day and each app per day (Analytics Engine only, one alert)", async () => {
    const owner = await ownerClient();
    const { id, sdkKey } = await newApp(owner, "com.example.keyevents.caps");

    // Per install: 500 key events a day.
    const noisy = uuid(3, "bbbbbbbb");
    for (let k = 0; k < 3; k++) expect((await send(sdkKey, { installId: noisy, events: Array.from({ length: 200 }, () => ev("paywall_view")) })).status).toBe(200);
    expect((await rows<{ n: number }>("SELECT COUNT(*) AS n FROM app_events WHERE app_id = ? AND install_id = ?", id, noisy))[0].n).toBe(500);
    // Another install is not affected.
    expect((await send(sdkKey, { installId: uuid(4, "bbbbbbbb"), events: [ev("paywall_view")] })).status).toBe(200);
    expect((await stored(id)).length).toBe(501);

    // Per app: the daily cap (here 510): over it Analytics Engine only, the day is flagged, one alert.
    expect((await call(owner, `/api/v1/apps/${id}/key-events`, { method: "PUT", body: { dailyCap: 510 } })).status).toBe(200);
    resetEventsState(); // the SDK key cache of this isolate already forgot the app; other caches too
    points.length = 0;
    for (let i = 0; i < 3; i++) expect((await send(sdkKey, { installId: uuid(10 + i, "bbbbbbbb"), events: Array.from({ length: 5 }, () => ev("first_open")) })).status).toBe(200);
    expect(points).toHaveLength(15);
    expect((await stored(id)).length).toBe(510);
    const settings = await call(owner, `/api/v1/apps/${id}/key-events`);
    expect(settings.json.today).toMatchObject({ count: 510, capped: true });
    const alerts = (await call(owner, "/api/v1/alerts")).json.items.filter((a: { kind: string; appId: string }) => a.kind === "key_events_capped" && a.appId === id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toBe("Key events capped for com.example.keyevents.caps today");
    // Later batches: nothing stored, no second alert.
    resetEventsState();
    expect((await send(sdkKey, { installId: uuid(20, "bbbbbbbb"), events: [ev("first_open")] })).status).toBe(200);
    expect((await stored(id)).length).toBe(510);
    expect((await call(owner, "/api/v1/alerts")).json.items.filter((a: { kind: string; appId: string }) => a.kind === "key_events_capped" && a.appId === id)).toHaveLength(1);
  });
});

describe("key events retention", { timeout: 60_000 }, () => {
  it("deletes rows past the app's retention in bounded chunks, then once a day", async () => {
    const owner = await ownerClient();
    const { id } = await newApp(owner, "com.example.keyevents.retention");
    expect((await call(owner, `/api/v1/apps/${id}/key-events`, { method: "PUT", body: { retentionDays: 7 } })).status).toBe(200);
    await dbExec("UPDATE apps SET key_events_since = ? WHERE id = ?", [daysAgo(30), id]);
    const old = Date.now() - 20 * DAY;
    for (let i = 0; i < 12; i++)
      await dbExec("INSERT INTO app_events (app_id, id, install_id, name, ts, received_at) VALUES (?, ?, ?, ?, ?, ?)", [id, `old-${i}`, uuid(i, "cccccccc"), i % 2 ? "first_open" : "paywall_view", old + i, old + i]);
    for (let i = 0; i < 3; i++) await dbExec("INSERT INTO app_events (app_id, id, install_id, name, ts, received_at) VALUES (?, ?, ?, 'first_open', ?, ?)", [id, `new-${i}`, uuid(i, "cccccccc"), Date.now() - HOUR, Date.now() - HOUR]);
    await dbExec("INSERT INTO app_event_days (app_id, day, count) VALUES (?, ?, 12)", [id, daysAgo(20)]);
    await dbExec("DELETE FROM settings WHERE key = 'key_events_pruned'");
    // Rows of other apps (the shared test database) count against the chunk too: run until the pass is done.
    const db = getDb(env);
    let pass = await pruneKeyEvents(db, Date.now(), 5);
    expect(pass).toMatchObject({ deleted: 5, done: false });
    for (let i = 0; i < 50 && pass && !pass.done; i++) {
      pass = await pruneKeyEvents(db, Date.now(), 5);
      expect(pass!.deleted).toBeLessThanOrEqual(5);
    }
    expect(pass?.done).toBe(true);
    expect((await stored(id)).map((x) => x.id).sort()).toEqual(["new-0", "new-1", "new-2"]);
    expect(await rows("SELECT * FROM app_event_days WHERE app_id = ? AND day = ?", id, daysAgo(20))).toHaveLength(0);
    // Done for today: no more work.
    expect(await pruneKeyEvents(db, Date.now(), 5)).toBeNull();
  });
});

describe("exact funnels and events page", { timeout: 60_000 }, () => {
  it("takes a breakdown value from an event matching the step's filters", async () => {
    const owner = await ownerClient();
    const { id, sdkKey } = await newApp(owner, "com.example.keyevents.breakdown");
    await dbExec("UPDATE apps SET key_events_since = ? WHERE id = ?", [daysAgo(30), id]);
    const t = Date.now() - 3 * HOUR;
    // Same install, same time: a filtered-out event (red, home) stored before the matching one (blue, settings).
    const events = [
      ev("onboarding_start", { ts: t, props: { color: "red", placement: "home" } }),
      ev("onboarding_start", { ts: t, props: { color: "blue", placement: "settings" } }),
      ev("paywall_view", { ts: t + HOUR }),
    ];
    expect((await send(sdkKey, { installId: uuid(1, "adadadad"), events })).status).toBe(200);
    const f = await call(owner, `/api/v1/apps/${id}/funnels`, {
      body: { name: "Blue", steps: [{ type: "event", name: "onboarding_start", filters: [{ key: "color", value: "blue" }] }, { type: "event", name: "paywall_view" }], window: "1d" },
    });
    const r = await call(owner, `/api/v1/apps/${id}/funnels/${f.json.id}/report?range=7d&breakdown=placement`);
    expect(r.status, r.text).toBe(200);
    expect(r.json.source).toBe("exact");
    expect(r.json.groups.map((g: { value: string }) => g.value)).toEqual(["settings"]);
  });

  it("counts the events page from the daily rollup: test builds apart, test devices subtracted, retries not counted", async () => {
    const owner = await ownerClient();
    const { id, sdkKey } = await newApp(owner, "com.example.keyevents.rollup");
    await dbExec("UPDATE apps SET key_events_since = ? WHERE id = ?", [daysAgo(30), id]);
    const prod = uuid(1, "aeaeaeae");
    const device = uuid(2, "aeaeaeae");
    const sandbox = uuid(3, "aeaeaeae");
    const prodBatch = { installId: prod, events: [ev("paywall_view"), ev("paywall_view"), ev("paywall_view")] };
    expect((await send(sdkKey, prodBatch)).status).toBe(200);
    expect((await send(sdkKey, { installId: device, events: [ev("paywall_view"), ev("paywall_view")] })).status).toBe(200);
    expect((await send(sdkKey, { installId: sandbox, environment: "sandbox", events: Array.from({ length: 4 }, () => ev("paywall_view")) })).status).toBe(200);
    // An SDK retry adds nothing to the rollup.
    expect((await send(sdkKey, prodBatch)).status).toBe(200);
    expect(await rows("SELECT day, count, test_count FROM app_event_counts WHERE app_id = ? AND name = 'paywall_view'", id)).toEqual([{ day: today(), count: 5, test_count: 4 }]);
    expect((await call(owner, `/api/v1/apps/${id}/test-devices`, { method: "PUT", body: { installIds: [device] } })).status).toBe(200);

    interceptSql(6, () => []);
    const def = await call(owner, `/api/v1/apps/${id}/events/summary?range=7d`);
    expect(def.status, def.text).toBe(200);
    expect(def.json.events).toEqual([expect.objectContaining({ name: "paywall_view", count: 3, installs: 1, source: "exact" })]);
    expect(def.json.daily.at(-1).count).toBe(3);
    const all = await call(owner, `/api/v1/apps/${id}/events/summary?range=7d&includeTest=true`);
    expect(all.json.events).toEqual([expect.objectContaining({ name: "paywall_view", count: 9, installs: 3, source: "exact" })]);
    expect(all.json.notes).toEqual([]);
  });

  it("counts every install from stored key events, falls back to sampled data with a note", async () => {
    const owner = await ownerClient();
    const { id, sdkKey } = await newApp(owner, "com.example.keyevents.funnel");
    // Key events stored for a month (as if the app had been sending them).
    await dbExec("UPDATE apps SET key_events_since = ? WHERE id = ?", [daysAgo(30), id]);
    const now = Date.now();
    const installs = Array.from({ length: 6 }, (_, i) => uuid(i, "dddddddd"));
    for (const [i, install] of installs.entries()) {
      const events = [ev("onboarding_start", { ts: now - 3 * HOUR, props: { step: "1", color: i < 4 ? "blue" : "red", placement: i % 2 ? "home" : "settings" } })];
      if (i < 4) events.push(ev("paywall_view", { ts: now - 2 * HOUR }));
      if (i < 2) events.push(ev("paywall_view", { ts: now - HOUR }));
      expect((await send(sdkKey, { installId: install, events })).status).toBe(200);
    }
    // A sandbox install and app_open (not a key event).
    expect((await send(sdkKey, { installId: uuid(9, "dddddddd"), environment: "sandbox", events: [ev("onboarding_start", { ts: now - 3 * HOUR, props: { step: "1" } })] })).status).toBe(200);

    const f = await call(owner, `/api/v1/apps/${id}/funnels`, {
      body: { name: "Onboarding to paywall", steps: [{ type: "event", name: "onboarding_start", filters: [{ key: "step", value: "1" }, { key: "color", value: "blue" }] }, { type: "event", name: "paywall_view" }], window: "1d" },
    });
    expect(f.status).toBe(201);
    const report = (q: string) => call(owner, `/api/v1/apps/${id}/funnels/${f.json.id}/report?${q}`);

    // No Analytics Engine query (net connect is disabled): every event step is exact.
    const exact = await report("range=7d");
    expect(exact.status, exact.text).toBe(200);
    expect(exact.json).toMatchObject({ source: "exact", approximate: false, notes: [] });
    expect(exact.json.steps.map((s: { users: number }) => s.users)).toEqual([4, 4]);
    // Test data included: the sandbox install has no color, so the filter still leaves it out.
    expect((await report("range=7d&includeTest=true")).json.steps.map((s: { users: number }) => s.users)).toEqual([4, 4]);

    // Breakdown from the first step's column.
    const byPlacement = await report("range=7d&breakdown=placement");
    expect(byPlacement.json.source).toBe("exact");
    expect(byPlacement.json.groups.map((g: { value: string; steps: { users: number }[] }) => [g.value, g.steps.map((s) => s.users)]).sort()).toEqual([
      ["home", [2, 2]],
      ["settings", [2, 2]],
    ]);

    // A breakdown only Analytics Engine has: sampled data (its mock drops installs), with a note.
    interceptSql(2, (sql) =>
      sql.includes("blob1 = 'onboarding_start'")
        ? [{ install: installs[0], first: now - 3 * HOUR, last: now - 3 * HOUR, n: 1, si: 2, b: "18.1" }]
        : [{ install: installs[0], first: now - 2 * HOUR, last: now - HOUR, n: 2, si: 2 }],
    );
    const byOs = await report("range=7d&breakdown=os_version");
    expect(byOs.status).toBe(200);
    expect(byOs.json.source).toBe("sampled");
    expect(byOs.json.steps.map((s: { users: number }) => s.users)).toEqual([1, 1]);
    expect(byOs.json.notes.join(" ")).toContain("os_version breakdown");

    // A range starting before the key events: Analytics Engine for the whole report, and a note.
    await dbExec("UPDATE apps SET key_events_since = ? WHERE id = ?", [daysAgo(2), id]);
    resetFunnelCache();
    resetWaeCache();
    const sqls = interceptSql(2, () => [{ install: installs[0], first: now - 3 * HOUR, last: now - 3 * HOUR, n: 1, si: 1 }]);
    // (6 days: Analytics Engine answers are cached by SQL text, in the Cache API too.)
    const early = await report("range=6d");
    expect(early.json.source).toBe("sampled");
    expect(early.json.notes).toContain(`Exact data starts ${daysAgo(2)}; earlier days are sampled, so this range uses sampled data.`);
    expect(sqls).toHaveLength(2);
    // Starting on that day: exact again.
    expect((await report(`from=${daysAgo(2)}`)).json).toMatchObject({ source: "exact", steps: [{ users: 4 }, { users: 4 }] });

    // Events page: key events exact, the others from Analytics Engine.
    interceptSql(3, (sql) => {
      if (sql.includes("GROUP BY name ORDER BY events DESC"))
        return [
          { name: "app_open", events: "120", installs: "40", si: 2, last: now },
          { name: "paywall_view", events: "2", installs: "1", si: 2, last: now },
        ];
      if (sql.includes("GROUP BY day, name"))
        return [
          { day: `${today()} 00:00:00`, name: "app_open", events: "120" },
          { day: `${today()} 00:00:00`, name: "paywall_view", events: "2" },
        ];
      return [{ events: "128", installs: "40", si: 2 }];
    });
    await dbExec("UPDATE apps SET key_events_since = ? WHERE id = ?", [daysAgo(30), id]);
    const summary = await call(owner, `/api/v1/apps/${id}/events/summary?range=7d`);
    expect(summary.status, summary.text).toBe(200);
    const byName = Object.fromEntries(summary.json.events.map((e: { name: string }) => [e.name, e]));
    expect(byName.app_open).toMatchObject({ count: 120, installs: 40, source: "sampled" });
    expect(byName.paywall_view).toMatchObject({ count: 6, installs: 4, source: "exact" });
    expect(byName.onboarding_start).toMatchObject({ count: 6, installs: 6, source: "exact" });
    // 128 sampled - 2 sampled paywall views + 12 exact key events.
    expect(summary.json.totalEvents).toBe(138);
    expect(summary.json.daily.at(-1).byEvent.paywall_view).toBe(6);
    expect(summary.json.approximate).toBe(true);
  });
});

// Read cost of the exact paths (Free plan: 5M rows read a day; see also test/workers/budget.test.ts). Logged and bounded
// by the rows of the events they need.
describe("exact key-event read cost", { timeout: 120_000 }, () => {
  const stats = () => env.DATABASE.get(env.DATABASE.idFromName("main")).stats();
  const H = HOUR;
  it("keeps exact key-event reads (funnel, events page, experiment exposures, insights) bounded by the rows they need", async () => {
    eventsTestHooks.binding = { writeDataPoint: () => undefined };
    resetEventsState();
    try {
      const owner = await ownerClient();
      const app = await call(owner, "/api/v1/apps", { body: { name: "Exact reads budget", bundleId: "com.example.keyevents.reads" } });
      const appId = app.json.id as string;
      const sdkKey = app.json.sdkKey as string;
      await dbExec("UPDATE apps SET key_events_since = ? WHERE id = ?", [dayOf(Date.now() - 30 * DAY), appId]);
      // 100 installs: onboarding_start, paywall_view (half of them) and an experiment exposure each.
      const I = 100;
      const t = Date.now() - 3 * H;
      for (let i = 0; i < I; i++) {
        const installId = `f3333333-3333-4333-8333-${String(i).padStart(12, "0")}`;
        const names = ["onboarding_start", "experiment_exposure", ...(i % 2 ? [] : ["paywall_view"])];
        const res = await call(null, "/sdk/v1/events", {
          headers: { "x-revflare-key": sdkKey },
          body: { installId, events: names.map((name, k) => ({ id: `${installId.slice(0, 9)}${String(i).padStart(4, "0")}-${k}-4000-8000-000000000000`, name, ts: t + k * 60_000, props: name === "experiment_exposure" ? { variant: "exp_1:a" } : {} })) },
        });
        expect(res.status).toBe(200);
      }
      const rowsStored = 2.5 * I;
      const measure = async (label: string, work: () => Promise<unknown>) => {
        const before = await stats();
        await work();
        const after = await stats();
        const reads = after.rowsRead - before.rowsRead;
        console.log(`${label}: ${reads} rows read, ${after.rowsWritten - before.rowsWritten} written (${rowsStored} key events stored)`);
        return reads;
      };

      // Funnel report: the steps' rows through (app_id, name, ts), plus the app row and ≤ 1 row per day.
      const f = await call(owner, `/api/v1/apps/${appId}/funnels`, { body: { name: "Reads", steps: [{ type: "event", name: "onboarding_start" }, { type: "event", name: "paywall_view" }], window: "1d" } });
      expect(f.status).toBe(201);
      const funnelReads = await measure("exact funnel report", async () => {
        const r = await call(owner, `/api/v1/apps/${appId}/funnels/${f.json.id}/report?range=7d`);
        expect(r.json.source).toBe("exact");
        expect(r.json.steps.map((x: { users: number }) => x.users)).toEqual([I, I / 2]);
      });
      // About 3 rows read per step row (the index entry, the GROUP BY and ORDER BY sorters), whatever the app's other events.
      expect(funnelReads).toBeLessThan(3 * (I + I / 2) + 100);

      // Insights (funnel alerts, 15 days): the same reads, called in the database object.
      const insightReads = await measure("exact insights steps", async () => {
        const r = await exactFunnelSteps(getDb(env), {
          appId,
          steps: [
            { name: "onboarding_start", fromMs: Date.now() - 15 * DAY, toMs: Date.now() + H },
            { name: "paywall_view", fromMs: Date.now() - 15 * DAY, toMs: Date.now() + H },
          ],
          fromDay: dayOf(Date.now() - 15 * DAY),
          toDay: dayOf(Date.now()),
          limit: 10_000,
        });
        expect(r.exact).toBe(true);
      });
      expect(insightReads).toBeLessThan(3 * (I + I / 2) + 50);

      // Experiment exposures: the window's exposure rows.
      const exposureReads = await measure("exact experiment exposures", async () => {
        const r = await exactExposures(getDb(env), { appId, experimentId: "exp_1", variants: ["a", "b"], fromMs: Date.now() - DAY, toMs: Date.now(), graceMs: H, excludedInstalls: [], cap: 10_000 });
        expect(r?.lists.a).toHaveLength(I);
      });
      expect(exposureReads).toBeLessThan(3 * I + 50);

      // Events page: the rollup (names × days) and one COUNT(DISTINCT install_id) over the names' rows.
      fetchMock
        .get("https://api.cloudflare.com")
        .intercept({ path: `/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, method: "POST" })
        .reply(200, JSON.stringify({ data: [] }))
        .times(3);
      const summaryReads = await measure("exact events page", async () => {
        const r = await call(owner, `/api/v1/apps/${appId}/events/summary?range=7d`);
        expect(r.json.events.find((e: { name: string }) => e.name === "onboarding_start")).toMatchObject({ count: I, installs: I, source: "exact" });
      });
      // The page's own reads (session, app) included; the names' rows once (no per-day scan any more).
      expect(summaryReads).toBeLessThan(2 * rowsStored + 100);
      fetchMock.assertNoPendingInterceptors();
    } finally {
      eventsTestHooks.binding = null;
    }
  }, 120_000);
});
