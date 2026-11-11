import { Hono } from "hono";
import { landingResponse } from "./lib/landing";
import { requireAuth, sameOriginMutations, withDb, type AppEnv } from "./lib/auth";
import { acquisitionDue, cronAcquisition, cronTick, voidedDue } from "./lib/cron";
import { pollVoidedPurchases } from "./google/ingest";
import { securityHeaders } from "./lib/headers";
import { ensureSchema } from "./lib/migrate";
import { accountRoutes } from "./routes/account";
import { acquisitionRoutes } from "./routes/acquisition";
import { adminRoutes } from "./routes/admin";
import { appRoutes } from "./routes/apps";
import { appleRoutes } from "./routes/apple";
import { googleRoutes } from "./routes/google";
import { polarRoutes } from "./routes/polar";
import { sdkRoutes } from "./routes/sdk";
import { integrationRoutes } from "./routes/integrations";
import { appLoginRoutes } from "./routes/app-login";
import { authRoutes } from "./routes/auth";
import { jobRoutes } from "./routes/jobs";
import { mcpRoutes } from "./routes/mcp";
import { metricRoutes } from "./routes/metrics";
import { offeringRoutes } from "./routes/offerings";
import { entitlementRoutes } from "./routes/entitlements";
import { offerRoutes } from "./routes/offers";
import { remoteConfigRoutes } from "./routes/remote-config";
import { experimentRoutes } from "./routes/experiments";
import { eventRoutes } from "./routes/events";
import { versionInfo } from "./lib/updates";
import { cronInsights } from "./lib/insights";
import { sendMetaEvents } from "./lib/meta";
import { sendConsumptionInfo } from "./lib/refunds";

export { RevflareDatabase } from "./lib/db";
export { ImportWorkflow } from "./workflow";

const api = new Hono<AppEnv>();
api.use("*", sameOriginMutations);
api.get("/version", (c) => c.json(versionInfo()));
api.route("/auth/app-login", appLoginRoutes);
api.route("/auth", authRoutes);
// Everything below needs a session, a device token or an API key; handlers scope by c.var.workspace.
api.use("*", requireAuth);
api.route("/admin", adminRoutes);
api.route("/", accountRoutes);
api.route("/", appRoutes);
api.route("/", metricRoutes);
api.route("/", acquisitionRoutes);
api.route("/", jobRoutes);
api.route("/", integrationRoutes);
api.route("/", offeringRoutes);
api.route("/", entitlementRoutes);
api.route("/", offerRoutes);
api.route("/", remoteConfigRoutes);
api.route("/", experimentRoutes);
api.route("/", eventRoutes);
api.notFound((c) => c.json({ error: "Not found" }, 404));

const app = new Hono<AppEnv>();
app.use("*", securityHeaders);
app.use("*", async (c, next) => {
  await ensureSchema(c.env);
  return next();
});
app.use("*", withDb);
app.onError((err, c) => {
  console.error(err);
  // The Workers Free plan's daily Durable Object limits (rows read / written) reset at 00:00 UTC.
  if (/Exceeded allowed (rows|.*) in Durable Objects free tier/i.test(err.message ?? "")) {
    return c.json({ error: "Revflare reached today's Cloudflare free plan database limit. It resets at 00:00 UTC.", code: "quota" }, 503);
  }
  return c.json({ error: err.message || "Internal error" }, 500);
});
app.route("/api/v1", api);
app.route("/apple", appleRoutes);
app.route("/google", googleRoutes);
app.route("/polar", polarRoutes);
app.route("/sdk/v1", sdkRoutes);
app.route("/mcp", mcpRoutes(app));
// Universal link / app site association for the iOS app's pairing links.
app.get("/.well-known/apple-app-site-association", (c) =>
  c.json({ applinks: { details: [{ appIDs: [`${c.env.APNS_TEAM_ID ?? ""}.${c.env.APNS_TOPIC ?? ""}`], components: [{ "/": "/pair/*" }] }] } }),
);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return landingResponse(request, env) ?? app.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    await ensureSchema(env);
    ctx.waitUntil(
      cronTick(env, { at: event.scheduledTime }).then(
        (log) => console.log(JSON.stringify({ event: "cron", ...log })),
        (err) => console.error("cron failed", err),
      ),
    );
    // Meta Ads: queued purchases to the Conversions API, a database call of its own (own subrequest budget).
    ctx.waitUntil(
      sendMetaEvents(env, {}).then(
        (log) => Object.keys(log).length && console.log(JSON.stringify({ event: "cron_meta", ...log })),
        (err) => console.error("cron meta failed", err),
      ),
    );
    // Refund requests: answers to Apple's CONSUMPTION_REQUESTs (a few requests, its own database call).
    ctx.waitUntil(
      sendConsumptionInfo(env, {}).then(
        (log) => (log.requests || log.skipped || log.expired) && console.log(JSON.stringify({ event: "cron_refunds", ...log })),
        (err) => console.error("cron refunds failed", err),
      ),
    );
    // Funnel anomaly / release regression checks and the daily digest: Analytics Engine queries, alert pushes and digest
    // emails (one request budget per tick) in a database call of their own.
    ctx.waitUntil(
      cronInsights(env, { at: event.scheduledTime }).then(
        (log) =>
          Object.entries(log).some(([k, v]) => k !== "requests" && k !== "subrequests" && !(v && typeof v === "object" && "done" in v)) &&
          console.log(JSON.stringify({ event: "cron_insights", ...log })),
        (err) => console.error("cron insights failed", err),
      ),
    );
    // Google Play voided purchases (refunds RTDN missed): their own database call (Play API requests).
    if (voidedDue(event.scheduledTime)) {
      ctx.waitUntil(
        pollVoidedPurchases(env, { maxApps: 4 }).then(
          (log) => log.apps && console.log(JSON.stringify({ event: "cron_google_voided", ...log })),
          (err) => console.error("cron google voided failed", err),
        ),
      );
    }
    // App Analytics imports: their own database call, so their App Store requests get a subrequest budget of their own.
    if (acquisitionDue(event.scheduledTime)) {
      ctx.waitUntil(
        cronAcquisition(env, { at: event.scheduledTime }).then(
          (log) => console.log(JSON.stringify({ event: "cron_acquisition", ...log })),
          (err) => console.error("cron acquisition failed", err),
        ),
      );
    }
  },
} satisfies ExportedHandler<Env>;
