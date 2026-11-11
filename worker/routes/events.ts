// App events and funnels (RevflareKit events in Workers Analytics Engine; docs/funnels.md).
import { Hono } from "hono";
import { TEST_INSTALLS_LIMIT, type AnalyticsStatus, type TestDevices } from "../../shared/types";
import { requirePermission, wsId, type AppEnv, type Ctx } from "../lib/auth";
import { eventSummary, parseRangeDays, SUMMARY_MAX_DAYS } from "../lib/event-summary";
import { forgetSdkApp, lastEventKey, lastTestEventKey } from "../lib/events";
import { keyEventSettings, updateKeyEventSettings } from "../lib/key-events";
import { createFunnel, deleteFunnel, funnelReport, getFunnel, listFunnels, parseReportQuery, updateFunnel } from "../lib/funnels";
import { getSetting } from "../lib/settings";
import { bumpDataVersion } from "../lib/metrics";
import { parseTestInstalls, validateTestInstalls } from "../lib/test-data";
import { AnalyticsError, analyticsMissing, datasetName, SqlValueError, type TestFilter } from "../lib/wae";

export const eventRoutes = new Hono<AppEnv>();

async function appOf(c: Ctx) {
  return c.var.db
    .prepare("SELECT id, sdk_key, test_installs FROM apps WHERE id = ? AND workspace_id = ?")
    .bind(c.req.param("id"), wsId(c))
    .first<{ id: string; sdk_key: string | null; test_installs: string | null }>();
}

const flag = (v: string | undefined) => v !== undefined && ["1", "true", "yes", ""].includes(v.toLowerCase());

/** ?includeTest=true counts sandbox / Xcode builds and the app's test devices; production data from other devices otherwise. */
const testFilter = (c: Ctx, testInstalls: string | null): TestFilter => (flag(c.req.query("includeTest")) ? { includeTest: true } : { excludedInstalls: parseTestInstalls(testInstalls) });

const origin = (c: Ctx) => new URL(c.req.url).origin;

function analyticsFailure(c: Ctx, err: unknown) {
  if (err instanceof AnalyticsError) return c.json({ error: err.message, code: err.code }, err.status);
  if (err instanceof SqlValueError) return c.json({ error: err.message }, 400);
  throw err;
}

eventRoutes.get("/apps/:id/analytics/status", requirePermission("read"), async (c) => {
  const app = await appOf(c);
  if (!app) return c.json({ error: "Not found" }, 404);
  const m = analyticsMissing(c.env);
  const [last, lastTest] = await Promise.all([getSetting(c.var.db, lastEventKey(app.id)), getSetting(c.var.db, lastTestEventKey(app.id))]);
  let dataset = "revflare_events";
  try {
    dataset = datasetName(c.env);
  } catch {}
  return c.json({ ingest: m.ingest, query: m.query, dataset, missing: m.missing, lastEventAt: last ? Number(last) : null, lastTestEventAt: lastTest ? Number(lastTest) : null, sdkKey: app.sdk_key } satisfies AnalyticsStatus);
});

eventRoutes.get("/apps/:id/events/summary", requirePermission("read"), async (c) => {
  const app = await appOf(c);
  if (!app) return c.json({ error: "Not found" }, 404);
  const days = parseRangeDays(c.req.query("range"));
  if (days === null) return c.json({ error: `range must be 1d to ${SUMMARY_MAX_DAYS}d (e.g. 7d, 30d)` }, 400);
  try {
    return c.json(await eventSummary(c.env, app.id, days, { origin: origin(c), test: testFilter(c, app.test_installs) }));
  } catch (err) {
    return analyticsFailure(c, err);
  }
});

eventRoutes.get("/apps/:id/funnels", requirePermission("read"), async (c) => {
  const app = await appOf(c);
  if (!app) return c.json({ error: "Not found" }, 404);
  return c.json({ items: await listFunnels(c.var.db, wsId(c), app.id) });
});

eventRoutes.post("/apps/:id/funnels", requirePermission("manage"), async (c) => {
  const app = await appOf(c);
  if (!app) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<unknown>().catch(() => undefined);
  const r = await createFunnel(c.var.db, wsId(c), app.id, body);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  return c.json(r.funnel, 201);
});

