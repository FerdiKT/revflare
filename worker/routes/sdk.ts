// Public endpoints for RevflareKit (the Swift package inside the apps). Authenticated by the app's public SDK key.
import { Hono } from "hono";
import type { AppEnv } from "../lib/auth";
import type { SdkReportResponse } from "../../shared/types";
import { recordSdkReport } from "../lib/attribution";
import { parseSdkEnvironment } from "../lib/test-data";
import { parseIdentifiers, recordInstallIdentifiers } from "../lib/meta";
import { SDK_CONFIG_TTL_S, SDK_OFFERINGS_TTL_S, sdkOfferings, sdkRemoteConfig } from "../lib/sdk-cache";
import { deviceContext, evaluate, sdkBody } from "../lib/remote-config";
import { recordSignature, signOfferRequest } from "../lib/offers";
import { dataPoint, eventsBinding, noteEventsReceived, parseBatch, sdkApp, takeTokens, warnNoBinding } from "../lib/events";
import { keyEventArgs, storeKeyEvents } from "../lib/key-events";

export const sdkRoutes = new Hono<AppEnv>();

const sdkKeyOf = (c: { req: { header: (k: string) => string | undefined } }, body: Record<string, unknown>) =>
  c.req.header("x-revflare-key") ?? (typeof body.sdkKey === "string" ? body.sdkKey : "");

sdkRoutes.post("/report", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "Expected JSON" }, 400);
  const r = await recordSdkReport(c.env, {
    sdkKey: sdkKeyOf(c, body),
    installId: String(body.installId ?? ""),
    attributionToken: typeof body.attributionToken === "string" ? body.attributionToken : null,
    originalTransactionIds: Array.isArray(body.originalTransactionIds) ? body.originalTransactionIds.map(String) : [],
    appVersion: typeof body.appVersion === "string" ? body.appVersion.slice(0, 32) : null,
    country: String((c.req.raw as { cf?: { country?: unknown } }).cf?.country ?? "").toUpperCase() || null,
    installedAt: typeof body.installedAt === "number" ? body.installedAt : null,
    // Missing / invalid stays null (read as production): only an explicit "production" moves an install to production.
    environment: parseSdkEnvironment(body.environment) === body.environment ? parseSdkEnvironment(body.environment) : null,
    // RevflareKit Android (docs/google-play.md#revflarekit-android).
    platform: body.platform === "android" ? "android" : null,
    orderIds: Array.isArray(body.orderIds) ? body.orderIds.slice(0, 200).map(String) : [],
    purchaseTokens: Array.isArray(body.purchaseTokens) ? body.purchaseTokens.slice(0, 90).map(String) : [],
    installReferrer: body.installReferrer && typeof body.installReferrer === "object" ? (body.installReferrer as { referrer: string }) : null,
  });
  if (r.status !== 200) return c.json({ error: r.error }, r.status as 400 | 404);
  return c.json({
    ok: true,
    attribution: r.attribution ?? null,
    source: r.source ?? "unknown",
    campaignId: r.campaignId ?? null,
    adGroupId: r.adGroupId ?? null,
    keywordId: r.keywordId ?? null,
  } satisfies SdkReportResponse);
});

/** The install's ad identifiers (Meta Ads integration): Facebook SDK anonymous id, IDFA, IDFV, ATT status, device info. */
sdkRoutes.post("/identifiers", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Expected a JSON object" }, 400);
  const sdkKey = sdkKeyOf(c, body);
  if (!sdkKey) return c.json({ error: "sdkKey is required (X-Revflare-Key header or sdkKey in the body)" }, 400);
  const parsed = parseIdentifiers(body);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  // Xcode builds (StoreKit configuration file) and debuggable Android builds never make purchases Meta could be sent: nothing to keep.
  const sdkEnv = parseSdkEnvironment(body.environment);
  if (sdkEnv === "xcode" || sdkEnv === "debug") return c.json({ ok: true });
  const r = await recordInstallIdentifiers(c.env, {
    sdkKey,
    installId: parsed.installId,
    ids: parsed.ids,
    ip: c.req.header("cf-connecting-ip") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
  });
  if (r.status !== 200) return c.json({ error: r.error }, r.status);
  return c.json({ ok: true });
});

