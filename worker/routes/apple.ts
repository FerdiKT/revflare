// Public endpoint for App Store Server Notifications V2: POST /apple/notifications/:key
import { Hono } from "hono";
import { forwardNotification } from "../apple/forward";
import { ingestNotification } from "../apple/ingest";
import type { AppEnv } from "../lib/auth";
import { sendConsumptionInfo } from "../lib/refunds";

export const appleRoutes = new Hono<AppEnv>();

appleRoutes.post("/notifications/:key", async (c) => {
  const raw = await c.req.text();
  const body = (() => {
    try {
      return JSON.parse(raw) as { signedPayload?: unknown };
    } catch {
      return null;
    }
  })();
  if (!body || typeof body.signedPayload !== "string" || body.signedPayload.length > 200_000) return c.json({ error: "Expected { signedPayload }" }, 400);
  const r = await ingestNotification(c.env, { key: c.req.param("key"), signedPayload: body.signedPayload });
  // Apple retries non-200 answers: only transient failures (thrown errors → 500) should be retried.
  if (r.status !== 200) return c.json({ error: r.error }, r.status as 400 | 404);
  // Verified: pass the notification on unchanged (e.g. to RevenueCat) after answering Apple.
  if (r.forwardUrl && r.appId) c.executionCtx.waitUntil(forwardNotification(c.env, { appId: r.appId, url: r.forwardUrl, body: raw }));
  // A refund request (CONSUMPTION_REQUEST): try to answer at once; the cron retries what is left.
  if (r.consumptionRequest && r.appId) {
    c.executionCtx.waitUntil(sendConsumptionInfo(c.env, { appId: r.appId }).catch((err) => console.error("consumption answer failed", err)));
  }
  return c.json({ ok: true, ...(r.duplicate ? { duplicate: true } : {}) });
});
