import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import goalsMigration from "../../migrations/0025_goals.sql?raw";
import { getDb } from "../../worker/lib/db";
import { checkGoalPushes, periodBounds, previousBounds } from "../../worker/lib/goals";
import { splitStatements } from "../../worker/lib/migrate";
import { addDays, dayStart } from "../../worker/lib/money";
import { pushTestHooks, type PushMessage } from "../../worker/lib/push";
import { call, ownerClient, sessionCookie, type Client } from "./helpers";

// Goals (worker/lib/goals.ts): scopes, periods, metrics and progress against daily rows written here directly (no
// transactions: nothing queues a rollup for these apps, so the rows stay as written), reached pushes, permissions.

const db = () => getDb(env);
const TODAY = new Date().toISOString().slice(0, 10);
const COLS = [
  "gross_usd", "proceeds_usd", "refunds_usd", "refunds", "new_subscriptions", "renewals", "one_time_purchases", "trials_started", "trial_conversions", "new_customers",
  "new_payers", "active_subscriptions", "active_trials", "mrr_usd", "mrr_proceeds_usd", "mrr_new", "mrr_expansion", "mrr_contraction", "mrr_churn", "mrr_reactivation", "churned_subscriptions",
];

const pushes: { deviceId: string; msg: PushMessage }[] = [];
beforeAll(() => {
  pushTestHooks.sink = pushes;
});
afterAll(() => {
  pushTestHooks.sink = null;
});

/** Writes an app's day (and the workspace total of that day), then marks the workspace's data changed. */
async function setDay(ws: string, appId: string, day: string, cols: Record<string, number>) {
  const keys = Object.keys(cols);
  await db()
    .prepare(
      `INSERT INTO daily_metrics (app_id, day, workspace_id, ${keys.join(", ")}) VALUES (?, ?, ?, ${keys.map(() => "?").join(", ")})
       ON CONFLICT(app_id, day) DO UPDATE SET ${keys.map((k) => `${k} = excluded.${k}`).join(", ")}`,
    )
    .bind(appId, day, ws, ...keys.map((k) => cols[k]))
    .run();
  await db().prepare("DELETE FROM workspace_daily WHERE workspace_id = ? AND day = ?").bind(ws, day).run();
  await db()
    .prepare(`INSERT INTO workspace_daily (workspace_id, day, ${COLS.join(", ")}) SELECT workspace_id, day, ${COLS.map((c) => `SUM(${c})`).join(", ")} FROM daily_metrics WHERE workspace_id = ? AND day = ? GROUP BY workspace_id, day`)
    .bind(ws, day)
    .run();
  await touch(ws);
}

let tick = 0;
async function touch(ws: string) {
  const v = String(Date.now() + ++tick);
  for (const k of [`data_version:${ws}`, `data_past:${ws}`]) await db().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, v).run();
}

let n = 0;
async function workspace(name: string, currency = "USD"): Promise<{ client: Client; ws: string; app: (name: string) => Promise<string> }> {
  const owner = await ownerClient();
  const r = await call(owner, "/api/v1/workspaces", { body: { name, currency } });
  const ws = r.json.id as string;
  const client = { ...owner, ws };
  return {
    client,
    ws,
    app: async (appName: string) => {
      const a = await call(client, "/api/v1/apps", { body: { name: appName, bundleId: `com.example.goals${++n}` } });
      expect(a.status, a.text).toBe(201);
      return a.json.id as string;
    },
  };
}

const create = async (client: Client, body: Record<string, unknown>) => {
  const r = await call(client, "/api/v1/goals", { body });
  expect(r.status, r.text).toBe(201);
  return r.json.goal;
};
const list = async (client: Client) => {
  const r = await call(client, "/api/v1/goals");
  expect(r.status, r.text).toBe(200);
  return new Map<string, any>(r.json.items.map((g: any) => [g.id, g]));
};

