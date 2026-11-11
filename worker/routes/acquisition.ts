// App Store acquisition (Apple's App Analytics reports): where installs and App Store revenue come from.
import { Hono } from "hono";
import type { AcquisitionDimension } from "../../shared/types";
import { ensureAcquisitionRequests, syncAcquisition } from "../apple/analytics";
import { ACQUISITION_DIMENSIONS, acquisition, acquisitionCampaigns, acquisitionStatus } from "../lib/acquisition";
import { requirePermission, wsId, type AppEnv } from "../lib/auth";
import { startJob } from "../lib/jobs";
import { range, scope } from "./metrics";

export const acquisitionRoutes = new Hono<AppEnv>();

const ALIASES: Record<string, AcquisitionDimension> = { source: "source", sources: "source", source_type: "source", referrer: "referrer", referrers: "referrer", source_info: "referrer", campaign: "campaign", campaigns: "campaign", day: "day", days: "day", app: "app", apps: "app" };

const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 90) : null);

/** ?by=source|referrer|campaign|day|app (comma-separated for several, e.g. day,source). Default source. */
acquisitionRoutes.get("/acquisition", requirePermission("read"), async (c) => {
  const raw = (c.req.query("by") ?? "source").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const by = raw.map((r) => ALIASES[r]);
  if (by.some((d) => !d)) return c.json({ error: `by must be one or more of ${ACQUISITION_DIMENSIONS.join(", ")}` }, 400);
  const { from, to } = range(c, 30);
  const limit = Number(c.req.query("limit")) || undefined;
  return c.json(await acquisition(c.env, { ...scope(c), from, to, by, limit }));
});

acquisitionRoutes.get("/acquisition/campaigns", requirePermission("read"), async (c) => c.json(await acquisitionCampaigns(c.env, scope(c))));

acquisitionRoutes.get("/acquisition/status", requirePermission("read"), async (c) => c.json(await acquisitionStatus(c.env, scope(c))));

/**
 * Creates (or finds) the ONGOING App Analytics report request of each app; bounded per call (`remaining` > 0: call
 * again). Needs an App Store Connect key with the Admin role (reading the reports works with Sales).
 */
acquisitionRoutes.post("/acquisition/requests", requirePermission("manage"), async (c) => {
  const body = await c.req.json<{ appIds?: unknown; limit?: unknown; retry?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const r = await ensureAcquisitionRequests(c.env, { workspaceId: wsId(c), appIds: ids(body.appIds), limit: Number(body.limit) || 10, retry: body.retry !== false });
  return r.error ? c.json(r, 400) : c.json(r);
});

/** One bounded import round now (new report instances of the least recently checked apps). */
acquisitionRoutes.post("/acquisition/sync", requirePermission("manage"), async (c) => {
  const body = await c.req.json<{ appIds?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const r = await syncAcquisition(c.env, { workspaceId: wsId(c), appIds: ids(body.appIds), maxRequests: 40, maxApps: 10 });
  if (r.budget && !r.instances) return c.json({ ...r, error: "Today's database budget for imports is used up (Cloudflare free plan). Continue after 00:00 UTC.", code: "budget" }, 429);
  return c.json(r);
});

/** Full import in the background (a job): requests for every app, then every report instance Apple has. */
acquisitionRoutes.post("/imports/acquisition", requirePermission("manage"), async (c) => c.json(await startJob(c.env, c.var.db, wsId(c), "acquisition", {}, c.var.user.id)));
