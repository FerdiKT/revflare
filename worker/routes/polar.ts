// Public endpoint for Polar webhooks (Standard Webhooks signatures): POST /polar/webhooks/:key
import { Hono } from "hono";
import { ingestPolarWebhook } from "../polar/ingest";
import type { AppEnv } from "../lib/auth";

export const polarRoutes = new Hono<AppEnv>();

polarRoutes.post("/webhooks/:key", async (c) => {
  const body = await c.req.text();
  if (body.length > 256_000) return c.json({ error: "Body too large" }, 413);
  const r = await ingestPolarWebhook(c.env, {
    key: c.req.param("key"),
    body,
    headers: {
      id: c.req.header("webhook-id") ?? null,
      timestamp: c.req.header("webhook-timestamp") ?? null,
      signature: c.req.header("webhook-signature") ?? null,
    },
  });
  // Polar retries anything but 2xx: errors that setup can fix (no secret yet) are retried.
  if (r.status !== 200) return c.json({ error: r.error }, r.status);
  return c.json({
    ok: true,
    ...(r.duplicate ? { duplicate: true } : {}),
    ...(r.ignored ? { ignored: r.ignored } : {}),
  });
});
