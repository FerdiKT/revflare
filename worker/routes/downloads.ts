// App Store downloads (Apple's Sales and Trends reports): first downloads, redownloads and updates per day, app,
// country and device, with what they turned into (trials, payers, revenue per download, Apple Ads share).
import { Hono } from "hono";
import { requirePermission, wsId, type AppEnv } from "../lib/auth";
import { downloads } from "../lib/downloads";
import { startJob } from "../lib/jobs";
import { range, scope } from "./metrics";

export const downloadRoutes = new Hono<AppEnv>();

/** ?apps=&range=7d|28d|90d|...|from=&to=. A preset range ends at the newest report day (about a day behind). */
downloadRoutes.get("/downloads", requirePermission("read"), async (c) => {
  const { from, to } = range(c, 28);
  return c.json(await downloads(c.env, { ...scope(c), from, to, fixedTo: !!c.req.query("to") }));
});

/** Downloads the missing Sales and Trends days (up to 365 back) in the background: POST { days }. */
downloadRoutes.post("/downloads/sync", requirePermission("manage"), async (c) => {
  const body = await c.req.json<{ days?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const days = Math.min(Math.max(Number(body.days) || 90, 1), 365);
  return c.json(await startJob(c.env, c.var.db, wsId(c), "sales_reports", { days }, c.var.user.id));
});