eventRoutes.get("/apps/:id/funnels/:fid", requirePermission("read"), async (c) => {
  const f = await getFunnel(c.var.db, wsId(c), c.req.param("id"), c.req.param("fid"));
  return f ? c.json(f) : c.json({ error: "Not found" }, 404);
});

eventRoutes.patch("/apps/:id/funnels/:fid", requirePermission("manage"), async (c) => {
  const body = await c.req.json<unknown>().catch(() => undefined);
  const r = await updateFunnel(c.var.db, wsId(c), c.req.param("id"), c.req.param("fid"), body);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  return c.json(r.funnel);
});

eventRoutes.delete("/apps/:id/funnels/:fid", requirePermission("manage"), async (c) => {
  const ok = await deleteFunnel(c.var.db, wsId(c), c.req.param("id"), c.req.param("fid"));
  return ok ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
});

eventRoutes.get("/apps/:id/funnels/:fid/report", requirePermission("read"), async (c) => {
  const [app, f] = await Promise.all([appOf(c), getFunnel(c.var.db, wsId(c), c.req.param("id"), c.req.param("fid"))]);
  if (!f || !app) return c.json({ error: "Not found" }, 404);
  const args = parseReportQuery({ from: c.req.query("from"), to: c.req.query("to"), range: c.req.query("range"), breakdown: c.req.query("breakdown") });
  if ("error" in args) return c.json({ error: args.error }, 400);
  try {
    return c.json(await funnelReport(c.env, f, { ...args, test: testFilter(c, app.test_installs) }, { origin: origin(c) }));
  } catch (err) {
    return analyticsFailure(c, err);
  }
});

/**
 * Test devices: install ids left out of events, funnels, experiments, insights, LTV, attributed revenue and Meta
 * sending (with sandbox / Xcode builds, docs/funnels.md#test-data). PUT replaces the list ({ installIds }, at most 50).
 */
eventRoutes.get("/apps/:id/test-devices", requirePermission("read"), async (c) => {
  const app = await appOf(c);
  if (!app) return c.json({ error: "Not found" }, 404);
  return c.json({ appId: app.id, installIds: parseTestInstalls(app.test_installs), limit: TEST_INSTALLS_LIMIT } satisfies TestDevices);
});

eventRoutes.put("/apps/:id/test-devices", requirePermission("manage"), async (c) => {
  const app = await appOf(c);
  if (!app) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<{ installIds?: unknown }>().catch(() => null);
  const ids = validateTestInstalls(body?.installIds);
  if ("error" in ids) return c.json({ error: ids.error }, 400);
  if (JSON.stringify(ids) !== JSON.stringify(parseTestInstalls(app.test_installs))) {
    await c.var.db.prepare("UPDATE apps SET test_installs = ? WHERE id = ?").bind(ids.length ? JSON.stringify(ids) : null, app.id).run();
    // Attributed revenue and LTV are cached by data version.
    await bumpDataVersion(c.var.db, wsId(c));
  }
  return c.json({ appId: app.id, installIds: ids, limit: TEST_INSTALLS_LIMIT } satisfies TestDevices);
});

/**
 * Key events stored exactly (docs/funnels.md#exact-key-events): built-in names, the app's extra patterns (≤ 20), daily
 * cap, retention, coverage start and today's count. PUT { patterns?, dailyCap?, retentionDays? } (manage); other
 * isolates pick the change up within 5 minutes (SDK key cache).
 */
eventRoutes.get("/apps/:id/key-events", requirePermission("read"), async (c) => {
  const app = await appOf(c);
  if (!app) return c.json({ error: "Not found" }, 404);
  return c.json(await keyEventSettings(c.env, c.var.db, app.id));
});

eventRoutes.put("/apps/:id/key-events", requirePermission("manage"), async (c) => {
  const app = await appOf(c);
  if (!app) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<unknown>().catch(() => null);
  const r = await updateKeyEventSettings(c.env, c.var.db, app.id, body);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  forgetSdkApp(app.sdk_key);
  return c.json(r);
});
