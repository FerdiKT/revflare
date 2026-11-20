import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getDb } from "../../worker/lib/db";
import { addDays } from "../../worker/lib/money";
import { call, ownerClient, type Client } from "./helpers";

// The UTC day rollover (worker/lib/metrics.ts stocksAsOf): just after 00:00 UTC the new day's rows appear app by app
// (a sale, the nightly rollup queue). Until every app is rolled for the new day, MRR / active subscriptions / trials
// come from the last complete day, never from a missing (0) or partial row, and the responses say which day that is.
// Rows are written here directly (no transactions: nothing queues a rollup for these apps).

const db = () => getDb(env);
const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = addDays(TODAY, -1);
const COLS = [
  "gross_usd", "proceeds_usd", "refunds_usd", "refunds", "new_subscriptions", "renewals", "one_time_purchases", "trials_started", "trial_conversions", "new_customers",
  "new_payers", "active_subscriptions", "active_trials", "mrr_usd", "mrr_proceeds_usd", "mrr_new", "mrr_expansion", "mrr_contraction", "mrr_churn", "mrr_reactivation", "churned_subscriptions",
];

let tick = 0;
/** Writes an app's day and the workspace total of that day, marks the app rolled through `rolled`, bumps the data version. */
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
async function rolled(ws: string, appId: string, day: string) {
  await db().prepare("UPDATE apps SET rolled_day = ? WHERE id = ?").bind(day, appId).run();
  await touch(ws);
}
async function touch(ws: string) {
  await db().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(`data_version:${ws}`, String(Date.now() + ++tick)).run();
}

async function get(client: Client, path: string) {
  const r = await call(client, path);
  expect(r.status, r.text).toBe(200);
  return r.json;
}
const kpi = (o: any, id: string) => o.kpis.find((k: any) => k.id === id);

async function stocks(client: Client) {
  const o = await get(client, "/api/v1/overview");
  const chart = await get(client, `/api/v1/charts/mrr?from=${TODAY}&to=${TODAY}`);
  const subsChart = await get(client, `/api/v1/charts/active_subscriptions?from=${YESTERDAY}&to=${TODAY}`);
  const byApp = await get(client, `/api/v1/charts/mrr?from=${TODAY}&to=${TODAY}&groupBy=app`);
  const apps = await get(client, "/api/v1/apps");
  return {
    asOf: o.stocksAsOf,
    mrr: kpi(o, "mrr").value,
    mrrAsOf: kpi(o, "mrr").asOf,
    subs: kpi(o, "active_subscriptions").value,
    trials: kpi(o, "active_trials").value,
    revenueAsOf: kpi(o, "revenue_28d").asOf,
    topApps: Object.fromEntries(o.topApps.map((a: any) => [a.name, a.mrr])),
    chartMrr: chart.points.at(-1).value,
    chartAsOf: chart.stocksAsOf,
    subsPoints: subsChart.points.map((p: any) => p.value),
    byApp: Object.fromEntries(byApp.series.map((s: any) => [s.label, s.points.at(-1).value])),
    appsMrr: Object.fromEntries(apps.items.map((a: any) => [a.name, a.mrr])),
    appsAsOf: apps.stocksAsOf,
  };
}

describe("MRR / actives / trials across the UTC day rollover", () => {
  it("reads the last complete day while today's rows are missing or partial, today once every app is rolled", async () => {
    const owner = await ownerClient();
    const w = await call(owner, "/api/v1/workspaces", { body: { name: "Rollover", currency: "USD" } });
    const client = { ...owner, ws: w.json.id as string };
    const ws = client.ws;
    const app = async (name: string) => {
      const a = await call(client, "/api/v1/apps", { body: { name, bundleId: `com.example.rollover.${name.toLowerCase()}` } });
      expect(a.status, a.text).toBe(201);
      return a.json.id as string;
    };
    const a = await app("Alpha");
    const b = await app("Beta");
    // Yesterday complete for both apps (gross_usd keeps them in the top apps).
    await setDay(ws, a, YESTERDAY, { gross_usd: 10, mrr_usd: 100, active_subscriptions: 10, active_trials: 2 });
    await setDay(ws, b, YESTERDAY, { gross_usd: 5, mrr_usd: 50, active_subscriptions: 5, active_trials: 1 });
    await rolled(ws, a, YESTERDAY);
    await rolled(ws, b, YESTERDAY);

    // 1. No row for today yet (00:00–00:10 UTC): yesterday's values, not 0.
    let s = await stocks(client);
    expect(s).toMatchObject({
      asOf: YESTERDAY,
      mrr: 150,
      mrrAsOf: YESTERDAY,
      subs: 15,
      trials: 3,
      revenueAsOf: undefined,
      topApps: { Alpha: 100, Beta: 50 },
      chartMrr: 150,
      chartAsOf: YESTERDAY,
      subsPoints: [15, 15],
      byApp: { Alpha: 100, Beta: 50 },
      appsMrr: { Alpha: 100, Beta: 50 },
      appsAsOf: YESTERDAY,
    });

    // 2. Partial: Alpha is rolled for today (a sale), Beta not yet: still yesterday's complete totals, not 110 + 0.
    await setDay(ws, a, TODAY, { gross_usd: 3, mrr_usd: 110, active_subscriptions: 11, active_trials: 2 });
    await rolled(ws, a, TODAY);
    s = await stocks(client);
    expect(s).toMatchObject({ asOf: YESTERDAY, mrr: 150, subs: 15, trials: 3, chartMrr: 150, chartAsOf: YESTERDAY, subsPoints: [15, 15], topApps: { Alpha: 100, Beta: 50 } });

    // 3. Complete: every app rolled for today: today's rows.
    await setDay(ws, b, TODAY, { mrr_usd: 55, active_subscriptions: 6, active_trials: 0 });
    await rolled(ws, b, TODAY);
    s = await stocks(client);
    expect(s).toMatchObject({
      asOf: TODAY,
      mrr: 165,
      mrrAsOf: TODAY,
      subs: 17,
      trials: 2,
      topApps: { Alpha: 110, Beta: 55 },
      chartMrr: 165,
      chartAsOf: undefined,
      subsPoints: [15, 17],
      byApp: { Alpha: 110, Beta: 55 },
      appsMrr: { Alpha: 110, Beta: 55 },
      appsAsOf: TODAY,
    });
  });

  it("an app stuck for days (failing rebuild) no longer holds the workspace's stocks back", async () => {
    const owner = await ownerClient();
    const w = await call(owner, "/api/v1/workspaces", { body: { name: "Stuck", currency: "USD" } });
    const client = { ...owner, ws: w.json.id as string };
    const mk = async (name: string) => (await call(client, "/api/v1/apps", { body: { name, bundleId: `com.example.stuck.${name.toLowerCase()}` } })).json.id as string;
    const a = await mk("Ok");
    const b = await mk("Stuck");
    await setDay(client.ws, a, TODAY, { mrr_usd: 70, active_subscriptions: 7 });
    await rolled(client.ws, a, TODAY);
    await rolled(client.ws, b, addDays(TODAY, -10));
    const o = await get(client, "/api/v1/overview");
    expect(o.stocksAsOf).toBe(TODAY);
    expect(kpi(o, "mrr").value).toBe(70);
  });
});
