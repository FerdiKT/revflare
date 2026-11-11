// Public endpoint for Google Play real-time developer notifications (Pub/Sub push): POST /google/rtdn/:key
import { Hono } from "hono";
import { ingestRtdn } from "../google/ingest";
import type { AppEnv } from "../lib/auth";

export const googleRoutes = new Hono<AppEnv>();

googleRoutes.post("/rtdn/:key", async (c) => {
  const body = await c.req.text();
  if (body.length > 64_000) return c.json({ error: "Body too large" }, 413);
  const r = await ingestRtdn(c.env, { key: c.req.param("key"), body, authorization: c.req.header("authorization") ?? null, requestUrl: c.req.url });
  // Pub/Sub retries anything but 2xx (with backoff, for up to 7 days): errors that setup can fix are retried.
  if (r.status !== 200) return c.json({ error: r.error }, r.status as 400 | 401 | 404 | 503);
  return c.json({ ok: true, ...(r.duplicate ? { duplicate: true } : {}), ...(r.ignored ? { ignored: r.ignored } : {}) });
});
