// A/B experiments on remote config parameters (docs/experiments.md).
import { Hono } from "hono";
import { requirePermission, wsId, type AppEnv, type Ctx } from "../lib/auth";
import { changeExperiment, experimentResults, experimentRow, listExperiments, toExperiment, type ExperimentOp } from "../lib/experiments";
import { forgetSdkRemoteConfig } from "../lib/sdk-cache";

export const experimentRoutes = new Hono<AppEnv>();

async function change(c: Ctx, op: ExperimentOp) {
  const r = await changeExperiment(c.env, { workspaceId: wsId(c), appId: c.req.param("id")!, op });
  if ("error" in r) return c.json({ error: r.error }, r.status);
  if (r.payloadChanged) await forgetSdkRemoteConfig(r.sdkKey, c.req.url);
  return c.json(r.experiment ?? { ok: true }, r.status);
}

const body = (c: Ctx) => c.req.json<unknown>().catch(() => undefined);

experimentRoutes.get("/apps/:id/experiments", requirePermission("read"), async (c) => {
  const app = await c.var.db.prepare("SELECT id FROM apps WHERE id = ? AND workspace_id = ?").bind(c.req.param("id"), wsId(c)).first<{ id: string }>();
  if (!app) return c.json({ error: "Not found" }, 404);
  return c.json({ items: await listExperiments(c.var.db, wsId(c), app.id) });
});

experimentRoutes.post("/apps/:id/experiments", requirePermission("manage"), async (c) => change(c, { kind: "create", body: await body(c) }));

experimentRoutes.get("/apps/:id/experiments/:eid", requirePermission("read"), async (c) => {
  const r = await experimentRow(c.var.db, wsId(c), c.req.param("id"), c.req.param("eid"));
  return r ? c.json(toExperiment(r)) : c.json({ error: "Not found" }, 404);
});

experimentRoutes.patch("/apps/:id/experiments/:eid", requirePermission("manage"), async (c) => change(c, { kind: "update", id: c.req.param("eid"), body: await body(c) }));

experimentRoutes.delete("/apps/:id/experiments/:eid", requirePermission("manage"), async (c) => change(c, { kind: "delete", id: c.req.param("eid") }));

experimentRoutes.post("/apps/:id/experiments/:eid/start", requirePermission("manage"), (c) => change(c, { kind: "start", id: c.req.param("eid") }));

experimentRoutes.post("/apps/:id/experiments/:eid/archive", requirePermission("manage"), (c) => change(c, { kind: "archive", id: c.req.param("eid") }));

experimentRoutes.post("/apps/:id/experiments/:eid/rollout", requirePermission("manage"), async (c) => {
  const b = (await body(c)) as { variant?: unknown } | undefined;
  if (!b || typeof b.variant !== "string") return c.json({ error: 'Expected { "variant": "b" }' }, 400);
  return change(c, { kind: "rollout", id: c.req.param("eid"), variant: b.variant });
});

/** Stops the experiment: devices keep their variant; the next results read (or the daily cron) freezes the results. */
experimentRoutes.post("/apps/:id/experiments/:eid/stop", requirePermission("manage"), (c) => change(c, { kind: "stop", id: c.req.param("eid") }));

/** Results: the stored ones (computed by the cron every few hours), computed here only when none are stored yet. */
experimentRoutes.get("/apps/:id/experiments/:eid/results", requirePermission("read"), async (c) => {
  const r = await experimentResults(c.env, wsId(c), c.req.param("id"), c.req.param("eid"));
  return "error" in r ? c.json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, r.status) : c.json(r.results);
});

/** Recomputes the results now: at most once an hour per experiment, within the daily background budget (429 otherwise). */
experimentRoutes.post("/apps/:id/experiments/:eid/results/refresh", requirePermission("read"), async (c) => {
  const r = await experimentResults(c.env, wsId(c), c.req.param("id"), c.req.param("eid"), { mode: "refresh" });
  if (!("error" in r)) return c.json(r.results);
  if (r.retryAfter) c.header("Retry-After", String(r.retryAfter));
  return c.json({ error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.retryAfter ? { retryAfter: r.retryAfter } : {}) }, r.status);
});
