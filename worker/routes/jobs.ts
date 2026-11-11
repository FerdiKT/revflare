// Imports and backfills (Workflows) and imported history.
import { Hono } from "hono";
import type { Job } from "../../shared/types";
import { requirePermission, wsId, type AppEnv } from "../lib/auth";
import { seedDemo } from "../lib/demo";
import { EXTERNAL_METRICS, externalMetricsSummary, storeExternalMetrics } from "../lib/revenuecat";
import { now, parseJson } from "../lib/util";
import { startJob } from "../lib/jobs";
import { bumpDataVersion } from "../lib/metrics";

export const jobRoutes = new Hono<AppEnv>();

interface JobRow {
  id: string;
  kind: string;
  status: Job["status"];
  params: string;
  progress: string;
  error: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

const toJob = (r: JobRow): Job => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  params: parseJson(r.params, {}),
  progress: parseJson(r.progress, {}),
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  finishedAt: r.finished_at,
});

jobRoutes.get("/jobs", requirePermission("read"), async (c) => {
  const { results } = await c.var.db.prepare("SELECT * FROM jobs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100").bind(wsId(c)).all<JobRow>();
  return c.json({ items: results.map(toJob) });
});

jobRoutes.get("/jobs/:id", requirePermission("read"), async (c) => {
  const r = await c.var.db.prepare("SELECT * FROM jobs WHERE id = ? AND workspace_id = ?").bind(c.req.param("id"), wsId(c)).first<JobRow>();
  return r ? c.json(toJob(r)) : c.json({ error: "Not found" }, 404);
});

jobRoutes.post("/jobs/:id/cancel", requirePermission("manage"), async (c) => {
  const r = await c.var.db.prepare("SELECT id FROM jobs WHERE id = ? AND workspace_id = ? AND status IN ('queued', 'running')").bind(c.req.param("id"), wsId(c)).first();
  if (!r) return c.json({ error: "Not found or finished" }, 404);
  try {
    await (await c.env.IMPORT_WORKFLOW.get(c.req.param("id"))).terminate();
  } catch {}
  await c.var.db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?").bind(now(), now(), c.req.param("id")).run();
  return c.json({ ok: true });
});

/** Full Apple backfill (180 days of notifications + customers' transaction histories), one job per app. */
jobRoutes.post("/imports/apple", requirePermission("manage"), async (c) => {
  const body = await c.req.json<{ appIds?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const db = c.var.db;
  const ids = Array.isArray(body.appIds) ? body.appIds.filter((x): x is string => typeof x === "string") : null;
  const { results } = await db
    .prepare(`SELECT id FROM apps WHERE workspace_id = ? AND archived = 0 AND platform = 'ios' AND bundle_id IS NOT NULL${ids?.length ? ` AND id IN (${ids.map(() => "?").join(",")})` : ""}`)
    .bind(wsId(c), ...(ids ?? []))
    .all<{ id: string }>();
  const jobs = [];
  for (const a of results) jobs.push({ appId: a.id, ...(await startJob(c.env, db, wsId(c), "apple_backfill", { appId: a.id }, c.var.user.id)) });
  return c.json({ jobs });
});

jobRoutes.post("/imports/revenuecat", requirePermission("manage"), async (c) => {
  const body = await c.req.json<{ credentialId?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  if (typeof body.credentialId !== "string") return c.json({ error: "credentialId is required" }, 400);
  const cred = await c.var.db.prepare("SELECT id FROM credentials WHERE id = ? AND workspace_id = ? AND kind = 'revenuecat'").bind(body.credentialId, wsId(c)).first();
  if (!cred) return c.json({ error: "RevenueCat credential not found" }, 404);
  return c.json(await startJob(c.env, c.var.db, wsId(c), "revenuecat_discovery", { credentialId: body.credentialId }, c.var.user.id));
});

jobRoutes.post("/imports/sales-reports", requirePermission("manage"), async (c) => {
  const body = await c.req.json<{ days?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const days = Math.min(Math.max(Number(body.days) || 30, 1), 365);
  return c.json(await startJob(c.env, c.var.db, wsId(c), "sales_reports", { days }, c.var.user.id));
});

jobRoutes.post("/imports/fx", requirePermission("manage"), async (c) => {
  const body = await c.req.json<{ from?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const from = typeof body.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.from) ? body.from : "2019-01-01";
  return c.json(await startJob(c.env, c.var.db, wsId(c), "fx_backfill", { from }, c.var.user.id));
});

/**
 * Imported daily history for one app (RevenueCat Charts via `revflare import revenuecat-charts`). Money in USD.
 * Body: { appId, source?, metric, points: [{ day: "YYYY-MM-DD", value }] }
 */
jobRoutes.post("/imports/external-metrics", requirePermission("manage"), async (c) => {
  const body = await c.req.json<{ appId?: unknown; source?: unknown; metric?: unknown; points?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const metric = EXTERNAL_METRICS.find((m) => m === body.metric);
  if (!metric) return c.json({ error: `metric must be one of ${EXTERNAL_METRICS.join(", ")}` }, 400);
  if (typeof body.appId !== "string" || !Array.isArray(body.points)) return c.json({ error: "appId and points are required" }, 400);
  if (body.points.length > 5000) return c.json({ error: "At most 5000 points per request" }, 400);
  const points = body.points
    .filter((p): p is { day: string; value: number } => !!p && typeof p === "object" && typeof (p as { day?: unknown }).day === "string" && typeof (p as { value?: unknown }).value === "number")
    .map((p) => ({ day: p.day, value: p.value }));
  const source = typeof body.source === "string" && /^[a-z_]{2,20}$/.test(body.source) ? body.source : "revenuecat";
  try {
    const r = await storeExternalMetrics(c.env, { workspaceId: wsId(c), appId: body.appId, source, metric, points });
    if (r.budget) return c.json({ error: "Today's database budget for imports is used up (Cloudflare free plan). Continue after 00:00 UTC.", code: "budget" }, 429);
    return c.json(r);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 404);
  }
});

jobRoutes.get("/imports/external-metrics", requirePermission("read"), async (c) =>
  c.json(await externalMetricsSummary(c.env, { workspaceId: wsId(c), appId: c.req.query("appId") ?? null, source: c.req.query("source") ?? "revenuecat" })),
);

jobRoutes.delete("/imports/external-metrics", requirePermission("manage"), async (c) => {
  const appId = c.req.query("appId");
  const source = c.req.query("source") ?? "revenuecat";
  await c.var.db
    .prepare(`DELETE FROM external_metrics WHERE workspace_id = ? AND source = ?${appId ? " AND app_id = ?" : ""}`)
    .bind(wsId(c), source, ...(appId ? [appId] : []))
    .run();
  await c.var.db
    .prepare(`UPDATE apps SET external_until = NULL WHERE workspace_id = ?${appId ? " AND id = ?" : ""}`)
    .bind(wsId(c), ...(appId ? [appId] : []))
    .run();
  await bumpDataVersion(c.var.db, wsId(c));
  return c.json({ ok: true });
});

/** Local development only (DEV_SEED="true" in .dev.vars): fills the workspace with synthetic apps and sales. */
jobRoutes.post("/dev/seed", requirePermission("manage"), async (c) => {
  if (c.env.DEV_SEED !== "true") return c.json({ error: "Not found" }, 404);
  return c.json(await seedDemo(c.env, { workspaceId: wsId(c) }));
});
