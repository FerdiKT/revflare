// Server-driven entitlements and non-renewing durations of an app (RevflareKit 1.9+ gets them inside
// GET /sdk/v1/offerings; docs/api.md#entitlements).
import { Hono } from "hono";
import { requirePermission, wsId, type AppEnv, type Ctx } from "../lib/auth";
import { changeEntitlements, readEntitlements, type EntitlementsOp } from "../lib/entitlements";
import { forgetSdkOfferings } from "../lib/sdk-cache";

export const entitlementRoutes = new Hono<AppEnv>();

async function body(c: Ctx): Promise<Record<string, unknown> | undefined> {
  const b = await c.req.json<unknown>().catch(() => undefined);
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : undefined;
}

async function change(c: Ctx, op: EntitlementsOp) {
  const r = await changeEntitlements(c.env, { workspaceId: wsId(c), appId: c.req.param("id")!, op });
  if ("error" in r) return c.json({ error: r.error }, r.status);
  await forgetSdkOfferings(r.sdkKey, c.req.url);
  return c.json(r.result, r.status);
}

const bad = (c: Ctx, shape: string) => c.json({ error: `Expected a JSON object ${shape}` }, 400);

entitlementRoutes.get("/apps/:id/entitlements", requirePermission("read"), async (c) => {
  const r = await readEntitlements(c.var.db, wsId(c), c.req.param("id"));
  return r ? c.json(r) : c.json({ error: "Not found" }, 404);
});

/** Replaces the parts present in the body: { entitlements?, durations? }. */
entitlementRoutes.put("/apps/:id/entitlements", requirePermission("manage"), async (c) => {
  const b = await body(c);
  return b ? change(c, { kind: "replace", body: b }) : bad(c, "{ entitlements?, durations? }");
});

/** { productIds: [...] }: sets the entitlement's products (creates it: 201). */
entitlementRoutes.put("/apps/:id/entitlements/:entitlement", requirePermission("manage"), async (c) => {
  const b = await body(c);
  return b ? change(c, { kind: "set", entitlement: c.req.param("entitlement"), productIds: b.productIds }) : bad(c, "{ productIds }");
});

entitlementRoutes.delete("/apps/:id/entitlements/:entitlement", requirePermission("manage"), (c) => change(c, { kind: "delete", entitlement: c.req.param("entitlement") }));

/** { productIds: [...] } or { productId }: adds products (creates the entitlement: 201). */
entitlementRoutes.post("/apps/:id/entitlements/:entitlement/products", requirePermission("manage"), async (c) => {
  const b = await body(c);
  return b ? change(c, { kind: "addProducts", entitlement: c.req.param("entitlement"), productIds: b.productIds ?? b.productId }) : bad(c, "{ productIds }");
});

entitlementRoutes.delete("/apps/:id/entitlements/:entitlement/products/:productId", requirePermission("manage"), (c) =>
  change(c, { kind: "removeProduct", entitlement: c.req.param("entitlement"), productId: c.req.param("productId") }),
);

/** { unit, count } or { duration: "3d" }: the duration of a non-renewing product (201 when new). */
entitlementRoutes.put("/apps/:id/durations/:productId", requirePermission("manage"), async (c) => {
  const b = await body(c);
  return b ? change(c, { kind: "setDuration", productId: c.req.param("productId"), duration: b.duration ?? b }) : bad(c, "{ unit, count }");
});

entitlementRoutes.delete("/apps/:id/durations/:productId", requirePermission("manage"), (c) => change(c, { kind: "deleteDuration", productId: c.req.param("productId") }));
