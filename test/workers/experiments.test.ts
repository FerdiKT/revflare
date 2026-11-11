import { env, fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../worker/lib/db";
import { eventsTestHooks } from "../../worker/lib/events";
import { cronExperiments } from "../../worker/lib/experiments";
import { TickBudget } from "../../worker/lib/insights";
import { assignVariant } from "../../worker/lib/remote-config";
import { forgetSdkRemoteConfig, sdkCacheStats } from "../../worker/lib/sdk-cache";
import { resetWaeCache, waeStats } from "../../worker/lib/wae";
import { DAY, ORIGIN, call, notification, ownerClient, type Client, type TxOptions } from "./helpers";

// A/B experiments (worker/lib/experiments.ts): lifecycle, assignment in GET /sdk/v1/config, results from synthetic
// Analytics Engine install lists (fetchMock) and real transactions, the daily snapshot and the auto-stop.

const CF = "https://api.cloudflare.com";
const SQL_PATH = `/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`;
const H = 3_600_000;
const stats = () => env.DATABASE.get(env.DATABASE.idFromName("main")).stats();
const dbExec = (sql: string, params: (string | number | null)[] = []) => env.DATABASE.get(env.DATABASE.idFromName("main")).exec([{ sql, params, mode: "run" }], false);
const db = () => getDb(env);
const sqls: string[] = [];

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  eventsTestHooks.binding = { writeDataPoint: () => undefined };
});
afterAll(() => {
  eventsTestHooks.binding = null;
});

