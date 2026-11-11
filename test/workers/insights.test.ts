import { env, fetchMock } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkAlerts, sendSummaries } from "../../worker/lib/alerts";
import { getDb } from "../../worker/lib/db";
import { emailTestHooks } from "../../worker/lib/email";
import { eventsTestHooks } from "../../worker/lib/events";
import { cronInsights } from "../../worker/lib/insights";
import { dayLabel } from "../../worker/lib/digest";
import { pushRecipients, pushTestHooks, type PushMessage } from "../../worker/lib/push";
import { resetWaeCache, waeStats } from "../../worker/lib/wae";
import { DAY, call, ownerClient, type Client } from "./helpers";

// Funnel / event alerts and the daily digest (worker/lib/insights.ts). Analytics Engine SQL is answered by fetchMock
// (exact request counts per phase), pushes are recorded through pushTestHooks, emails through emailTestHooks.

const CF = "https://api.cloudflare.com";
const SQL_PATH = `/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`;
const HOUR = 3_600_000;
const MIN = 60_000;
const db = () => getDb(env);
const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
const AT = today + 9 * HOUR + 5 * MIN;
/** Funnel checks run from 10:00 UTC. */
const CHECK_AT = today + 10 * HOUR + 5 * MIN;
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const YESTERDAY = dayOf(today - DAY);

const pushes: { deviceId: string; msg: PushMessage }[] = [];
const sqls: string[] = [];

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  eventsTestHooks.binding = { writeDataPoint: () => undefined };
  pushTestHooks.sink = pushes;
});
afterEach(() => fetchMock.assertNoPendingInterceptors());
afterAll(() => {
  eventsTestHooks.binding = null;
  pushTestHooks.sink = null;
  emailTestHooks.binding = null;
  emailTestHooks.from = null;
});

/** Answers exactly `times` SQL API requests with `answer(sql)`. */
function interceptSql(times: number, answer: (sql: string) => Record<string, unknown>[]) {
  if (!times) return;
  fetchMock
    .get(CF)
    .intercept({ path: SQL_PATH, method: "POST" })
    .reply((opts) => {
      const sql = String(opts.body);
      sqls.push(sql);
      return { statusCode: 200, data: JSON.stringify({ meta: [], data: answer(sql), rows: 0 }) };
    })
    .times(times);
}

let seq = 0;
/** A device of the current app build (pushVersion 1) unless `prefs` says otherwise. */
async function device(owner: Client, prefs: Record<string, unknown>) {
  const token = (++seq).toString(16).padStart(8, "0") + "ab".repeat(28);
  const r = await call(owner, "/api/v1/devices", { body: { apnsToken: token, name: `Test ${seq}`, prefs: { timezone: "UTC", pushVersion: 1, ...prefs } } });
  expect(r.status, r.text).toBe(200);
  return r.json.id as string;
}

const setSetting = (key: string, value: string) =>
  db().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
const alertRows = (key: string) => db().prepare("SELECT * FROM alerts WHERE key = ?").bind(key).all<Record<string, unknown>>().then((r) => r.results);

// --- Synthetic funnel data: paywall_view → purchase_done ----------------------------------------------------------------

interface Entry {
  install: string;
  first: number;
  version: string;
  converts: boolean;
}

/** `rate`: the purchase rate of 2.0.5 (and of yesterday's installs). */
function entries(rate = 0.3): Entry[] {
  const out: Entry[] = [];
  let i = 0;
  const add = (dayStart: number, hour: number, n: number, version: string, rate: number) => {
    for (let j = 0; j < n; j++) out.push({ install: `i-${++i}`, first: dayStart + hour * HOUR + j * MIN, version, converts: j < Math.round(n * rate) });
  };
  // 14 days before yesterday: 100 installs a day on 2.0.2 (50 % buy); 2.0.5 appears 4 days ago (30 % buy).
  for (let d = 15; d >= 2; d--) {
    add(today - d * DAY, 9, 100, "2.0.2", 0.5);
    if (d <= 4) add(today - d * DAY, 12, 100, "2.0.5", rate);
  }
  // Yesterday from 11:00: 200 installs on 2.0.5, 30 % buy (after the regression's entry window, which ends 24 hours
  // before CHECK_AT).
  add(today - DAY, 11, 200, "2.0.5", rate);
  return out;
}