/**
 * The app's offerings and placements (paywalls). Hit by every install at launch: answered from the isolate's memory or
 * the Cache API, the database is read at most once a minute per isolate (worker/lib/sdk-cache.ts). `appVersion` is
 * accepted for future targeting and ignored for now.
 */
sdkRoutes.get("/offerings", async (c) => {
  const sdkKey = c.req.header("x-revflare-key")?.trim() ?? "";
  if (!sdkKey) return c.json({ error: "sdkKey is required (X-Revflare-Key header)" }, 400);
  let waitUntil: ((p: Promise<unknown>) => void) | undefined;
  try {
    const ctx = c.executionCtx;
    waitUntil = (p) => ctx.waitUntil(p);
  } catch {}
  const value = await sdkOfferings(c.var.db, sdkKey, c.req.url, waitUntil);
  if (!value) return c.json({ error: "Unknown SDK key" }, 404);
  const headers = { etag: `"${value.version}"`, "cache-control": `max-age=${SDK_OFFERINGS_TTL_S}`, vary: "X-Revflare-Key" };
  const inm = c.req.header("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim() === "*" || t.trim().replace(/^W\//, "").replace(/"/g, "") === value.version)) return c.body(null, 304, headers);
  return c.body(value.body, 200, { ...headers, "content-type": "application/json; charset=utf-8" });
});