/** Answers exactly `times` SQL API requests with `answer(sql)`. */
function interceptSql(times: number, answer: (sql: string) => Record<string, unknown>[]) {
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

async function workspace(owner: Client, name: string): Promise<Client> {
  const ws = await call(owner, "/api/v1/workspaces", { body: { name, currency: "USD" } });
  expect(ws.status, ws.text).toBe(200);
  return { ...owner, ws: ws.json.id as string };
}

async function newApp(client: Client, bundleId: string) {
  const app = await call(client, "/api/v1/apps", { body: { name: bundleId, bundleId } });
  expect(app.status).toBe(201);
  return { id: app.json.id as string, sdkKey: app.json.sdkKey as string, notifKey: (app.json.revflareNotificationUrl as string).split("/").pop()! };
}

const CONFIG = {
  conditions: [
    { name: "china", rules: [{ type: "country", values: ["CN"] }] },
    { name: "testers", rules: [{ type: "install_id", values: ["00000000-0000-4000-8000-00000000000a"] }] },
  ],
  parameters: [
    { key: "paywall_variant", type: "string", defaultValue: "classic", conditionalValues: { china: "cn" } },
    { key: "trial_days", type: "number", defaultValue: 7 },
    { key: "show_close", type: "boolean", defaultValue: true },
  ],
};

const uuid = (prefix: string, i: number) => `${prefix}0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const sdk = (key: string, installId: string, country = "US", headers: Record<string, string> = {}) =>
  call(null, `/sdk/v1/config?installId=${installId}&storefront=${country}&appVersion=2.0`, { headers: { "x-revflare-key": key, ...headers } });

describe("experiments", { timeout: 120_000 }, () => {
  it("validates, runs, assigns devices without database reads, stops without a flip and rolls out the winner", async () => {
    const owner = await ownerClient();
    const client = await workspace(owner, "Experiments WS");
    const { id, sdkKey } = await newApp(client, "com.example.exp.lifecycle");
    const base = `/api/v1/apps/${id}/experiments`;
    expect((await call(client, `/api/v1/apps/${id}/config`, { method: "PUT", body: CONFIG })).status).toBe(200);

    // Validation.
    const bad = async (body: unknown, text: string) => {
      const r = await call(client, base, { body });
      expect(r.status, r.text).toBe(400);
      expect(r.json.error).toContain(text);
    };
    await bad({ name: "x", keys: ["nope"], variants: [{}, {}] }, '"nope" does not exist');
    await bad({ name: "x", keys: ["trial_days"], variants: [{}, { values: { trial_days: "long" } }] }, "expected a finite number");
    await bad({ name: "x", keys: ["trial_days"], variants: [{ weight: 30 }, { weight: 30, values: { trial_days: 3 } }] }, "sum to 100");
    await bad({ name: "x", keys: ["trial_days"], variants: [{}, { values: { trial_days: 3 } }], targeting: "nobody" }, "does not exist");

    const created = await call(client, base, {
      body: { name: "Paywall copy", hypothesis: "The new paywall converts better", keys: ["paywall_variant"], variants: [{ name: "Classic" }, { name: "Bold", values: { paywall_variant: "bold" } }] },
    });
    expect(created.status, created.text).toBe(201);
    const exp = created.json;
    expect(exp).toMatchObject({ appId: id, status: "draft", keys: ["paywall_variant"], traffic: 100, primaryMetric: "paid", targeting: null, startedAt: null, endsAt: null });
    expect(exp.id).toMatch(/^exp_[0-9a-f]{12}$/);
    expect(exp.variants).toEqual([
      { id: "a", name: "Classic", weight: 50, values: {} },
      { id: "b", name: "Bold", weight: 50, values: { paywall_variant: "bold" } },
    ]);
    // Drafts are editable; the payload has no experiment yet.
    const patched = await call(client, `${base}/${exp.id}`, { method: "PATCH", body: { traffic: 80, primaryMetric: "trial_started" } });
    expect(patched.json).toMatchObject({ traffic: 80, primaryMetric: "trial_started", name: "Paywall copy" });
    expect((await sdk(sdkKey, uuid("1", 1))).json.experiments).toBeUndefined();

    // A second draft on an overlapping key: allowed as a draft, refused at start while the first one is active.
    const other = await call(client, base, { body: { name: "Overlap", keys: ["paywall_variant", "trial_days"], variants: [{}, { values: { paywall_variant: "x", trial_days: 3 } }] } });
    expect(other.status).toBe(201);

    const started = await call(client, `${base}/${exp.id}/start`, { method: "POST" });
    expect(started.status, started.text).toBe(200);
    expect(started.json.status).toBe("running");
    expect(started.json.endsAt - started.json.startedAt).toBe(90 * DAY);
    const overlap = await call(client, `${base}/${other.json.id}/start`, { method: "POST" });
    expect(overlap.status).toBe(409);
    expect(overlap.json.error).toContain('Parameter "paywall_variant" is already in experiment');
    expect((await call(client, `${base}/${exp.id}`, { method: "PATCH", body: { traffic: 50 } })).status).toBe(409);
    expect((await call(client, `${base}/${exp.id}`, { method: "DELETE" })).status).toBe(409);
    expect((await call(client, `${base}/${exp.id}/start`, { method: "POST" })).status).toBe(409);

    // The config cannot drop or retype a parameter of a running experiment.
    const cfg = (await call(client, `/api/v1/apps/${id}/config`)).json;
    const dropped = await call(client, `/api/v1/apps/${id}/config`, { method: "PUT", body: { conditions: cfg.conditions, parameters: cfg.parameters.slice(1) } });
    expect(dropped.status).toBe(400);
    expect(dropped.json.error).toContain(`used by experiment ${exp.id}`);

    // Devices: 80% enrolled, split by weight; the response says which variant; deterministic per install.
    const seen: Record<string, number> = { a: 0, b: 0, none: 0 };
    const assignment = new Map<string, string | null>();
    for (let i = 0; i < 60; i++) {
      const install = uuid("1", i);
      const r = await sdk(sdkKey, install);
      expect(r.status).toBe(200);
      const expected = await assignVariant(install, { id: exp.id, traffic: 80, variants: exp.variants });
      assignment.set(install, expected);
      seen[expected ?? "none"]++;
      if (!expected) {
        expect(r.json.experiments).toBeUndefined();
        expect(r.json.values.paywall_variant).toBe("classic");
      } else {
        expect(r.json.experiments).toEqual([{ id: exp.id, variant: expected, keys: ["paywall_variant"] }]);
        expect(r.json.values.paywall_variant).toBe(expected === "b" ? "bold" : "classic");
      }
    }
    expect(seen.a).toBeGreaterThan(5);
    expect(seen.b).toBeGreaterThan(5);
    expect(seen.none).toBeGreaterThan(2);
    // The control in China keeps the condition's value.
    const control = [...assignment].find(([, v]) => v === "a")![0];
    expect((await sdk(sdkKey, control, "CN")).json.values.paywall_variant).toBe("cn");
    // "Preview as" shows where the value comes from.
    const bold = [...assignment].find(([, v]) => v === "b")![0];
    const ev = await call(client, `/api/v1/apps/${id}/config/evaluate`, { body: { installId: bold, storefront: "US" } });
    expect(ev.json.parameters.paywall_variant).toEqual({ condition: null, useInAppDefault: false, value: "bold", experiment: exp.id, variant: "b" });
    expect(ev.json.experiments).toEqual([{ id: exp.id, variant: "b", keys: ["paywall_variant"] }]);

    // No database read per SDK request (the compiled payload is cached in the isolate). Counted by the SDK cache, not
    // the database object's row counters: in a full test run, work left running by earlier test files (workflows)
    // reads rows meanwhile. Loaded afresh first: on a loaded machine the loops above can outlast the 60 s TTL.
    await forgetSdkRemoteConfig(sdkKey, `${ORIGIN}/`);
    expect((await sdk(sdkKey, uuid("1", 0))).status).toBe(200);
    const cacheBefore = { ...sdkCacheStats };
    for (let i = 0; i < 20; i++) expect((await sdk(sdkKey, uuid("1", i), i % 2 ? "CN" : "US")).status).toBe(200);
    expect(sdkCacheStats.database - cacheBefore.database).toBe(0);
    expect(sdkCacheStats.memory - cacheBefore.memory).toBe(20);

    // Stop: devices keep their variant (no flip).
    const stopped = await call(client, `${base}/${exp.id}/stop`, { method: "POST" });
    expect(stopped.json.status).toBe("stopped");
    expect(stopped.json.stoppedAt).toBeGreaterThanOrEqual(stopped.json.startedAt);
    const r1 = await sdk(sdkKey, bold);
    expect(r1.json.values.paywall_variant).toBe("bold");
    expect(r1.json.experiments).toEqual([{ id: exp.id, variant: "b", keys: ["paywall_variant"] }]);
    expect((await call(client, `${base}/${other.json.id}/start`, { method: "POST" })).status).toBe(409);

    // Rollout: b's values become the defaults, the experiment leaves the payload.
    expect((await call(client, `${base}/${exp.id}/rollout`, { body: { variant: "z" } })).status).toBe(400);
    const rolled = await call(client, `${base}/${exp.id}/rollout`, { body: { variant: "b" } });
    expect(rolled.status, rolled.text).toBe(200);
    expect(rolled.json).toMatchObject({ status: "rolled_out", rolledOutVariant: "b" });
    const config = (await call(client, `/api/v1/apps/${id}/config`)).json;
    expect(config.parameters[0]).toEqual({ key: "paywall_variant", type: "string", defaultValue: "bold", conditionalValues: { china: "cn" } });
    for (const install of [control, bold]) {
      const r = await sdk(sdkKey, install);
      expect(r.json.values.paywall_variant).toBe("bold");
      expect(r.json.experiments).toBeUndefined();
    }

    // The other experiment can start now; archive removes it without touching the defaults.
    expect((await call(client, `${base}/${other.json.id}/start`, { method: "POST" })).status).toBe(200);
    expect((await sdk(sdkKey, bold)).json.experiments?.[0]?.id).toBe(other.json.id);
    const archived = await call(client, `${base}/${other.json.id}/archive`, { method: "POST" });
    expect(archived.json.status).toBe("archived");
    expect((await sdk(sdkKey, bold)).json).toMatchObject({ values: { paywall_variant: "bold", trial_days: 7 } });
    expect((await sdk(sdkKey, bold)).json.experiments).toBeUndefined();
    expect((await call(client, `${base}/${other.json.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(client, `${base}/${other.json.id}`)).status).toBe(404);

    // Draft results: nothing measured, no Analytics Engine query.
    const draft = await call(client, base, { body: { name: "Later", keys: ["trial_days"], variants: [{}, { values: { trial_days: 14 } }], targeting: "testers" } });
    const dr = await call(client, `${base}/${draft.json.id}/results`);
    expect(dr.status).toBe(200);
    expect(dr.json).toMatchObject({ enoughData: false, exposureSource: "none", reasons: ["The experiment has not started."] });

    const list = await call(client, base);
    expect(list.json.items.map((x: { id: string; status: string }) => [x.id, x.status])).toEqual([
      [draft.json.id, "draft"],
      [exp.id, "rolled_out"],
    ]);
    expect((await call(owner, base)).status).toBe(404);

    // MCP (read-only tools).
    const key = await call(client, "/api/v1/api-keys", { body: { name: "exp-mcp" } });
    const mcp = (name: string, args: Record<string, unknown>) => call({ token: key.json.token }, "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
    const items = JSON.parse((await mcp("list_experiments", { app: id })).json.result.content[0].text).items;
    expect(items).toHaveLength(2);
    const mr = JSON.parse((await mcp("get_experiment_results", { app: id, experiment: draft.json.id })).json.result.content[0].text);
    expect(mr.experimentId).toBe(draft.json.id);
  });

  it("measures exposed installs, trials, paid conversions and revenue per install; freezes after the stop; raises one alert", async () => {
    const owner = await ownerClient();
    const client = await workspace(owner, "Experiment results WS");
    const bundleId = "com.example.exp.results";
    const { id, notifKey } = await newApp(client, bundleId);
    expect((await call(client, `/api/v1/apps/${id}/config`, { method: "PUT", body: CONFIG })).status).toBe(200);
    const base = `/api/v1/apps/${id}/experiments`;
    const exp = (await call(client, base, { body: { name: "Trial length", keys: ["trial_days"], variants: [{}, { values: { trial_days: 3 } }] } })).json;
    expect((await call(client, `${base}/${exp.id}/start`, { method: "POST" })).status).toBe(200);
    const start = Date.now() - 10 * DAY;
    await dbExec("UPDATE experiments SET started_at = ? WHERE id = ?", [start, exp.id]);

    // 120 exposed installs per variant, first exposure a day after the start (one a minute).
    const exposedAt = (i: number) => start + DAY + i * 60_000;
    const installs = { a: Array.from({ length: 120 }, (_, i) => uuid("a", i)), b: Array.from({ length: 120 }, (_, i) => uuid("b", i)) };
    let seq = 0;
    const post = async (type: string, tx: Omit<TxOptions, "bundleId" | "transactionId"> & { transactionId?: string }, opts: { subtype?: string } = {}) => {
      const n = await notification(type, { bundleId, transactionId: tx.transactionId ?? `77${String(++seq).padStart(6, "0")}`, ...tx }, opts);
      expect((await call(null, `/apple/notifications/${notifKey}`, { body: { signedPayload: n.signedPayload } })).status).toBe(200);
    };
    const paid = (install: string, at: number, extra: Partial<TxOptions> = {}) => post("SUBSCRIBED", { purchaseDate: at, expiresDate: at + 30 * DAY, price: 9990, appAccountToken: install, ...extra });
    const trial = (install: string, at: number) => post("SUBSCRIBED", { purchaseDate: at, expiresDate: at + 3 * DAY, price: 0, offerType: 1, offerDiscountType: "FREE_TRIAL", appAccountToken: install });
    // a: 3 paid (0..2), 10 trials (3..12).
    for (let i = 0; i < 3; i++) await paid(installs.a[i], exposedAt(i) + H);
    for (let i = 3; i < 13; i++) await trial(installs.a[i], exposedAt(i) + H);
    // b: 12 paid (0..11), 20 trials (12..31); 32 paid and fully refunded; 33 paid a day before its exposure; 34 in Sandbox.
    for (let i = 0; i < 12; i++) await paid(installs.b[i], exposedAt(i) + H);
    for (let i = 12; i < 32; i++) await trial(installs.b[i], exposedAt(i) + H);
    await paid(installs.b[32], exposedAt(32) + H, { transactionId: "77990032" });
    await post("REFUND", { transactionId: "77990032", purchaseDate: exposedAt(32) + H, expiresDate: exposedAt(32) + 31 * DAY, price: 9990, appAccountToken: installs.b[32], revocationDate: exposedAt(32) + 2 * H, revocationReason: 1 });
    await paid(installs.b[33], exposedAt(33) - DAY);
    await paid(installs.b[34], exposedAt(34) + H, { environment: "Sandbox" });
    // 35: an existing subscriber (bought 20 days before the start) renews after the exposure: neither paid nor revenue.
    const subscribed = start - 20 * DAY;
    await paid(installs.b[35], subscribed, { transactionId: "77990035" });
    await post("DID_RENEW", { transactionId: "77990135", originalTransactionId: "77990035", originalPurchaseDate: subscribed, transactionReason: "RENEWAL", purchaseDate: exposedAt(35) + H, expiresDate: exposedAt(35) + 30 * DAY, price: 9990, appAccountToken: installs.b[35] });
    // 36: bought after the exposure, renewed a day later: one paid conversion, both transactions are revenue.
    await paid(installs.b[36], exposedAt(36) + H, { transactionId: "77990036", expiresDate: exposedAt(36) + H + DAY });
    await post("DID_RENEW", { transactionId: "77990136", originalTransactionId: "77990036", originalPurchaseDate: exposedAt(36) + H, transactionReason: "RENEWAL", purchaseDate: exposedAt(36) + H + DAY, expiresDate: exposedAt(36) + H + 31 * DAY, price: 9990, appAccountToken: installs.b[36] });
    // 37: a trial started before the start converts after the exposure: neither paid nor revenue (began before).
    const trialAt = start - 2 * DAY;
    await post("SUBSCRIBED", { transactionId: "77990037", purchaseDate: trialAt, expiresDate: trialAt + 3 * DAY, price: 0, offerType: 1, offerDiscountType: "FREE_TRIAL", appAccountToken: installs.b[37] });
    await post("DID_RENEW", { transactionId: "77990137", originalTransactionId: "77990037", originalPurchaseDate: trialAt, transactionReason: "RENEWAL", purchaseDate: exposedAt(37) + H, expiresDate: exposedAt(37) + 30 * DAY, price: 9990, appAccountToken: installs.b[37] });

    const answer = (sql: string) => {
      expect(sql).toContain(`index1 = '${id}'`);
      expect(sql).toContain("blob1 = 'experiment_exposure'");
      // First exposure = device event time, bounded to the window server-side; 20,000 installs over 2 variants.
      expect(sql).toContain("min(double1) AS first");
      expect(sql).toMatch(/double1 >= \d+ AND double1 < \d+/);
      expect(sql).toContain("LIMIT 10001");
      const v = sql.includes(`blob17 = '${exp.id}:a'`) ? "a" : sql.includes(`blob17 = '${exp.id}:b'`) ? "b" : null;
      expect(v).not.toBeNull();
      return installs[v as "a" | "b"].map((install, i) => ({ install, first: exposedAt(i), si: 1 }));
    };
    resetWaeCache();
    interceptSql(2, answer);
    const res = await call(client, `${base}/${exp.id}/results`);
    expect(res.status, res.text).toBe(200);
    fetchMock.assertNoPendingInterceptors();
    const r = res.json;
    expect(r).toMatchObject({ experimentId: exp.id, status: "running", primaryMetric: "paid", currency: "USD", exposureSource: "events", approximate: false, frozen: false, enoughData: true, reasons: [] });
    const [a, b] = r.variants;
    expect([a.exposed, a.trials, a.paid]).toEqual([120, 10, 3]);
    expect([b.exposed, b.trials, b.paid]).toEqual([120, 20, 13]);
    expect(a.revenue).toBeCloseTo(29.97, 6);
    // 12 purchases + 36's purchase and renewal (not 35's or 37's renewals: begun before the exposure).
    expect(b.revenue).toBeCloseTo(14 * 9.99, 6);
    expect(a.revenuePerInstall).toBeCloseTo(29.97 / 120, 9);
    expect(b.revenuePerInstall).toBeCloseTo((14 * 9.99) / 120, 9);
    expect(b.paidRate).toBeCloseTo(13 / 120, 9);
    expect(b.trialRate).toBeCloseTo(20 / 120, 9);
    expect(b.proceeds).toBeGreaterThan(0);
    expect(b.proceeds).toBeLessThan(b.revenue);
    expect(b.probabilityBest.paid).toBeGreaterThan(0.99);
    expect(a.probabilityBest.paid + b.probabilityBest.paid).toBeCloseTo(1, 9);
    expect(a.lift.paid).toBeNull();
    expect(b.lift.paid.expected).toBeGreaterThan(1);
    expect(b.lift.paid.low).toBeGreaterThan(0);
    expect(r.confident).toEqual({ variant: "b", probability: b.probabilityBest.paid });
    expect(r.daysRunning).toBeGreaterThanOrEqual(10);

    // One experiment_result alert (no push), linked to the experiment.
    const alerts = (await call(client, "/api/v1/alerts")).json.items.filter((x: { kind: string }) => x.kind === "experiment_result");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ appId: id, experimentId: exp.id, severity: "info" });
    expect(alerts[0].title).toContain("is ahead");

    // Stored results are served, however old (the cron recomputes them): no Analytics Engine query, no write.
    await dbExec("UPDATE experiments SET results_at = ? WHERE id = ?", [r.generatedAt - 5 * H, exp.id]);
    const requests = waeStats.requests;
    const before = await stats();
    expect((await call(client, `${base}/${exp.id}/results`)).json).toEqual(r);
    const after = await stats();
    expect(waeStats.requests).toBe(requests);
    expect(after.rowsWritten - before.rowsWritten).toBe(0);
    expect(after.rowsRead - before.rowsRead).toBeLessThan(15);

    // An explicit refresh recomputes (b now has 50 exposed installs: not enough data, so the alert is resolved)...
    resetWaeCache();
    interceptSql(2, (sql) => (sql.includes(`${exp.id}:b`) ? answer(sql).slice(0, 50) : answer(sql)));
    const refreshed = await call(client, `${base}/${exp.id}/results/refresh`, { method: "POST" });
    fetchMock.assertNoPendingInterceptors();
    expect(refreshed.status, refreshed.text).toBe(200);
    expect(refreshed.json.variants.map((v: { exposed: number }) => v.exposed)).toEqual([120, 50]);
    expect(refreshed.json).toMatchObject({ enoughData: false, confident: null });
    const resolved = (await call(client, "/api/v1/alerts")).json.items.filter((x: { kind: string }) => x.kind === "experiment_result");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].resolvedAt).toBeGreaterThan(0);
    // ...at most once an hour (no query, the stored results stay).
    const again = await call(client, `${base}/${exp.id}/results/refresh`, { method: "POST" });
    expect(again.status).toBe(429);
    expect(again.json.retryAfter).toBeGreaterThan(3000);
    expect(again.json.retryAfter).toBeLessThanOrEqual(3600);
    expect((await call(client, `${base}/${exp.id}/results`)).json.generatedAt).toBe(refreshed.json.generatedAt);

    // Stop (stopped earlier than now: the window ends then): recomputed once, then frozen for good.
    expect((await call(client, `${base}/${exp.id}/stop`, { method: "POST" })).status).toBe(200);
    const stopAt = start + 9 * DAY;
    await dbExec("UPDATE experiments SET stopped_at = ? WHERE id = ?", [stopAt, exp.id]);
    resetWaeCache();
    interceptSql(2, answer);
    const final = await call(client, `${base}/${exp.id}/results`);
    fetchMock.assertNoPendingInterceptors();
    expect(final.json).toMatchObject({ status: "stopped", frozen: true, to: stopAt, daysRunning: 9 });
    expect(final.json.variants.map((v: { paid: number }) => v.paid)).toEqual([3, 13]);
    await dbExec("UPDATE experiments SET results_at = 0 WHERE id = ?", [exp.id]);
    expect((await call(client, `${base}/${exp.id}/results`)).json.generatedAt).toBe(final.json.generatedAt);
    expect((await call(client, `${base}/${exp.id}/results/refresh`, { method: "POST" })).status).toBe(409);
    // Still one alert (raised only while running).
    expect((await call(client, "/api/v1/alerts")).json.items.filter((x: { kind: string }) => x.kind === "experiment_result")).toHaveLength(1);
    expect((await call(client, `${base}/${exp.id}/archive`, { method: "POST" })).status).toBe(200);
  });

  it("shows not enough data before the guardrails are met", async () => {
    const owner = await ownerClient();
    const client = await workspace(owner, "Experiment guardrails WS");
    const { id } = await newApp(client, "com.example.exp.guardrails");
    expect((await call(client, `/api/v1/apps/${id}/config`, { method: "PUT", body: CONFIG })).status).toBe(200);
    const base = `/api/v1/apps/${id}/experiments`;
    const exp = (await call(client, base, { body: { name: "Close button", keys: ["show_close"], variants: [{}, { values: { show_close: false } }], primaryMetric: "trial_started" } })).json;
    expect((await call(client, `${base}/${exp.id}/start`, { method: "POST" })).status).toBe(200);
    const start = Date.now() - 3 * DAY;
    await dbExec("UPDATE experiments SET started_at = ? WHERE id = ?", [start, exp.id]);
    resetWaeCache();
    interceptSql(2, (sql) => {
      const n = sql.includes(`${exp.id}:a`) ? 150 : 40;
      return Array.from({ length: n }, (_, i) => ({ install: uuid(sql.includes(`${exp.id}:a`) ? "c" : "d", i), first: start + i * 60_000, si: 2 }));
    });
    const r = (await call(client, `${base}/${exp.id}/results`)).json;
    fetchMock.assertNoPendingInterceptors();
    expect(r.enoughData).toBe(false);
    expect(r.confident).toBeNull();
    expect(r.reasons).toEqual(["Running for 3 of at least 7 days.", "1 variant has fewer than 100 exposed installs.", "0 of at least 10 trial starts in total."]);
    expect(r.approximate).toBe(true);
    expect(r.notes.join(" ")).toContain("sampled");
    expect(r.variants.map((v: { exposed: number }) => v.exposed)).toEqual([150, 40]);
    expect((await call(client, `${base}/${exp.id}/archive`, { method: "POST" })).status).toBe(200);
  });

  it("snapshots daily exposures from the cron, recomputes results every few hours and stops experiments after 90 days", async () => {
    const owner = await ownerClient();
    const client = await workspace(owner, "Experiment cron WS");
    const { id } = await newApp(client, "com.example.exp.cron");
    expect((await call(client, `/api/v1/apps/${id}/config`, { method: "PUT", body: CONFIG })).status).toBe(200);
    const base = `/api/v1/apps/${id}/experiments`;
    const mk = async (name: string, key: string, value: unknown) => {
      const e = (await call(client, base, { body: { name, keys: [key], variants: [{}, { values: { [key]: value } }] } })).json;
      expect((await call(client, `${base}/${e.id}/start`, { method: "POST" })).status).toBe(200);
      return e.id as string;
    };
    const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
    const at = today + 3 * H + 5 * 60_000;
    const day = (n: number) => new Date(today - n * DAY).toISOString().slice(0, 10);
    const snap = await mk("Snapshot", "paywall_variant", "x");
    const old = await mk("Old", "trial_days", 1);
    await dbExec("UPDATE experiments SET started_at = ? WHERE id = ?", [today - 8 * DAY, snap]);
    await dbExec("UPDATE experiments SET started_at = ? WHERE id = ?", [at - 91 * DAY, old]);

    // Without event queries only the auto-stop runs (no query).
    const early = await cronExperiments(env, db(), today + H, null);
    expect(early).toEqual({ stopped: 1 });
    const o = (await call(client, `${base}/${old}`)).json;
    expect(o).toMatchObject({ status: "stopped", stoppedAt: o.startedAt + 90 * DAY });

    // Other ended experiments of this run are final already; `old` (stopped by the cron) gets its final results.
    await dbExec("UPDATE experiments SET frozen = 1 WHERE status != 'running' AND id != ?", [old]);
    // Other test files share this database: their running experiments and an earlier cron run today stay out of the way.
    await dbExec("UPDATE experiments SET snapshot_day = ?, results_at = ? WHERE status = 'running' AND id != ?", [day(0), at + DAY, snap]);
    await dbExec("DELETE FROM settings WHERE key = ?", [`experiments_snapshot_done:${day(0)}`]);
    resetWaeCache();
    let resultsQueries = 0;
    interceptSql(5, (sql) => {
      if (sql.includes(old)) return [];
      if (sql.includes("toStartOfDay")) {
        expect(sql).toContain(`blob17 IN ('${snap}:a', '${snap}:b')`);
        // Day 1 was sampled (1 stored event stands for 2): its counts are scaled.
        return [1, 2, 3].flatMap((n) => [
          { day: `${day(n)} 00:00:00`, v: `${snap}:a`, exposed: 40 + n, si: n === 1 ? 2 : 1 },
          { day: `${day(n)} 00:00:00`, v: `${snap}:b`, exposed: "38", si: 1 },
        ]);
      }
      resultsQueries++;
      return [{ install: uuid("e", sql.includes(`${snap}:a`) ? 1 : 2), first: today - 7 * DAY, si: 1 }];
    });
    const budget = new TickBudget(40);
    const log = await cronExperiments(env, db(), at, budget);
    fetchMock.assertNoPendingInterceptors();
    expect(log).toEqual({ snapshots: 1, results: 2 });
    expect(budget.used.sql).toBe(5);
    expect(resultsQueries).toBe(2);
    const final = await db().prepare("SELECT frozen, results FROM experiments WHERE id = ?").bind(old).first<{ frozen: number; results: string }>();
    expect(final!.frozen).toBe(1);
    expect(JSON.parse(final!.results)).toMatchObject({ frozen: true, exposureSource: "events", status: "stopped" });
    const { results: rows } = await db().prepare("SELECT variant, day, exposed, sample_interval FROM experiment_daily WHERE experiment_id = ? ORDER BY day, variant").bind(snap).all();
    expect(rows).toEqual([
      { variant: "a", day: day(3), exposed: 43, sample_interval: 1 },
      { variant: "b", day: day(3), exposed: 38, sample_interval: 1 },
      { variant: "a", day: day(2), exposed: 42, sample_interval: 1 },
      { variant: "b", day: day(2), exposed: 38, sample_interval: 1 },
      { variant: "a", day: day(1), exposed: 82, sample_interval: 2 },
      { variant: "b", day: day(1), exposed: 38, sample_interval: 1 },
    ]);
    // The results the cron computed (stored on the row and served by the route).
    const stored = await db().prepare("SELECT results, results_at FROM experiments WHERE id = ?").bind(snap).first<{ results: string; results_at: number }>();
    expect(stored!.results_at).toBe(at);
    const res = JSON.parse(stored!.results);
    expect(res.daily).toHaveLength(6);
    expect(res.variants.map((v: { exposed: number }) => v.exposed)).toEqual([1, 1]);
    expect(res.notes.join(" ")).toContain("scaled by the sample interval");
    expect((await call(client, `${base}/${snap}/results`)).json.generatedAt).toBe(at);
    // The next tick does nothing (snapshot done today, results fresh)...
    expect(await cronExperiments(env, db(), at + 5 * 60_000, new TickBudget(40))).toEqual({});
    // ...nor 5 hours later; after 6 hours the running experiment's results are recomputed (no snapshot).
    expect(await cronExperiments(env, db(), at + 5 * H, new TickBudget(40))).toEqual({});
    resetWaeCache();
    interceptSql(2, (sql) => [{ install: uuid("e", sql.includes(`${snap}:a`) ? 1 : 2), first: today - 7 * DAY, si: 1 }]);
    const later = new TickBudget(40);
    expect(await cronExperiments(env, db(), at + 6 * H, later)).toEqual({ results: 1 });
    fetchMock.assertNoPendingInterceptors();
    expect(later.used.sql).toBe(2);
    expect((await db().prepare("SELECT results_at FROM experiments WHERE id = ?").bind(snap).first<{ results_at: number }>())!.results_at).toBe(at + 6 * H);
    for (const e of [snap, old]) await call(client, `${base}/${e}/archive`, { method: "POST" });
    // Nothing left for later cron runs of this test run (insights tests count their queries).
    await dbExec("UPDATE experiments SET frozen = 1");
  });
});