describe("goals", () => {
  it("migrates goals of one app to an include scope", async () => {
    const { client, ws, app } = await workspace("Goals migration");
    const a = await app("Legacy");
    const t = Date.now();
    // A goal as older code wrote it: app_id set, the new columns at their defaults.
    await db().prepare("INSERT INTO goals (id, workspace_id, metric, period, target_usd, app_id, created_at, updated_at) VALUES (?, ?, 'revenue', 'month', 100, ?, ?, ?)").bind(`goal_legacy_${ws}`, ws, a, t, t).run();
    await db().prepare("INSERT INTO goals (id, workspace_id, metric, period, target_usd, app_id, created_at, updated_at) VALUES (?, ?, 'mrr', 'month', 50, NULL, ?, ?)").bind(`goal_legacy2_${ws}`, ws, t + 1, t + 1).run();
    await touch(ws);
    // Read as include [app] even before the migration's update ran on it.
    let goals = await list(client);
    expect(goals.get(`goal_legacy_${ws}`)).toMatchObject({ scope: "include", appIds: [a], appId: a, name: null, label: "Revenue · Legacy", period: "month", notify: false, archived: false });
    // The migration's updates.
    for (const s of splitStatements(goalsMigration).filter((s) => /^UPDATE/i.test(s))) await db().prepare(s).run();
    const rows = await db().prepare("SELECT id, scope, app_ids, sort_order FROM goals WHERE workspace_id = ? ORDER BY created_at").bind(ws).all<{ id: string; scope: string; app_ids: string; sort_order: number }>();
    expect(rows.results).toEqual([
      { id: `goal_legacy_${ws}`, scope: "include", app_ids: JSON.stringify([a]), sort_order: 0 },
      { id: `goal_legacy2_${ws}`, scope: "all", app_ids: "[]", sort_order: 1 },
    ]);
    await touch(ws);
    goals = await list(client);
    expect(goals.get(`goal_legacy_${ws}`)).toMatchObject({ scope: "include", appIds: [a] });
    expect(goals.get(`goal_legacy2_${ws}`)).toMatchObject({ scope: "all", appIds: [], label: "MRR · All apps" });
    // Older clients still create one-app goals with appId.
    const g = await create(client, { metric: "revenue", target: 10, appId: a });
    expect(g).toMatchObject({ scope: "include", appIds: [a], appId: a, sortOrder: 2 });
  });

  it("sums the apps of its scope; exclude picks up apps added later; the overview's app filter does not change goals", async () => {
    const { client, ws, app } = await workspace("Goals scopes");
    const [a, b, c] = [await app("Alpha"), await app("Beta"), await app("Gamma")];
    await setDay(ws, a, TODAY, { gross_usd: 100 });
    await setDay(ws, b, TODAY, { gross_usd: 20 });
    await setDay(ws, c, TODAY, { gross_usd: 3 });
    const all = await create(client, { metric: "revenue", target: 1000 });
    const inc = await create(client, { name: "Alpha + Beta", metric: "revenue", target: 1000, scope: "include", appIds: [a, b] });
    const exc = await create(client, { metric: "revenue", target: 1000, scope: "exclude", appIds: [c] });
    const one = await create(client, { metric: "revenue", target: 1000, scope: "include", appIds: [b] });
    expect([all.current, inc.current, exc.current, one.current]).toEqual([123, 120, 120, 20]);
    expect([all.label, inc.label, exc.label, one.label]).toEqual(["Revenue · All apps", "Alpha + Beta", "Revenue · All apps except Gamma", "Revenue · Beta"]);
    expect(inc.appId).toBeNull();
    expect(one.appId).toBe(b);

    // A new app counts for "all" and "all except Gamma", not for the included apps.
    const d = await app("Delta");
    await setDay(ws, d, TODAY, { gross_usd: 7 });
    let goals = await list(client);
    expect([all.id, inc.id, exc.id, one.id].map((id) => goals.get(id).current)).toEqual([130, 120, 127, 20]);

    // The overview filtered to one app still shows every goal on its own apps.
    const ov = await call(client, `/api/v1/overview?apps=${c}`);
    expect(ov.status).toBe(200);
    const og = new Map<string, any>(ov.json.goals.map((g: any) => [g.id, g]));
    expect([all.id, inc.id, exc.id, one.id].map((id) => og.get(id).current)).toEqual([130, 120, 127, 20]);

    // Archived goals leave the overview but stay in GET /goals.
    const r = await call(client, `/api/v1/goals/${one.id}`, { method: "PATCH", body: { archived: true } });
    expect(r.status, r.text).toBe(200);
    expect(r.json.goal.archived).toBe(true);
    expect((await call(client, "/api/v1/overview")).json.goals.map((g: any) => g.id)).toEqual([all.id, inc.id, exc.id]);
    goals = await list(client);
    expect(goals.get(one.id).archived).toBe(true);

    // Reorder: the listed ones first, the rest after in their order.
    const re = await call(client, "/api/v1/goals/reorder", { body: { ids: [exc.id, one.id] } });
    expect(re.status, re.text).toBe(200);
    expect(re.json.ids).toEqual([exc.id, one.id, all.id, inc.id]);
    expect([...(await list(client)).keys()]).toEqual([exc.id, one.id, all.id, inc.id]);

    // An app gone from the workspace drops out of an include list.
    await db().prepare("DELETE FROM apps WHERE id = ?").bind(b).run();
    await touch(ws);
    goals = await list(client);
    expect(goals.get(inc.id)).toMatchObject({ appIds: [a] });
  });

  it("computes each period with its bounds, the previous period, counts and stock metrics", async () => {
    const { client, ws, app } = await workspace("Goals periods");
    const a = await app("Periods");
    // Revenue 10 a day for the last 800 days, plus counts and levels.
    await db()
      .prepare(
        `WITH RECURSIVE d(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM d WHERE i < 799)
         INSERT INTO daily_metrics (app_id, day, workspace_id, gross_usd, new_subscriptions, renewals, one_time_purchases, trials_started, active_subscriptions, mrr_usd)
         SELECT ?, date(?, '-' || i || ' days'), ?, 10, 1, 2, 3, 4, 1000 - i, 5000 - i FROM d`,
      )
      .bind(a, TODAY, ws)
      .run();
    await db()
      .prepare(`INSERT OR REPLACE INTO workspace_daily (workspace_id, day, ${COLS.join(", ")}) SELECT workspace_id, day, ${COLS.map((c) => `SUM(${c})`).join(", ")} FROM daily_metrics WHERE workspace_id = ? GROUP BY day`)
      .bind(ws)
      .run();
    await touch(ws);
    const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
    for (const period of ["week", "month", "quarter", "year"] as const) {
      const g = await create(client, { metric: "revenue", target: 1_000_000, period, scope: "include", appIds: [a] });
      const b = periodBounds(period, TODAY);
      const prev = previousBounds(period, b)!;
      const elapsed = days(b.start, TODAY);
      expect(g, period).toMatchObject({
        period,
        periodStart: b.start,
        periodEnd: b.end,
        periodLabel: b.label,
        status: "active",
        daysTotal: days(b.start, b.end),
        daysElapsed: elapsed,
        daysLeft: days(b.start, b.end) - elapsed,
        current: 10 * elapsed,
        pace: "behind",
        previous: { periodStart: prev.start, periodEnd: prev.end, periodLabel: prev.label, value: 10 * days(prev.start, prev.end), reached: false },
      });
      expect(g.projected).toBeCloseTo(10 * days(b.start, b.end));
      expect(g.requiredPerDay).toBeCloseTo((1_000_000 - 10 * elapsed) / (days(b.start, b.end) - elapsed + 1));
    }
    // Custom: the 10 days around today; ended and upcoming ones.
    const custom = await create(client, { name: "Ten days", metric: "sales", target: 60, period: "custom", startDate: addDays(TODAY, -5), endDate: addDays(TODAY, 4), scope: "all" });
    expect(custom).toMatchObject({ format: "count", kind: "flow", status: "active", daysTotal: 10, daysElapsed: 6, daysLeft: 4, current: 36, expected: 36, projected: 60, pace: "on_track", previous: null, startDate: addDays(TODAY, -5), endDate: addDays(TODAY, 4) });
    expect(custom.requiredPerDay).toBeCloseTo(24 / 5);
    expect(custom.reachedAt).toBeNull();
    const ended = await create(client, { metric: "trials_started", target: 30, period: "custom", startDate: addDays(TODAY, -20), endDate: addDays(TODAY, -11) });
    expect(ended).toMatchObject({ status: "ended", current: 40, pace: "reached", reachedAt: addDays(TODAY, -13), requiredPerDay: null, daysLeft: 0 });
    const missed = await create(client, { metric: "new_subscriptions", target: 30, period: "custom", startDate: addDays(TODAY, -20), endDate: addDays(TODAY, -11) });
    expect(missed).toMatchObject({ status: "ended", current: 10, pace: "missed" });
    const upcoming = await create(client, { metric: "revenue", target: 50, period: "custom", startDate: addDays(TODAY, 3), endDate: addDays(TODAY, 7) });
    expect(upcoming).toMatchObject({ status: "upcoming", current: 0, pace: "upcoming", daysElapsed: 0, daysLeft: 5, requiredPerDay: 10 });
    // Stock metrics: today's level and the level before the period.
    const month = periodBounds("month", TODAY);
    const before = days(addDays(month.start, -1), TODAY) - 1;
    const actives = await create(client, { metric: "active_subscriptions", target: 2000, period: "month" });
    expect(actives).toMatchObject({ kind: "stock", format: "count", current: 1000, startValue: 1000 - before, projected: 1000, pace: "behind" });
    const mrr = await create(client, { metric: "mrr", target: 4000, period: "month" });
    expect(mrr).toMatchObject({ kind: "stock", format: "money", current: 5000, pace: "reached" });
    // reached on the first day of the month (the level was already over the target).
    expect(mrr.reachedAt).toBe(month.start);
  });

  it("pushes a reached goal once per period, only with notify and to builds with pushVersion 4", async () => {
    const { client, ws, app } = await workspace("Goals push");
    const a = await app("Push app");
    await setDay(ws, a, TODAY, { gross_usd: 500 });
    const mk = async (prefs: Record<string, unknown>, i: number) => {
      const r = await call(client, "/api/v1/devices", { body: { apnsToken: `90a1${i}`.padEnd(64, "0"), name: `Goal ${i}`, prefs: { timezone: "UTC", ...prefs } } });
      expect(r.status, r.text).toBe(200);
      return r.json.id as string;
    };
    const v4 = await mk({ pushVersion: 4 }, 1);
    const v3 = await mk({ pushVersion: 3 }, 2);
    const named = await create(client, { name: "Big day", metric: "revenue", target: 400, notify: true });
    const unnamed = await create(client, { metric: "sales", target: 1, notify: true, scope: "include", appIds: [a] });
    const quiet = await create(client, { name: "Quiet", metric: "revenue", target: 100 });
    const notYet = await create(client, { name: "Later", metric: "revenue", target: 10_000, notify: true });
    await setDay(ws, a, TODAY, { gross_usd: 500, new_subscriptions: 2 });

    const mine = () => pushes.filter((p) => [v4, v3].includes(p.deviceId));
    await checkGoalPushes(env, {});
    const sent = mine();
    expect(sent.map((p) => p.deviceId)).toEqual([v4, v4]);
    const byGoal = new Map(sent.map((p) => [p.msg.data?.goalId, p.msg]));
    expect(byGoal.get(named.id)).toMatchObject({ kind: "goal", titleKey: "PUSH_TITLE_GOAL", titleArgs: ["Big day"], bodyKey: "PUSH_BODY_GOAL_REACHED", bodyArgs: ["$500.00", "$400.00"] });
    expect(byGoal.get(unnamed.id)).toMatchObject({ titleKey: "PUSH_TITLE_GOAL_SALES", titleArgs: [], bodyArgs: ["2", "1"] });
    expect(byGoal.has(quiet.id)).toBe(false);
    expect(byGoal.has(notYet.id)).toBe(false);
    const mark = await db().prepare("SELECT notified_period FROM goals WHERE id = ?").bind(named.id).first<{ notified_period: string }>();
    expect(mark?.notified_period).toBe(periodBounds("month", TODAY).start);

    // Once per period.
    await setDay(ws, a, TODAY, { gross_usd: 600, new_subscriptions: 3 });
    await checkGoalPushes(env, {});
    expect(mine()).toHaveLength(2);
    // A new target makes it notify again once reached.
    const up = await call(client, `/api/v1/goals/${named.id}`, { method: "PATCH", body: { target: 550 } });
    expect(up.status, up.text).toBe(200);
    // Renaming or archiving toggles do not.
    await call(client, `/api/v1/goals/${unnamed.id}`, { method: "PATCH", body: { name: "Renamed" } });
    await checkGoalPushes(env, {});
    expect(mine()).toHaveLength(3);
    expect(mine()[2].msg.data?.goalId).toBe(named.id);
  });

  it("enforces permissions and validates", async () => {
    const { client, ws, app } = await workspace("Goals access");
    const a = await app("Mine");
    const other = await workspace("Goals other");
    const foreign = await other.app("Theirs");
    const g = await create(client, { metric: "revenue", target: 10 });

    const bad = async (body: Record<string, unknown>, method = "POST", path = "/api/v1/goals") => {
      const r = await call(client, path, { method, body });
      expect(r.status, `${JSON.stringify(body)}: ${r.text}`).toBe(400);
      return r.json.error as string;
    };
    expect(await bad({ metric: "revenue", target: 10, name: "x".repeat(61) })).toMatch(/60/);
    expect(await bad({ metric: "revenue", target: 10, scope: "include", appIds: [] })).toMatch(/at least one app/);
    expect(await bad({ metric: "revenue", target: 10, scope: "exclude" })).toMatch(/at least one app/);
    expect(await bad({ metric: "revenue", target: 10, scope: "include", appIds: [a, foreign] })).toMatch(/Unknown app/);
    expect(await bad({ metric: "revenue", target: 10, period: "custom", startDate: "2026-02-01" })).toMatch(/custom/);
    expect(await bad({ metric: "revenue", target: 10, period: "custom", startDate: "2026-02-10", endDate: "2026-02-01" })).toMatch(/before/);
    expect(await bad({ metric: "arr", target: 10 })).toMatch(/metric/);
    expect(await bad({ metric: "revenue", target: 0 })).toMatch(/target/);
    expect(await bad({ scope: "exclude", appIds: [foreign] }, "PATCH", `/api/v1/goals/${g.id}`)).toMatch(/Unknown app/);
    expect(await bad({ ids: ["goal_nope"] }, "POST", "/api/v1/goals/reorder")).toMatch(/Unknown goal/);
    // Other workspaces' goals are not found.
    expect((await call(other.client, `/api/v1/goals/${g.id}`, { method: "PATCH", body: { name: "x" } })).status).toBe(404);
    expect((await call(other.client, `/api/v1/goals/${g.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await call(other.client, `/api/v1/goals/${g.id}`)).status).toBe(404);

    // A viewer reads, never writes.
    const inv = await call(client, "/api/v1/invitations", { body: { role: "viewer" } });
    const token = inv.json.url.split("/invite/")[1];
    const acc = await call(null, "/api/v1/auth/invitations/accept", { body: { token, name: "Goal viewer", email: `goal-viewer-${ws}@rf.test`, password: "password123" } });
    expect(acc.status, acc.text).toBe(200);
    const viewer = { cookie: sessionCookie(acc.headers), ws };
    expect((await call(viewer, "/api/v1/goals")).status).toBe(200);
    expect((await call(viewer, `/api/v1/goals/${g.id}`)).status).toBe(200);
    expect((await call(viewer, "/api/v1/goals", { body: { metric: "revenue", target: 5 } })).status).toBe(403);
    expect((await call(viewer, `/api/v1/goals/${g.id}`, { method: "PATCH", body: { name: "x" } })).status).toBe(403);
    expect((await call(viewer, "/api/v1/goals/reorder", { body: { ids: [g.id] } })).status).toBe(403);
    expect((await call(viewer, `/api/v1/goals/${g.id}`, { method: "DELETE" })).status).toBe(403);

    expect((await call(client, `/api/v1/goals/${g.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(client, `/api/v1/goals/${g.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("keeps a goal editable after one of its apps is deleted", async () => {
    const { client, ws, app } = await workspace("Goals deleted app");
    const [a, b] = [await app("Kept"), await app("Gone")];
    const both = await create(client, { metric: "revenue", target: 100, scope: "include", appIds: [a, b], notify: true });
    const onlyGone = await create(client, { metric: "revenue", target: 100, scope: "include", appIds: [b] });
    await db().prepare("DELETE FROM apps WHERE id = ?").bind(b).run();
    await touch(ws);
    // Archive and rename do not trip over the deleted app; it leaves the stored list.
    let r = await call(client, `/api/v1/goals/${both.id}`, { method: "PATCH", body: { archived: true } });
    expect(r.status, r.text).toBe(200);
    r = await call(client, `/api/v1/goals/${both.id}`, { method: "PATCH", body: { name: "Renamed" } });
    expect(r.status, r.text).toBe(200);
    expect(r.json.goal).toMatchObject({ name: "Renamed", archived: true, appIds: [a] });
    const row = await db().prepare("SELECT app_ids FROM goals WHERE id = ?").bind(both.id).first<{ app_ids: string }>();
    expect(JSON.parse(row!.app_ids)).toEqual([a]);
    // A goal left with no app: still archivable, labelled "No apps"; changing its apps needs one.
    r = await call(client, `/api/v1/goals/${onlyGone.id}`, { method: "PATCH", body: { archived: true } });
    expect(r.status, r.text).toBe(200);
    expect(r.json.goal).toMatchObject({ appIds: [], label: "Revenue · No apps", current: 0 });
    r = await call(client, `/api/v1/goals/${onlyGone.id}`, { method: "PATCH", body: { scope: "include" } });
    expect(r.status).toBe(400);
    // Sending the deleted app explicitly is still refused.
    r = await call(client, `/api/v1/goals/${onlyGone.id}`, { method: "PATCH", body: { appIds: [b] } });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/Unknown app/);
  });

  it("does not notify again when a client saves the same apps and target back (order, FX rounding)", async () => {
    const { client, ws, app } = await workspace("Goals FX", "EUR");
    const [a, b] = [await app("Euro A"), await app("Euro B")];
    const fx = (rate: number) => db().prepare("INSERT INTO fx_rates (day, currency, per_usd) VALUES (?, 'EUR', ?) ON CONFLICT(day, currency) DO UPDATE SET per_usd = excluded.per_usd").bind(TODAY, rate).run();
    await fx(0.9);
    await setDay(ws, a, TODAY, { gross_usd: 500 });
    const g = await create(client, { metric: "revenue", target: 100, scope: "include", appIds: [b, a], notify: true });
    await checkGoalPushes(env, {});
    const stored = () => db().prepare("SELECT notified_period, target_usd FROM goals WHERE id = ?").bind(g.id).first<{ notified_period: string | null; target_usd: number }>();
    const before = await stored();
    expect(before?.notified_period).toBe(periodBounds("month", TODAY).start);
    // The rate moves; the client shows the target at the new rate, rounded to cents, and saves it with the apps sorted.
    await fx(0.9317);
    await touch(ws);
    const shown = (await list(client)).get(g.id);
    expect(shown.target).not.toBe(100);
    const r = await call(client, `/api/v1/goals/${g.id}`, { method: "PATCH", body: { target: Math.round(shown.target * 100) / 100, appIds: [a, b], scope: "include" } });
    expect(r.status, r.text).toBe(200);
    expect(await stored()).toEqual(before);
    // A real change still re-arms it.
    await call(client, `/api/v1/goals/${g.id}`, { method: "PATCH", body: { target: 200 } });
    expect((await stored())?.notified_period).toBeNull();
  });

  it("checks every workspace in turn when more than 10 have pending goals", async () => {
    // 13 workspaces with a pending goal; the last 2 in workspace order get reached: 11 still pending ones come first.
    const made: { ws: string; goal: string }[] = [];
    for (let i = 0; i < 13; i++) {
      const { client, ws, app } = await workspace(`Goals rotate ${i}`);
      const a = await app(`Rotate ${i}`);
      await setDay(ws, a, TODAY, { gross_usd: 5 });
      made.push({ ws, goal: (await create(client, { metric: "revenue", target: 1_000_000, notify: true })).id });
    }
    made.sort((x, y) => (x.ws < y.ws ? -1 : 1));
    const goals: string[] = [];
    for (const m of made.slice(-2)) {
      await db().prepare("UPDATE goals SET target_usd = 1 WHERE id = ?").bind(m.goal).run();
      await touch(m.ws);
      goals.push(m.goal);
    }
    const pending = await db().prepare("SELECT COUNT(DISTINCT workspace_id) AS n FROM goals WHERE notify = 1 AND archived = 0").first<{ n: number }>();
    const notified = async () => {
      const { results } = await db().prepare(`SELECT notified_period FROM goals WHERE id IN (${goals.map(() => "?").join(",")})`).bind(...goals).all<{ notified_period: string | null }>();
      return results.filter((r) => r.notified_period).length;
    };
    // Every pending workspace is reached within ceil(pending / 10) runs.
    for (let i = 0; i < Math.ceil(pending!.n / 10); i++) await checkGoalPushes(env, {});
    expect(await notified()).toBe(2);
  });

  it("notifies a custom goal reached in its last minutes during the first hour of the next day", async () => {
    const { client, ws, app } = await workspace("Goals late");
    const a = await app("Late");
    const yesterday = addDays(TODAY, -1);
    await setDay(ws, a, yesterday, { gross_usd: 50 });
    const g = await create(client, { name: "Late one", metric: "revenue", target: 40, period: "custom", startDate: addDays(TODAY, -3), endDate: yesterday, notify: true });
    expect(g).toMatchObject({ status: "ended", pace: "reached" });
    await db().prepare("UPDATE goals SET created_at = ? WHERE id = ?").bind(dayStart(TODAY) - 5 * 86_400_000, g.id).run();
    const mark = async () => (await db().prepare("SELECT notified_period FROM goals WHERE id = ?").bind(g.id).first<{ notified_period: string | null }>())?.notified_period;
    // After the first hour: too late.
    // Enough runs for the rotation to reach every workspace.
    const runs = Math.ceil((await db().prepare("SELECT COUNT(DISTINCT workspace_id) AS n FROM goals WHERE notify = 1 AND archived = 0").first<{ n: number }>())!.n / 10);
    for (let i = 0; i < runs; i++) await checkGoalPushes(env, { at: dayStart(TODAY) + 2 * 3_600_000 });
    expect(await mark()).toBeNull();
    for (let i = 0; i < runs; i++) await checkGoalPushes(env, { at: dayStart(TODAY) + 10 * 60_000 });
    expect(await mark()).toBe(addDays(TODAY, -3));
  });
});