const etagMatches = (inm: string | undefined, version: string) =>
  !!inm && inm.split(",").some((t) => t.trim() === "*" || t.trim().replace(/^W\//, "").replace(/"/g, "") === version);

/**
 * The device's remote config values (like Firebase Remote Config). The app's compiled config comes from the isolate's
 * memory or the Cache API (the database is read at most once a minute per isolate); conditions are evaluated here
 * for the device described by the query (storefront, app version, locale, installId for percent rollouts...).
 * `version` (ETag) is a hash of this device's response: it changes only when its values change.
 */
sdkRoutes.get("/config", async (c) => {
  const sdkKey = c.req.header("x-revflare-key")?.trim() ?? "";
  if (!sdkKey) return c.json({ error: "sdkKey is required (X-Revflare-Key header)" }, 400);
  let waitUntil: ((p: Promise<unknown>) => void) | undefined;
  try {
    const ctx = c.executionCtx;
    waitUntil = (p) => ctx.waitUntil(p);
  } catch {}
  const cached = await sdkRemoteConfig(c.var.db, sdkKey, c.req.url, waitUntil);
  if (!cached) return c.json({ error: "Unknown SDK key" }, 404);
  const device = deviceContext(c.req.query(), (c.req.raw as { cf?: { country?: unknown } }).cf?.country);
  const result = sdkBody(await evaluate(cached.config, device));
  const headers = { etag: `"${result.version}"`, "cache-control": `private, max-age=${SDK_CONFIG_TTL_S}`, vary: "X-Revflare-Key" };
  if (etagMatches(c.req.header("if-none-match"), result.version)) return c.body(null, 304, headers);
  return c.body(JSON.stringify(result), 200, { ...headers, "content-type": "application/json; charset=utf-8" });
});

const MAX_EVENTS_BODY = 1024 * 1024;

/**
 * App events (funnels, events explorer). Stored in Workers Analytics Engine (binding EVENTS), one data point per event
 * (layout: worker/lib/events.ts); key events (first_open, purchase_*, paywall_view... plus the app's patterns) are also
 * stored in the database after the response (one database call, worker/lib/key-events.ts: deduplicated, capped per
 * install and per app and day, within the background budget; retried once, then the day is flagged incomplete by the
 * app's next call so reads fall back to sampled data; a failure is logged, never returned). The SDK key is
 * resolved from the isolate's cache (one indexed read per key every 5 minutes) and the "last event" note is written at
 * most every 10 minutes per isolate and app: a batch without key events costs no database work.
 * Invalid events are dropped, not the batch. Without the binding the events are accepted and dropped (200).
 */
sdkRoutes.post("/events", async (c) => {
  const sdkKey = c.req.header("x-revflare-key")?.trim() ?? "";
  if (!sdkKey) return c.json({ error: "sdkKey is required (X-Revflare-Key header)" }, 400);
  if (Number(c.req.header("content-length") ?? 0) > MAX_EVENTS_BODY) return c.json({ error: "Body too large" }, 413);
  const text = await c.req.text();
  if (text.length > MAX_EVENTS_BODY) return c.json({ error: "Body too large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.json({ error: "Expected JSON" }, 400);
  }
  const at = Date.now();
  const batch = parseBatch(body, at);
  if ("error" in batch) return c.json({ error: batch.error }, batch.status);
  const app = await sdkApp(c.var.db, sdkKey);
  if (!app) return c.json({ error: "Unknown SDK key" }, 404);
  const rate = takeTokens(app.id, batch.installId, batch.events.length, at);
  if (!rate.ok) return c.json({ error: "Too many events: slow down" }, 429, { "retry-after": String(rate.retryAfter) });
  const dataset = eventsBinding(c.env);
  if (!dataset) {
    warnNoBinding();
    return c.json({ ok: true, accepted: 0, dropped: batch.events.length + batch.dropped });
  }
  const country = String((c.req.raw as { cf?: { country?: unknown } }).cf?.country ?? "").slice(0, 2).toUpperCase();
  for (const e of batch.events) dataset.writeDataPoint(dataPoint(app, batch, e, country, at));
  if (batch.events.length) {
    const pending: Promise<unknown>[] = [noteEventsReceived(c.var.db, app.id, at, batch.environment !== "production").catch((err) => console.error("events note failed", err))];
    const keyArgs = keyEventArgs(app, batch, country, at);
    if (keyArgs)
      pending.push(
        storeKeyEvents(c.env, keyArgs).catch((err) => console.error("key events store failed", err)),
      );
    const all = Promise.all(pending);
    // Tests wait for the database writes: work left running after a test file breaks the next file's database object.
    if (c.env.TEST_MODE === "true") await all;
    else {
      try {
        c.executionCtx.waitUntil(all);
      } catch {
        await all;
      }
    }
  }
  return c.json({ ok: true, accepted: batch.events.length, dropped: batch.dropped });
});

/**
 * Promotional offer signature (docs/offers.md). Body { installId, productId, offerId, appAccountToken? } →
 * { productId, offerId, keyId, nonce, timestamp, signature, jws }. Only allowlisted offers are signed (403
 * offer_not_allowed), 409 not_configured without an In-App Purchase key or bundle id, 429 over 10 / hour / install or
 * 1000 / hour / app. The app, allowlist and key come from the isolate's cache; the log row (signatures, sampled refusals,
 * within the day's background budget) is written after the response.
 */
sdkRoutes.post("/offers/sign", async (c) => {
  const sdkKey = c.req.header("x-revflare-key")?.trim() ?? "";
  if (!sdkKey) return c.json({ error: "sdkKey is required (X-Revflare-Key header)" }, 400);
  // Content-Length can be absent (chunked) or wrong: measure the body itself.
  const text = await c.req.text().catch(() => "");
  if (text.length > 4096) return c.json({ error: "Body too large" }, 413);
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const pending: Promise<unknown>[] = [];
  const r = await signOfferRequest(c.env, c.var.db, sdkKey, body, (appId, row) => {
    pending.push(recordSignature(c.env, { appId, row }).catch((err) => console.error("offer signature log failed", err)));
  });
  if (pending.length) {
    const all = Promise.all(pending);
    // Tests wait for the log write: work left running after a test file breaks the next file's database object.
    if (c.env.TEST_MODE === "true") await all;
    else {
      try {
        c.executionCtx.waitUntil(all);
      } catch {
        await all;
      }
    }
  }
  if (r.status === 429) return c.json(r.body, 429, { "retry-after": String(r.retryAfter) });
  return c.json(r.body, r.status, { "cache-control": "no-store" });
});
