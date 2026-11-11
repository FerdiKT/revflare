// Remote config of an app (like Firebase Remote Config; RevflareKit reads the device's values at GET /sdk/v1/config).
import { Hono } from "hono";
import type { RemoteConfigEvaluateInput } from "../../shared/types";
import { requirePermission, wsId, type AppEnv, type Ctx } from "../lib/auth";
import { activeExperiments, changeRemoteConfig, compile, configView, deviceContext, evaluate, readRemoteConfig, type RemoteConfigOp } from "../lib/remote-config";
import { forgetSdkRemoteConfig } from "../lib/sdk-cache";
import { attributionOptions } from "../lib/attribution";
import { dayOf } from "../lib/money";
import { now } from "../lib/util";

export const remoteConfigRoutes = new Hono<AppEnv>();

const MAX_BODY = 2 * 1024 * 1024;

async function body(c: Ctx): Promise<unknown> {
  if (Number(c.req.header("content-length") ?? 0) > MAX_BODY) return undefined;
  return c.req.json<unknown>().catch(() => undefined);
}

const flag = (v: string | undefined) => v !== undefined && ["1", "true", "yes", ""].includes(v.toLowerCase());

async function change(c: Ctx, op: RemoteConfigOp) {
  const r = await changeRemoteConfig(c.env, { workspaceId: wsId(c), appId: c.req.param("id")!, op });
  if ("error" in r) return c.json({ error: r.error }, r.status);
  if (r.changed) await forgetSdkRemoteConfig(r.sdkKey, c.req.url);
  return c.json(r.result);
}

remoteConfigRoutes.get("/apps/:id/config", requirePermission("read"), async (c) => {
  const r = await readRemoteConfig(c.var.db, wsId(c), c.req.param("id"));
  return r ? c.json(configView(r.config, r.updatedAt)) : c.json({ error: "Not found" }, 404);
});

/** Replaces the whole config atomically (`revflare config <app> apply`). */
remoteConfigRoutes.put("/apps/:id/config", requirePermission("manage"), async (c) => {
  const b = await body(c);
  return b === undefined ? c.json({ error: "Expected a JSON object { conditions, parameters }" }, 400) : change(c, { kind: "replace", body: b });
});

/** Converts a Firebase Remote Config template; ?dryRun=true only previews, ?merge=true merges parameters by key. */
remoteConfigRoutes.post("/apps/:id/config/import-firebase", requirePermission("manage"), async (c) => {
  const b = await body(c);
  if (b === undefined) return c.json({ error: "Expected the Firebase Remote Config template as JSON" }, 400);
  return change(c, { kind: "import", template: b, merge: flag(c.req.query("merge")), dryRun: flag(c.req.query("dryRun")) });
});

/** "Preview as": the values a device would get, and which condition each parameter's value came from. */
remoteConfigRoutes.post("/apps/:id/config/evaluate", requirePermission("read"), async (c) => {
  const b = ((await body(c)) ?? {}) as RemoteConfigEvaluateInput;
  if (!b || typeof b !== "object" || Array.isArray(b)) return c.json({ error: "Expected a JSON object" }, 400);
  const r = await readRemoteConfig(c.var.db, wsId(c), c.req.param("id"));
  if (!r) return c.json({ error: "Not found" }, 404);
  // Running and stopped experiments too: the preview shows the variant the install id gets.
  const experiments = await activeExperiments(c.var.db, c.req.param("id"));
  return c.json(await evaluate(compile(r.config, experiments), deviceContext(b as Record<string, unknown>, b.ipCountry)));
});

/** Apple Ads ids seen in the app's installs (?days=30, 1 to 90) for the condition editor's pickers. */
remoteConfigRoutes.get("/apps/:id/config/attribution-options", requirePermission("read"), async (c) => {
  const app = await c.var.db.prepare("SELECT id FROM apps WHERE id = ? AND workspace_id = ?").bind(c.req.param("id"), wsId(c)).first<{ id: string }>();
  if (!app) return c.json({ error: "Not found" }, 404);
  const days = Number(c.req.query("days") ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 90) return c.json({ error: "days must be 1 to 90" }, 400);
  return c.json(await attributionOptions(c.env, { workspaceId: wsId(c), appId: app.id, days, day: dayOf(now()) }));
});