function funnelAnswer(appId: string, data: Entry[]) {
  return (sql: string) => {
    if (!sql.includes(`index1 = '${appId}'`)) return [];
    if (sql.includes("blob1 = 'paywall_view'")) {
      expect(sql).toContain("argMin(blob4, double1) AS b");
      return data.map((e) => ({ install: e.install, first: e.first, last: e.first, n: 1, si: 1, b: e.version }));
    }
    if (sql.includes("blob1 = 'purchase_done'"))
      return data.filter((e) => e.converts).map((e) => ({ install: e.install, first: e.first + 10 * MIN, last: e.first + 10 * MIN, n: "1", si: 1 }));
    return [];
  };
}

describe("funnel and event alerts, daily digest", { timeout: 120_000 }, () => {
  it("event silence: raised and resolved from the last-event note, no Analytics Engine query", async () => {
    const owner = await ownerClient();
    const ws = await call(owner, "/api/v1/workspaces", { body: { name: "Silence WS" } });
    const client = { ...owner, ws: ws.json.id as string };
    const app = await call(client, "/api/v1/apps", { body: { name: "Quiet App", bundleId: "com.example.quiet" } });
    const appId = app.json.id as string;
    const quiet = { dailySummary: false, weeklySummary: false };
    const on = await device(owner, quiet);
    const off = await device(owner, { ...quiet, funnelAlerts: false });
    const muted = await device(owner, { ...quiet, appOverrides: { [appId]: { funnelAlerts: false } } });
    const ours = (p: { deviceId: string }) => [on, off, muted].includes(p.deviceId);

    const t = Date.now();
    const last = t - 20 * HOUR;
    await setSetting(`events_last:${appId}`, String(last));
    const days = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [dayOf(t - (i + 1) * DAY), 24]));
    await setSetting(`events_seen:${appId}`, JSON.stringify({ last: last - HOUR, days }));
    const requests = waeStats.requests;
    pushes.length = 0;

    await checkAlerts(env, {});
    const key = `events_silent:${appId}:${dayOf(last)}`;
    const [row] = await alertRows(key);
    expect(row).toMatchObject({ kind: "events_silent", severity: "warning", app_id: appId, title: "No app events from Quiet App", resolved_at: null });
    expect(String(row.body)).toContain("No RevflareKit events arrived for 20 hours");
    const mine = pushes.filter((p) => p.msg.appId === appId && ours(p));
    expect(mine.map((p) => p.deviceId)).toEqual([on]);
    expect(mine[0].msg).toMatchObject({ kind: "funnel", titleKey: "PUSH_TITLE_ALERT_EVENTS_SILENT", titleArgs: ["Quiet App"], bodyKey: "PUSH_BODY_ALERT_EVENTS_SILENT", bodyArgs: ["20"] });
    expect(mine.some((p) => p.deviceId === off || p.deviceId === muted)).toBe(false);
    // The hourly state moved on (one more active hour today... the note is from yesterday or today).
    const state = JSON.parse((await db().prepare("SELECT value FROM settings WHERE key = ?").bind(`events_seen:${appId}`).first<{ value: string }>())!.value);
    expect(state.last).toBe(last);

    // Again: deduped. Then events return: resolved.
    await checkAlerts(env, {});
    expect(await alertRows(key)).toHaveLength(1);
    expect(pushes.filter((p) => p.msg.appId === appId && ours(p))).toHaveLength(1);
    await setSetting(`events_last:${appId}`, String(Date.now()));
    await checkAlerts(env, {});
    expect((await alertRows(key))[0].resolved_at).toBeTypeOf("number");
    expect(waeStats.requests).toBe(requests);

    const list = await call(client, "/api/v1/alerts");
    expect(list.json.items.find((a: { kind: string }) => a.kind === "events_silent")).toMatchObject({ appId, funnelId: null });

    // Events return to an app that lost its baseline meanwhile (fewer than 4 active days): resolved all the same.
    const app2 = await call(client, "/api/v1/apps", { body: { name: "Sparse App", bundleId: "com.example.sparse" } });
    const app2Id = app2.json.id as string;
    const t2 = Date.now();
    const key2 = `events_silent:${app2Id}:${dayOf(t2 - 2 * DAY)}`;
    await db()
      .prepare("INSERT INTO alerts (id, workspace_id, app_id, key, kind, severity, title, body, created_at) VALUES (?, ?, ?, ?, 'events_silent', 'warning', 't', 'b', ?)")
      .bind(`alr_test_${app2Id}`, client.ws, app2Id, key2, t2 - DAY)
      .run();
    await setSetting(`events_seen:${app2Id}`, JSON.stringify({ last: t2 - 2 * DAY, days: { [dayOf(t2 - 2 * DAY)]: 3 } }));
    await setSetting(`events_last:${app2Id}`, String(t2 - 10 * MIN));
    await checkAlerts(env, {});
    expect((await alertRows(key2))[0].resolved_at).toBeTypeOf("number");
  });

  it("funnel anomaly and release regression from mocked Analytics Engine data, capped per tick, pushes gated", async () => {
    const owner = await ownerClient();
    const ws = await call(owner, "/api/v1/workspaces", { body: { name: "Insights WS" } });
    const wsId = ws.json.id as string;
    const client = { ...owner, ws: wsId };
    const app = await call(client, "/api/v1/apps", { body: { name: "Party Games", bundleId: "com.example.partygames" } });
    const appId = app.json.id as string;
    const base = `/api/v1/apps/${appId}/funnels`;

    // Settings: validated, no free-form thresholds.
    expect((await call(client, base, { body: { name: "x", steps: [{ name: "a" }, { name: "b" }], alerts: { threshold: 0.1 } } })).status).toBe(400);
    const f1 = await call(client, base, { body: { name: "Paywall to purchase", steps: [{ name: "paywall_view" }, { name: "purchase_done" }] } });
    expect(f1.json.alerts).toEqual({ enabled: true, sensitivity: "normal" });
    const fid = f1.json.id as string;
    const f2 = await call(client, base, { body: { name: "Onboarding", steps: [{ name: "onboarding_a" }, { name: "onboarding_b" }], alerts: { sensitivity: "high" } } });
    expect(f2.json.alerts).toEqual({ enabled: true, sensitivity: "high" });
    const f3 = await call(client, base, { body: { name: "Other", steps: [{ name: "x_start" }, { name: "x_end" }] } });
    const f4 = await call(client, base, { body: { name: "Off", steps: [{ name: "y_start" }, { name: "y_end" }], alerts: { enabled: false } } });
    const patched = await call(client, `${base}/${f3.json.id}`, { method: "PATCH", body: { alerts: { sensitivity: "low" } } });
    expect(patched.json.alerts).toEqual({ enabled: true, sensitivity: "low" });
    expect((await call(client, `${base}/${f3.json.id}`, { method: "PATCH", body: { alerts: { sensitivity: "max" } } })).status).toBe(400);

    const daily = { dailySummary: true, weeklySummary: false };
    const quiet = { dailySummary: false, weeklySummary: false };
    const a = await device(owner, daily);
    const b = await device(owner, { ...daily, funnelAlerts: false });
    const c = await device(owner, { ...quiet, appOverrides: { [appId]: { muted: true } } });
    const d = await device(owner, { ...quiet, appOverrides: { [appId]: { funnelAlerts: false } } });
    const ours = (p: { deviceId: string }) => [a, b, c, d].includes(p.deviceId);

    // Only this test's funnels are due; every other workspace already has its digest for yesterday. These two statements
    // deliberately touch other workspaces' rows (funnels and digests of the other tests sharing this database) so that
    // the per-tick request counts below only see this workspace; they mark work as done, they change no results.
    await db().prepare("UPDATE funnels SET alerts_checked = ? WHERE app_id != ?").bind(dayOf(AT), appId).run();
    await db()
      .prepare(
        `INSERT INTO settings (key, value) SELECT 'digest:' || id || ':' || ?, json_object('workspaceId', id, 'day', ?, 'apps', json('[]'), 'events', json('false')) FROM workspaces WHERE id != ?
         ON CONFLICT(key) DO NOTHING`,
      )
      .bind(YESTERDAY, YESTERDAY, wsId)
      .run();
    await setSetting(`events_last:${appId}`, String(AT - HOUR));
    await db()
      .prepare("INSERT INTO daily_metrics (app_id, day, workspace_id, gross_usd, proceeds_usd, new_subscriptions, trials_started, trial_conversions, mrr_usd) VALUES (?, ?, ?, 120, 84, 4, 46, 3, 900)")
      .bind(appId, YESTERDAY, wsId)
      .run();
    resetWaeCache();
    pushes.length = 0;

    // 1. The digest: one Analytics Engine query for the workspace's apps.
    const data = entries();
    const answer = funnelAnswer(appId, data);
    interceptSql(1, (sql) => {
      expect(sql).toContain(`index1 IN ('${appId}')`);
      return [
        { app: appId, day: `${YESTERDAY} 00:00:00`, name: "first_open", events: "1210" },
        { app: appId, day: `${YESTERDAY} 00:00:00`, name: "paywall_view", events: 300 },
        ...Array.from({ length: 7 }, (_, i) => ({ app: appId, day: `${dayOf(today - (i + 2) * DAY)} 00:00:00`, name: "first_open", events: 1000 })),
      ];
    });
    const first = await cronInsights(env, { at: AT, maxFunnels: 0 });
    expect(first).toMatchObject({ digests: { computed: 1, events: 1, pending: 0 }, requests: 1 });
    const digest = JSON.parse((await db().prepare("SELECT value FROM settings WHERE key = ?").bind(`digest:${wsId}:${YESTERDAY}`).first<{ value: string }>())!.value);
    expect(digest).toMatchObject({ day: YESTERDAY, events: true, totals: { revenueUsd: 120, proceedsUsd: 84, trialsStarted: 46, installs: 1210, avgInstalls: 1000, paywallViews: 300 } });

    // 2. Funnel checks (from 10:00 UTC; none before), with a request budget of 3 plus room for the pushes a funnel can
    // raise (2 per receiving device): one 2-step funnel per tick, round-robin.
    expect((await cronInsights(env, { at: AT })).funnels).toBeUndefined();
    const recipients = (await pushRecipients(db(), wsId, { kind: "funnel", appId, titleKey: "", bodyKey: "" })).length;
    expect(recipients).toBeGreaterThanOrEqual(1);
    const maxRequests = 3 + 2 * recipients;
    const checked = async () =>
      (await db().prepare("SELECT id FROM funnels WHERE app_id = ? AND alerts_checked = ? ORDER BY id").bind(appId, dayOf(AT)).all<{ id: string }>()).results.map((r) => r.id);
    expect(await checked()).toEqual([]);
    const seen: string[] = [];
    for (let tick = 0; tick < 3; tick++) {
      const before = sqls.length;
      interceptSql(2, answer);
      const r = await cronInsights(env, { at: CHECK_AT, maxRequests });
      expect(r.requests).toBe(2);
      expect(r.emails).toBeUndefined();
      expect(sqls.length - before).toBe(2);
      expect(r.funnels).toMatchObject({ checked: 1, more: tick < 2 });
      const now = await checked();
      seen.push(now.find((id) => !seen.includes(id) && id !== f4.json.id)!);
      // f4 (alerts off) is marked without a query.
      expect(now).toContain(f4.json.id);
    }
    expect(new Set(seen)).toEqual(new Set([fid, f2.json.id, f3.json.id]));
    expect(await cronInsights(env, { at: CHECK_AT })).toMatchObject({ funnels: { checked: 0 }, requests: 0 });
    expect(await cronInsights(env, { at: CHECK_AT })).toMatchObject({ funnels: { done: true }, requests: 0 });

    // Exactly one anomaly and one regression, for the paywall funnel.
    const anomalyKey = `funnel_anomaly:${fid}:${YESTERDAY}`;
    const [anomaly] = await alertRows(anomalyKey);
    expect(anomaly).toMatchObject({ kind: "funnel_anomaly", severity: "warning", app_id: appId, workspace_id: wsId, title: "paywall_view → purchase_done dropped 35% in Party Games" });
    expect(String(anomaly.body)).toContain(
      `on ${YESTERDAY}, 60 of 200 installs (30.0%) went from paywall_view to purchase_done, against 46.5% (790 of 1700) over the 14 days before and 50.0% (100 of 200) on the same weekday`,
    );
    const regressionKey = `release_regression:${fid}:2.0.5`;
    const [regression] = await alertRows(regressionKey);
    expect(regression).toMatchObject({ kind: "release_regression", severity: "warning", title: "paywall_view → purchase_done dropped 40% in Party Games (2.0.5 vs 2.0.2)" });
    expect(String(regression.body)).toContain("90 of 300 installs on 2.0.5 (30.0%) went from paywall_view to purchase_done, against 50.0% (100 of 200) on 2.0.2");
    const others = await db().prepare("SELECT COUNT(*) AS n FROM alerts WHERE workspace_id = ? AND kind IN ('funnel_anomaly', 'release_regression')").bind(wsId).first<{ n: number }>();
    expect(others!.n).toBe(2);

    // Pushes: kind "funnel"; not to a device with funnel alerts off, a muted app or the kind off for the app.
    const mine = pushes.filter((p) => p.msg.appId === appId && ours(p));
    expect(mine.map((p) => p.deviceId)).toEqual([a, a]);
    expect(mine.map((p) => p.msg.kind)).toEqual(["funnel", "funnel"]);
    expect(mine.find((p) => p.msg.titleKey === "PUSH_TITLE_ALERT_FUNNEL")!.msg).toMatchObject({
      titleArgs: ["Party Games"],
      bodyKey: "PUSH_BODY_ALERT_FUNNEL",
      bodyArgs: ["paywall_view", "purchase_done", "35%", "30.0%", "46.5%"],
      data: { funnelId: fid },
    });
    expect(mine.find((p) => p.msg.titleKey === "PUSH_TITLE_ALERT_RELEASE")!.msg).toMatchObject({
      titleArgs: ["Party Games", "2.0.5"],
      bodyArgs: ["paywall_view", "purchase_done", "40%", "2.0.5", "2.0.2"],
    });
    expect(mine.some((p) => [b, c, d].includes(p.deviceId))).toBe(false);

    // The alerts list links to the funnel.
    const list = await call(client, "/api/v1/alerts");
    expect(list.json.items.filter((x: { funnelId?: string }) => x.funnelId === fid).map((x: { kind: string }) => x.kind).sort()).toEqual(["funnel_anomaly", "release_regression"]);

    // Checked again (next run of the same day): deduplicated by key, no second push.
    await db().prepare("UPDATE funnels SET alerts_checked = NULL WHERE id = ?").bind(fid).run();
    await db().prepare("DELETE FROM settings WHERE key = ?").bind(`funnel_alerts_done:${dayOf(AT)}`).run();
    resetWaeCache();
    interceptSql(2, answer);
    expect(await cronInsights(env, { at: CHECK_AT })).toMatchObject({ funnels: { checked: 1, anomalies: 1, regressions: 1 }, requests: 2 });
    expect(await alertRows(anomalyKey)).toHaveLength(1);
    expect(await alertRows(regressionKey)).toHaveLength(1);
    expect(pushes.filter((p) => p.msg.appId === appId && ours(p))).toHaveLength(2);

    // A later check that finds no regression (2.0.5 fixed: 50 % again) resolves the open regression and anomaly.
    await db().prepare("UPDATE funnels SET alerts_checked = NULL WHERE id = ?").bind(fid).run();
    await db().prepare("DELETE FROM settings WHERE key = ?").bind(`funnel_alerts_done:${dayOf(AT)}`).run();
    resetWaeCache();
    interceptSql(2, funnelAnswer(appId, entries(0.5)));
    expect(await cronInsights(env, { at: CHECK_AT })).toMatchObject({ funnels: { checked: 1, anomalies: 0, regressions: 0 }, requests: 2 });
    expect((await alertRows(regressionKey))[0].resolved_at).toBeTypeOf("number");
    expect((await alertRows(anomalyKey))[0].resolved_at).toBeTypeOf("number");

    // Without the EVENTS binding: no funnel checks, no queries.
    await db().prepare("UPDATE funnels SET alerts_checked = NULL WHERE id = ?").bind(fid).run();
    await db().prepare("DELETE FROM settings WHERE key = ?").bind(`funnel_alerts_done:${dayOf(AT)}`).run();
    eventsTestHooks.binding = null;
    const skipped = await cronInsights(env, { at: CHECK_AT });
    eventsTestHooks.binding = { writeDataPoint: () => undefined };
    expect(skipped.funnels).toBeUndefined();
    expect(skipped.requests).toBe(0);

    // 3. Summary pushes at 09:05 local: the digest is read (computed once for the workspace) by every device; a build
    // without the digest loc-keys (pushVersion 0) gets the plain summary.
    const e = await device(owner, daily);
    const old = await device(owner, { ...daily, pushVersion: 0 });
    const before = sqls.length;
    pushes.length = 0;
    await sendSummaries(env, { at: AT });
    expect(sqls.length).toBe(before);
    const summaries = pushes.filter((p) => p.msg.kind === "summary" && p.msg.titleArgs?.[0] === "Insights WS" && [a, b, c, d, e, old].includes(p.deviceId));
    expect(summaries.map((p) => p.deviceId).sort()).toEqual([a, b, e, old].sort());
    for (const s of summaries) {
      if (s.deviceId === old) {
        expect(s.msg).toMatchObject({ bodyKey: "PUSH_BODY_SUMMARY", bodyArgs: ["$120.00", "4", "$900.00"] });
        continue;
      }
      expect(s.msg.bodyKey).toBe("PUSH_BODY_SUMMARY_DIGEST");
      expect(s.msg.bodyArgs).toEqual(["$120.00", "4", "$900.00", "1.2K", " (+21%)", "46", ""]);
    }
    const digests = await db().prepare("SELECT COUNT(*) AS n FROM settings WHERE key = ?").bind(`digest:${wsId}:${YESTERDAY}`).first<{ n: number }>();
    expect(digests!.n).toBe(1);

    // 4. Digest email: only for users who opted in, only when email is configured, once a day.
    expect((await call(owner, "/api/v1/me", { method: "PATCH", body: { dailyDigestEmail: "yes" } })).status).toBe(400);
    expect((await call(owner, "/api/v1/me", { method: "PATCH", body: { dailyDigestEmail: true } })).status).toBe(200);
    const me = await call(owner, "/api/v1/me");
    expect(me.json.user.dailyDigestEmail).toBe(true);
    expect(me.json.features.email).toBe(false);
    expect((await cronInsights(env, { at: AT })).emails).toBeUndefined();
    const sent: { to: string; subject: string; text: string; html: string }[] = [];
    emailTestHooks.binding = { send: async (m: unknown) => void sent.push(m as (typeof sent)[number]) } as unknown as SendEmail;
    emailTestHooks.from = "Revflare <revflare@rf.test>";
    expect((await cronInsights(env, { at: AT })).emails).toMatchObject({ sent: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: owner.email, subject: `Revflare daily digest · ${YESTERDAY}` });
    expect(sent[0].text).toContain("Insights WS");
    expect(sent[0].text).toContain("Party Games: $120.00 revenue, $84.00 proceeds, 4 new subs, 46 trials, 1210 installs, 300 paywall views");
    expect(sent[0].html).toContain("Party Games");
    // Everyone had theirs: the day is marked done (no more reads of the per-user marks).
    expect((await cronInsights(env, { at: AT })).emails).toMatchObject({ done: true });
    expect(sent).toHaveLength(1);
    await call(owner, "/api/v1/me", { method: "PATCH", body: { dailyDigestEmail: false } });
  });

  it("a device at UTC+9 gets a digest line at its 09:00 (00:00 UTC), from the latest digest with events, labelled", async () => {
    const owner = await ownerClient();
    const ws = await call(owner, "/api/v1/workspaces", { body: { name: "Tokyo WS" } });
    const wsId = ws.json.id as string;
    const client = { ...owner, ws: wsId };
    const app = await call(client, "/api/v1/apps", { body: { name: "Sakura", bundleId: "com.example.sakura" } });
    const appId = app.json.id as string;
    await db()
      .prepare("INSERT INTO daily_metrics (app_id, day, workspace_id, gross_usd, proceeds_usd, new_subscriptions, trials_started, trial_conversions, mrr_usd) VALUES (?, ?, ?, 50, 35, 2, 7, 1, 400)")
      .bind(appId, YESTERDAY, wsId)
      .run();
    // The day before yesterday has a full digest (with event metrics); yesterday's has not been computed yet.
    const d2 = dayOf(today - 2 * DAY);
    await setSetting(
      `digest:${wsId}:${d2}`,
      JSON.stringify({ workspaceId: wsId, day: d2, apps: [], totals: { revenueUsd: 40, trialsStarted: 9, installs: 1500, avgInstalls: 1000, paywallViews: 200 }, movers: [], events: true, computedAt: 0 }),
    );
    const daily = { dailySummary: true, weeklySummary: false, timezone: "Asia/Tokyo" };
    const tokyo = await device(owner, daily);
    const tokyoOld = await device(owner, { ...daily, pushVersion: 0 });
    pushes.length = 0;
    const requests = waeStats.requests;
    await sendSummaries(env, { at: today + 5 * MIN });
    expect(waeStats.requests).toBe(requests);
    const mine = pushes.filter((p) => p.msg.kind === "summary" && p.msg.titleArgs?.[0] === "Tokyo WS");
    expect(mine.map((p) => p.deviceId).sort()).toEqual([tokyo, tokyoOld].sort());
    expect(mine.find((p) => p.deviceId === tokyo)!.msg).toMatchObject({
      bodyKey: "PUSH_BODY_SUMMARY_DIGEST",
      bodyArgs: ["$50.00", "2", "$400.00", "1.5K", " (+50%)", "9", dayLabel(d2)],
    });
    expect(mine.find((p) => p.deviceId === tokyoOld)!.msg).toMatchObject({ bodyKey: "PUSH_BODY_SUMMARY", bodyArgs: ["$50.00", "2", "$400.00"] });
    // Yesterday's ledger part was stored on the way (the insights cron adds event metrics later when there are any).
    const stored = JSON.parse((await db().prepare("SELECT value FROM settings WHERE key = ?").bind(`digest:${wsId}:${YESTERDAY}`).first<{ value: string }>())!.value);
    expect(stored).toMatchObject({ day: YESTERDAY, events: false, totals: { revenueUsd: 50, trialsStarted: 7 } });
  });
});
