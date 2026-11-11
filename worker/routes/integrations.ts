// Per-app integrations. Meta Ads: purchases go to Meta's Conversions API as app events (worker/lib/meta.ts). Refund
// requests: answers to Apple's CONSUMPTION_REQUEST notifications (worker/lib/refunds.ts).
import { Hono } from "hono";
import { requirePermission, wsId, type AppEnv } from "../lib/auth";
import { parseRefundUpdate, refundDefaultsView, refundRequestLog, refundSettingsView, saveRefundSettings, setRefundConsent } from "../lib/refunds";
import { backfillMetaEvents, metaDeliveryLog, metaIntegrationView, parseMetaUpdate, saveMetaIntegration, sendMetaTestEvent } from "../lib/meta";

export const integrationRoutes = new Hono<AppEnv>();

async function appOf(c: { var: AppEnv["Variables"] }, id: string) {
  return c.var.db.prepare("SELECT id, platform FROM apps WHERE id = ? AND workspace_id = ?").bind(id, c.var.workspace!.id).first<{ id: string; platform: string }>();
}

integrationRoutes.get("/apps/:id/integrations/meta", requirePermission("read"), async (c) => {
  const app = await appOf(c, c.req.param("id"));
  if (!app) return c.json({ error: "Not found" }, 404);
  return c.json(await metaIntegrationView(c.var.db, app.id));
});

/** Partial update. accessToken is write-only ("" or null clears it). Turning it on the first time queues the last 7 days. */
integrationRoutes.put("/apps/:id/integrations/meta", requirePermission("manage"), async (c) => {
  const app = await appOf(c, c.req.param("id"));
  if (!app) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Expected a JSON object" }, 400);
  const update = parseMetaUpdate(body);
  if ("error" in update) return c.json({ error: update.error }, 400);
  const r = await saveMetaIntegration(c.env, c.var.db, app.id, update);
  if (r.error) return c.json({ error: r.error }, 400);
  if (r.firstEnabled) await backfillMetaEvents(c.env, { appId: app.id }).catch(() => null);
  return c.json(await metaIntegrationView(c.var.db, app.id));
});

integrationRoutes.post("/apps/:id/integrations/meta/test", requirePermission("manage"), async (c) => {
  const app = await appOf(c, c.req.param("id"));
  if (!app) return c.json({ error: "Not found" }, 404);
  const r = await sendMetaTestEvent(c.env, { appId: app.id, ip: c.req.header("cf-connecting-ip") ?? null, userAgent: c.req.header("user-agent") ?? null });
  if ("error" in r) return c.json(r, r.status ? 502 : 400);
  return c.json(r);
});

integrationRoutes.get("/apps/:id/integrations/meta/log", requirePermission("read"), async (c) => {
  const app = await appOf(c, c.req.param("id"));
  if (!app) return c.json({ error: "Not found" }, 404);
  const limit = Number(c.req.query("limit")) || undefined;
  return c.json({ items: await metaDeliveryLog(c.var.db, app.id, limit) });
});

/** Queues the app's transactions of the last 7 days again (failed and skipped ones included; sent ones are never resent). */
integrationRoutes.post("/apps/:id/integrations/meta/backfill", requirePermission("manage"), async (c) => {
  const app = await appOf(c, c.req.param("id"));
  if (!app) return c.json({ error: "Not found" }, 404);
  const r = await backfillMetaEvents(c.env, { appId: app.id });
  if ("budget" in r) return c.json({ error: "Today's database budget for background work is used up (Cloudflare free plan). Try again after 00:00 UTC.", code: "budget" }, 429);
  return c.json(r);
});

// Refund requests: answers to Apple's CONSUMPTION_REQUEST notifications (worker/lib/refunds.ts).

integrationRoutes.get("/apps/:id/integrations/refunds", requirePermission("read"), async (c) => {
  const app = await appOf(c, c.req.param("id"));
  if (!app) return c.json({ error: "Not found" }, 404);
  return c.json(await refundSettingsView(c.var.db, app.id));
});

/** Partial update. Turning answers on needs the consent attestation (consentAttested: true, recorded with who and when). */
integrationRoutes.put("/apps/:id/integrations/refunds", requirePermission("manage"), async (c) => {
  const app = await appOf(c, c.req.param("id"));
  if (!app) return c.json({ error: "Not found" }, 404);
  if (app.platform !== "ios") return c.json({ error: "Refund requests (Apple's CONSUMPTION_REQUEST) are App Store only: not available for Android (Google Play) or web (Polar) apps" }, 400);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Expected a JSON object" }, 400);
  const update = parseRefundUpdate(body);
  if ("error" in update) return c.json({ error: update.error }, 400);
  if (body.useDefaults !== undefined && typeof body.useDefaults !== "boolean") return c.json({ error: "useDefaults must be true or false" }, 400);
  const user = c.var.user;
  const r = await saveRefundSettings(c.var.db, { appId: app.id }, { ...update, useDefaults: body.useDefaults === true }, `${user.name} <${user.email}>`);
  if (r.error) return c.json({ error: r.error }, 400);
  return c.json(await refundSettingsView(c.var.db, app.id));
});

/** Workspace defaults: every App Store app without its own refund settings (new apps too) uses them. */
integrationRoutes.get("/integrations/refunds/defaults", requirePermission("read"), async (c) => c.json(await refundDefaultsView(c.var.db, wsId(c))));

integrationRoutes.put("/integrations/refunds/defaults", requirePermission("manage"), async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Expected a JSON object" }, 400);
  const update = parseRefundUpdate(body);
  if ("error" in update) return c.json({ error: update.error }, 400);
  const user = c.var.user;
  const r = await saveRefundSettings(c.var.db, { workspaceId: wsId(c) }, update, `${user.name} <${user.email}>`);
  if (r.error) return c.json({ error: r.error }, 400);
  return c.json(await refundDefaultsView(c.var.db, wsId(c)));
});

integrationRoutes.get("/apps/:id/integrations/refunds/log", requirePermission("read"), async (c) => {
  const app = await appOf(c, c.req.param("id"));
  if (!app) return c.json({ error: "Not found" }, 404);
  const limit = Number(c.req.query("limit")) || undefined;
  return c.json({ items: await refundRequestLog(c.var.db, app.id, limit) });
});

/** A customer withdraws (false) or gives back (true) consent to share consumption data with Apple. */
integrationRoutes.put("/customers/:id/refund-consent", requirePermission("manage"), async (c) => {
  const body = await c.req.json<{ consent?: unknown }>().catch(() => null);
  if (!body || typeof body.consent !== "boolean") return c.json({ error: "Expected { consent: true | false }" }, 400);
  if (!(await setRefundConsent(c.var.db, c.var.workspace!.id, c.req.param("id"), body.consent))) return c.json({ error: "Not found" }, 404);
  return c.json({ id: c.req.param("id"), refundDataConsent: body.consent });
});
