// Offerings and placements of an app (paywalls changed remotely; RevflareKit reads them at GET /sdk/v1/offerings).
import { Hono } from "hono";
import { requirePermission, wsId, type AppEnv, type Ctx } from "../lib/auth";
import { changeOfferings, readOfferings, type OfferingsOp } from "../lib/offerings";
import { forgetSdkOfferings } from "../lib/sdk-cache";

export const offeringRoutes = new Hono<AppEnv>();

async function body(c: Ctx): Promise<unknown> {
  return c.req.json<unknown>().catch(() => undefined);
}

async function change(c: Ctx, op: OfferingsOp) {
  const r = await changeOfferings(c.env, { workspaceId: wsId(c), appId: c.req.param("id")!, op });
  if ("error" in r) return c.json({ error: r.error }, r.status);
  await forgetSdkOfferings(r.sdkKey, c.req.url);
  return c.json(r.result, r.status);
}

const bad = (c: Ctx) => c.json({ error: "Expected a JSON object" }, 400);

offeringRoutes.get("/apps/:id/offerings", requirePermission("read"), async (c) => {
  const r = await readOfferings(c.var.db, wsId(c), c.req.param("id"));
  return r ? c.json(r) : c.json({ error: "Not found" }, 404);
});

/** Replaces the whole config (`revflare offerings <app> apply`). */
offeringRoutes.put("/apps/:id/offerings", requirePermission("manage"), async (c) => {
  const b = await body(c);
  return b === undefined ? bad(c) : change(c, { kind: "replace", body: b });
});

offeringRoutes.post("/apps/:id/offerings", requirePermission("manage"), async (c) => {
  const b = await body(c);
  return b === undefined ? bad(c) : change(c, { kind: "create", body: b });
});

offeringRoutes.patch("/apps/:id/offerings/:identifier", requirePermission("manage"), async (c) => {
  const b = await body(c);
  return b === undefined ? bad(c) : change(c, { kind: "update", identifier: c.req.param("identifier"), body: b });
});

/** 409 while placements point at it, unless ?force=true (they fall back to the current offering). */
offeringRoutes.delete("/apps/:id/offerings/:identifier", requirePermission("manage"), (c) => {
  const force = ["1", "true", "yes", ""].includes((c.req.query("force") ?? "false").toLowerCase());
  return change(c, { kind: "delete", identifier: c.req.param("identifier"), force });
});

offeringRoutes.post("/apps/:id/offerings/:identifier/current", requirePermission("manage"), (c) => change(c, { kind: "current", identifier: c.req.param("identifier") }));

/** { offeringId: "<offering>" | null } (null: the current offering). */
offeringRoutes.put("/apps/:id/placements/:identifier", requirePermission("manage"), async (c) => {
  const b = await body(c);
  if (!b || typeof b !== "object" || Array.isArray(b)) return bad(c);
  return change(c, { kind: "placement", identifier: c.req.param("identifier"), offeringId: (b as { offeringId?: unknown }).offeringId ?? null });
});

offeringRoutes.delete("/apps/:id/placements/:identifier", requirePermission("manage"), (c) => change(c, { kind: "deletePlacement", identifier: c.req.param("identifier") }));
