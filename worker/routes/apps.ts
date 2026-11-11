// Apps, store credentials and setup actions (import from App Store Connect, notification URLs, test notifications).
import { Hono } from "hono";
import type { App, CredentialKind, GooglePlaySettings, Product } from "../../shared/types";
import { requestTestNotification, syncNotificationHistory, syncTransactionHistory } from "../apple/ingest";
import { checkForwardUrl } from "../apple/forward";
import { connectNotificationUrl, importAppsFromConnect, notificationUrl, syncProducts, upsertApp } from "../apple/setup";
import { requirePermission, wsId, type AppEnv } from "../lib/auth";
import { credentialView, listCredentials, saveCredential } from "../lib/credentials";
import { appStats, bumpDataVersion } from "../lib/metrics";
import { acquisitionStatusLocal } from "../lib/acquisition";
import { pemToBytes } from "../lib/crypto";
import { forgetSdkOfferings, forgetSdkRemoteConfig } from "../lib/sdk-cache";
import { forgetSdkApp } from "../lib/events";
import { forgetOfferContext, forgetWorkspaceOfferContexts } from "../lib/offers";
import { runRollups } from "../lib/rollup";
import { baseUrl } from "../lib/settings";
import { now, parseJson, randomToken } from "../lib/util";
import { normalizeName } from "./auth";
import { checkGooglePlay, forgetPlayCaches, parseCheck, pollVoidedPurchases, rtdnUrl } from "../google/ingest";
import { parseServiceAccount } from "../google/auth";
import { getPolarSettings, polarWebhookUrl, syncPolarOrders, updatePolarSettings } from "../polar/ingest";
import { newId } from "../lib/util";

export const appRoutes = new Hono<AppEnv>();

interface AppRow {
  id: string;
  name: string;
  platform: string;
  bundle_id: string | null;
  apple_app_id: string | null;
  icon_url: string | null;
  notification_key: string;
  commission_pct: number;
  archived: number;
  notification_url_status: App["notificationUrlStatus"];
  notification_url: string | null;
  last_notification_at: number | null;
  last_history_sync_at: number | null;
  history_backfilled_from: string | null;
  rc_project_id: string | null;
  store_available: number | null;
  sdk_key: string | null;
  forward_url: string | null;
  forward_status: string | null;
  meta_enabled: number | null;
  refunds_enabled?: number | null;
  google_push_account: string | null;
  google_credential_id: string | null;
  google_check: string | null;
  google_voided_checked_at: number | null;
  polar_secret?: string | null;
  /** Android: the credential the app's Play API calls use (its own, else the workspace's newest google_play key). */
  google_effective_credential?: string | null;
}

function toApp(r: AppRow, base: string, stats?: { mrr: number; revenue28d: number; activeSubscriptions: number; activeTrials: number }): App {
  const android = r.platform === "android";
  const web = r.platform === "web";
  return {
    id: r.id,
    name: r.name,
    platform: r.platform,
    bundleId: r.bundle_id,
    appleAppId: r.apple_app_id,
    iconUrl: r.icon_url,
    commissionPct: r.commission_pct,
    archived: !!r.archived,
    notificationUrlStatus: r.notification_url_status,
    // Android: the RTDN push endpoint (Pub/Sub push subscription); web: the Polar webhook URL.
    revflareNotificationUrl: android ? rtdnUrl(base, r.notification_key) : web ? polarWebhookUrl(base, r.notification_key) : notificationUrl(base, r.notification_key),
    currentNotificationUrl: r.notification_url,
    lastNotificationAt: r.last_notification_at,
    lastHistorySyncAt: r.last_history_sync_at,
    historyBackfilledFrom: r.history_backfilled_from,
    rcProjectId: r.rc_project_id,
    storeAvailable: r.store_available === null ? null : !!r.store_available,
    sdkKey: r.sdk_key,
    forwardNotificationUrl: r.forward_url,
    forwardStatus: r.forward_status ? parseJson(r.forward_status, null) : null,
    metaEnabled: !!r.meta_enabled,
    refundRequestsEnabled: !!r.refunds_enabled,
    polar: web ? { webhookUrl: polarWebhookUrl(base, r.notification_key), connected: !!r.polar_secret } : null,
    googlePlay: android ? { rtdnUrl: rtdnUrl(base, r.notification_key), configured: !!r.google_effective_credential, pushAuth: !!r.google_push_account, lastCheck: parseCheck(r.google_check) } : null,
    mrr: stats?.mrr ?? 0,
    revenue28d: stats?.revenue28d ?? 0,
    activeSubscriptions: stats?.activeSubscriptions ?? 0,
    activeTrials: stats?.activeTrials ?? 0,
  };
}

// The Google Play credential resolves like the database object's (worker/google/ingest.ts playServiceAccount): the app's
// own key, else the workspace's newest google_play key.
const INTEGRATION_FLAGS = `(SELECT enabled FROM meta_integrations m WHERE m.app_id = apps.id) AS meta_enabled, (SELECT enabled FROM refund_settings r WHERE r.app_id = apps.id) AS refunds_enabled,
  CASE WHEN apps.platform = 'android' THEN COALESCE(
    (SELECT k.id FROM credentials k WHERE k.id = apps.google_credential_id AND k.workspace_id = apps.workspace_id AND k.kind = 'google_play'),
    (SELECT k.id FROM credentials k WHERE k.workspace_id = apps.workspace_id AND k.kind = 'google_play' ORDER BY k.created_at DESC LIMIT 1)) END AS google_effective_credential`;

async function getApp(c: { var: AppEnv["Variables"] }, id: string) {
  return c.var.db.prepare(`SELECT *, ${INTEGRATION_FLAGS} FROM apps WHERE id = ? AND workspace_id = ?`).bind(id, c.var.workspace!.id).first<AppRow>();
}

appRoutes.get("/apps", requirePermission("read"), async (c) => {
  const db = c.var.db;
  const { results } = await db.prepare(`SELECT *, ${INTEGRATION_FLAGS} FROM apps WHERE workspace_id = ? ORDER BY archived, name`).bind(wsId(c)).all<AppRow>();
  const [{ stats, currency }, base] = await Promise.all([appStats(c.env, { workspaceId: wsId(c) }), baseUrl(c.env, db, c.req.url)]);
  const items = results.map((r) => toApp(r, base, stats[r.id])).sort((a, b) => Number(a.archived) - Number(b.archived) || b.revenue28d - a.revenue28d || a.name.localeCompare(b.name));
  return c.json({ items, currency });
});

appRoutes.get("/apps/:id", requirePermission("read"), async (c) => {
  const app = await getApp(c, c.req.param("id"));
  if (!app) return c.json({ error: "Not found" }, 404);
  const db = c.var.db;
  const [{ stats }, base, products, acquisition] = await Promise.all([
    appStats(c.env, { workspaceId: wsId(c), appIds: [app.id] }),
    baseUrl(c.env, db, c.req.url),
    db.prepare("SELECT product_id AS productId, name, type, period FROM products WHERE app_id = ? AND product_id != '' ORDER BY type, product_id").bind(app.id).all<Product>(),
    acquisitionStatusLocal(db, { workspaceId: wsId(c), appIds: [app.id] }),
  ]);
  return c.json({ ...toApp(app, base, stats[app.id]), acquisition: app.platform !== "ios" ? undefined : acquisition[0], products: products.results });
});

/** Android package names: two or more dot-separated segments starting with a letter. */
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** 400 for App Store features asked of an Android or web app (null when the app is an iOS app). */
export function appleOnly(app: { platform: string } | null | undefined, what: string): { error: string } | null {
  if (app?.platform === "android") return { error: `${what} is App Store only: not available for Android (Google Play) apps` };
  if (app?.platform === "web") return { error: `${what} is App Store only: not available for web (Polar) apps` };
  return null;
}

appRoutes.post("/apps", requirePermission("manage"), async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  if (body.platform !== undefined && body.platform !== "ios" && body.platform !== "android" && body.platform !== "web") return c.json({ error: "platform must be ios, android or web" }, 400);
  if (body.platform === "web") {
    // Web apps sell through Polar (worker/polar/): bundleId is an optional identifier (e.g. a reverse domain).
    const name = normalizeName(body.name);
    const id0 = typeof body.bundleId === "string" ? body.bundleId.trim() : "";
    if (!name) return c.json({ error: "name is required" }, 400);
    if (id0 && (!/^[A-Za-z0-9.\-_]+$/.test(id0) || id0.length > 150)) return c.json({ error: "bundleId may only contain letters, digits, dots, dashes and underscores" }, 400);
    const db = c.var.db;
    const existing = id0 ? await db.prepare("SELECT id FROM apps WHERE workspace_id = ? AND bundle_id = ? AND platform = 'web'").bind(wsId(c), id0).first<{ id: string }>() : null;
    let id = existing?.id;
    const t = now();
    if (id) await db.prepare("UPDATE apps SET name = ?, updated_at = ? WHERE id = ?").bind(name, t, id).run();
    else {
      id = newId("app_");
      await db
        .prepare(
          `INSERT INTO apps (id, workspace_id, name, platform, bundle_id, notification_key, notification_url_status, sdk_key, commission_pct, created_at, updated_at)
           VALUES (?, ?, ?, 'web', ?, ?, 'unknown', ?, 15, ?, ?)`,
        )
        .bind(id, wsId(c), name, id0 || null, randomToken(18), `rfp_${randomToken(16)}`, t, t)
        .run();
    }
    const row = await getApp(c, id);
    return c.json(toApp(row!, await baseUrl(c.env, db, c.req.url)), existing ? 200 : 201);
  }
  if (body.platform === "android") {
    const name = normalizeName(body.name);
    const pkg = typeof body.packageName === "string" ? body.packageName.trim() : typeof body.bundleId === "string" ? body.bundleId.trim() : "";
    if (!name || !PACKAGE_RE.test(pkg) || pkg.length > 150) return c.json({ error: "name and packageName (e.g. com.example.app) are required" }, 400);
    const db = c.var.db;
    const existing = await db.prepare("SELECT id FROM apps WHERE workspace_id = ? AND bundle_id = ? AND platform = 'android'").bind(wsId(c), pkg).first<{ id: string }>();
    let id = existing?.id;
    const t = now();
    if (id) await db.prepare("UPDATE apps SET name = ?, updated_at = ? WHERE id = ?").bind(name, t, id).run();
    else {
      id = newId("app_");
      // Play's standard service fee on subscriptions is 15% (commission_pct is only the fallback when the Orders API gives no proceeds).
      await db
        .prepare(
          `INSERT INTO apps (id, workspace_id, name, platform, bundle_id, notification_key, notification_url_status, sdk_key, commission_pct, created_at, updated_at)
           VALUES (?, ?, ?, 'android', ?, ?, 'unknown', ?, 15, ?, ?)`,
        )
        .bind(id, wsId(c), name, pkg, randomToken(18), `rfp_${randomToken(16)}`, t, t)
        .run();
    }
    const row = await getApp(c, id);
    return c.json(toApp(row!, await baseUrl(c.env, db, c.req.url)), existing ? 200 : 201);
  }
  const name = normalizeName(body.name);
  const bundleId = typeof body.bundleId === "string" && /^[A-Za-z0-9.\-]+$/.test(body.bundleId) ? body.bundleId : null;
  if (!name || !bundleId) return c.json({ error: "name and bundleId are required" }, 400);
  const appleAppId = typeof body.appleAppId === "string" && /^\d+$/.test(body.appleAppId) ? body.appleAppId : null;
  const r = await upsertApp(c.var.db, wsId(c), { name, bundleId, appleAppId });
  const row = await getApp(c, r.id);
  return c.json(toApp(row!, await baseUrl(c.env, c.var.db, c.req.url)), r.created ? 201 : 200);
});

appRoutes.patch("/apps/:id", requirePermission("manage"), async (c) => {
  const app = await getApp(c, c.req.param("id"));
  if (!app) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const name = body.name === undefined ? null : normalizeName(body.name);
  const commission = body.commissionPct === 15 || body.commissionPct === 30 ? body.commissionPct : null;
  const archived = typeof body.archived === "boolean" ? (body.archived ? 1 : 0) : null;
  const rc = typeof body.rcProjectId === "string" ? body.rcProjectId : null;
  // An App Store app without any store sale can become a web (Polar) app (e.g. a website's app added as iOS).
  if (body.platform !== undefined && body.platform !== app.platform) {
    if (body.platform !== "web" || app.platform !== "ios") return c.json({ error: "platform can only change from ios to web" }, 400);
    const sold = await c.var.db.prepare("SELECT 1 AS x FROM transactions WHERE app_id = ? LIMIT 1").bind(app.id).first();
    if (sold || app.apple_app_id) return c.json({ error: "This app has App Store data (an Apple app id or transactions): add a separate web app instead" }, 400);
    await c.var.db.prepare("UPDATE apps SET platform = 'web', notification_url_status = 'unknown', notification_url = NULL, updated_at = ? WHERE id = ?").bind(now(), app.id).run();
  }
  if (body.forwardNotificationUrl !== undefined) {
    const f = checkForwardUrl(body.forwardNotificationUrl, c.req.url);
    if ("error" in f) return c.json({ error: f.error }, 400);
    await c.var.db.prepare("UPDATE apps SET forward_url = ?, forward_status = NULL WHERE id = ?").bind(f.url, app.id).run();
  }
  await c.var.db
    .prepare("UPDATE apps SET name = COALESCE(?, name), commission_pct = COALESCE(?, commission_pct), archived = COALESCE(?, archived), rc_project_id = COALESCE(?, rc_project_id), updated_at = ? WHERE id = ?")
    .bind(name, commission, archived, rc, now(), app.id)
    .run();
  if (commission && commission !== app.commission_pct) {
    // Re-estimate proceeds that Apple's reports have not confirmed.
    await c.var.db
      .prepare("UPDATE transactions SET proceeds_usd = proceeds_usd * ? WHERE app_id = ? AND proceeds_reported = 0")
      .bind((100 - commission) / (100 - app.commission_pct), app.id)
      .run();
    await runRollups(c.env, { appIds: [app.id] });
  }
  await bumpDataVersion(c.var.db, wsId(c));
  return c.json({ ok: true });
});

/** Imports apps from App Store Connect; setUrls=empty points apps without a notification URL at Revflare. */
appRoutes.post("/apps/import", requirePermission("manage"), async (c) => {
  const body = await c.req.json<{ setUrls?: unknown; only?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const only = Array.isArray(body.only) ? body.only.filter((x): x is string => typeof x === "string") : undefined;
  const r = await importAppsFromConnect(c.env, { workspaceId: wsId(c), setUrls: body.setUrls === "empty" ? "empty" : "none", requestUrl: c.req.url, only });
  if (r.error) return c.json({ error: r.error }, 400);
  return c.json(r);
});

appRoutes.post("/apps/sync-products", requirePermission("manage"), async (c) => {
  const body = await c.req.json<{ appIds?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const appIds = Array.isArray(body.appIds) ? body.appIds.filter((x): x is string => typeof x === "string") : undefined;
  return c.json(await syncProducts(c.env, { workspaceId: wsId(c), appIds, limit: 15 }));
});

/** Points the app's App Store Server Notifications at Revflare (replaces the current URL). */
appRoutes.post("/apps/:id/connect-notifications", requirePermission("manage"), async (c) => {
  const app = await getApp(c, c.req.param("id"));
  if (!app) return c.json({ error: "Not found" }, 404);
  const apple = appleOnly(app, "App Store Server Notifications");
  if (apple) return c.json(apple, 400);
  const r = await connectNotificationUrl(c.env, { appId: app.id, requestUrl: c.req.url });
  return r.error ? c.json({ error: r.error }, 400) : c.json(r);
});

appRoutes.post("/apps/:id/test-notification", requirePermission("manage"), async (c) => {
  const app = await getApp(c, c.req.param("id"));
  if (!app) return c.json({ error: "Not found" }, 404);
  const apple = appleOnly(app, "Apple's test notification");
  if (apple) return c.json(apple, 400);
  const body = await c.req.json<{ environment?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const r = await requestTestNotification(c.env, { appId: app.id, environment: body.environment === "Production" ? "Production" : "Sandbox" });
  return r.error ? c.json({ error: r.error }, 400) : c.json(r);
});

/** Pulls notification and transaction history from Apple now (one bounded round; jobs do full backfills). */
appRoutes.post("/apps/:id/sync", requirePermission("manage"), async (c) => {
  const app = await getApp(c, c.req.param("id"));
  if (!app) return c.json({ error: "Not found" }, 404);
  const apple = appleOnly(app, "App Store history sync");
  if (apple) return c.json(apple, 400);
  const history = await syncNotificationHistory(c.env, { appId: app.id, maxRequests: 10 });
  const transactions = history.error ? null : await syncTransactionHistory(c.env, { appId: app.id, maxRequests: 10 });
  return c.json({ history, transactions });
});

// Credentials ---------------------------------------------------------------------------------------------------------

const KINDS: CredentialKind[] = ["appstore_iap", "appstore_connect", "appstore_reports", "revenuecat", "google_play"];

appRoutes.get("/credentials", requirePermission("manage"), async (c) => {
  const lists = await Promise.all(KINDS.map((k) => listCredentials(c.env, c.var.db, wsId(c), k)));
  return c.json({ items: lists.flat().map(credentialView) });
});

appRoutes.post("/credentials", requirePermission("manage"), async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const kind = KINDS.find((k) => k === body.kind);
  if (!kind) return c.json({ error: `kind must be one of ${KINDS.join(", ")}` }, 400);
  const name = normalizeName(body.name) ?? kind;
  const config: Record<string, unknown> = {};
  if (kind === "google_play") {
    const sa = await parseServiceAccount(body.serviceAccount ?? body.json);
    if ("error" in sa) return c.json({ error: sa.error }, 400);
    const id = await saveGoogleCredential(c, sa, normalizeName(body.name));
    return c.json({ id }, 201);
  }
  if (kind === "revenuecat") {
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey.startsWith("sk_")) return c.json({ error: "A RevenueCat secret API key (sk_...) is required" }, 400);
    if (typeof body.projectId === "string") config.projectId = body.projectId;
    const id = await saveCredential(c.env, c.var.db, { workspaceId: wsId(c), kind, name, config, secret: { apiKey } });
    return c.json({ id }, 201);
  }
  const keyId = typeof body.keyId === "string" ? body.keyId.trim() : "";
  const issuerId = typeof body.issuerId === "string" ? body.issuerId.trim() : "";
  const privateKey = typeof body.privateKey === "string" ? body.privateKey.trim() : "";
  if (!/^[A-Z0-9]{10}$/.test(keyId)) return c.json({ error: "keyId must be the 10-character key id" }, 400);
  if (!/^[0-9a-f-]{36}$/i.test(issuerId)) return c.json({ error: "issuerId must be the issuer UUID" }, 400);
  try {
    await crypto.subtle.importKey("pkcs8", pemToBytes(privateKey) as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } catch {
    return c.json({ error: "privateKey must be the contents of the .p8 file" }, 400);
  }
  if (typeof body.vendorNumber === "string" && /^\d+$/.test(body.vendorNumber)) config.vendorNumber = body.vendorNumber;
  const id = await saveCredential(c.env, c.var.db, { workspaceId: wsId(c), kind, name, keyId, issuerId, config, secret: { privateKey } });
  if (kind === "appstore_iap") forgetWorkspaceOfferContexts(wsId(c));
  return c.json({ id }, 201);
});

async function saveGoogleCredential(c: { env: Env; var: AppEnv["Variables"] }, sa: Exclude<Awaited<ReturnType<typeof parseServiceAccount>>, { error: string }>, name: string | null): Promise<string> {
  const id = await saveCredential(c.env, c.var.db, {
    workspaceId: c.var.workspace!.id,
    kind: "google_play",
    name: name ?? sa.clientEmail,
    keyId: sa.privateKeyId,
    issuerId: sa.clientEmail,
    config: { clientEmail: sa.clientEmail, ...(sa.projectId ? { projectId: sa.projectId } : {}) },
    secret: { privateKey: sa.privateKey },
  });
  // A replaced key: the database object (where the Play API calls run) forgets its cached accounts and tokens.
  await forgetPlayCaches(c.env, {});
  return id;
}

// Google Play (Android apps) ---------------------------------------------------------------------------------------------

async function googleSettings(c: { env: Env; req: { url: string }; var: AppEnv["Variables"] }, app: AppRow): Promise<GooglePlaySettings> {
  const db = c.var.db;
  const own = app.google_credential_id
    ? await db.prepare("SELECT id, name, config FROM credentials WHERE id = ? AND workspace_id = ? AND kind = 'google_play'").bind(app.google_credential_id, c.var.workspace!.id).first<{ id: string; name: string; config: string }>()
    : null;
  const cred = own ?? (await db.prepare("SELECT id, name, config FROM credentials WHERE workspace_id = ? AND kind = 'google_play' ORDER BY created_at DESC LIMIT 1").bind(c.var.workspace!.id).first<{ id: string; name: string; config: string }>());
  const config = cred ? parseJson<{ clientEmail?: string; projectId?: string }>(cred.config, {}) : {};
  return {
    appId: app.id,
    packageName: app.bundle_id ?? "",
    rtdnUrl: rtdnUrl(await baseUrl(c.env, db, c.req.url), app.notification_key),
    pushServiceAccount: app.google_push_account,
    credential: cred ? { id: cred.id, name: cred.name, clientEmail: config.clientEmail ?? null, projectId: config.projectId ?? null, appSpecific: !!own } : null,
    lastNotificationAt: app.last_notification_at,
    lastCheck: parseCheck(app.google_check),
    voidedCheckedAt: app.google_voided_checked_at,
  };
}

const notAndroid = { error: "Google Play settings are for Android apps (add one with POST /apps { platform: \"android\" })" };
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

appRoutes.get("/apps/:id/google-play", requirePermission("read"), async (c) => {
  const app = await getApp(c, c.req.param("id"));
  if (!app) return c.json({ error: "Not found" }, 404);
  if (app.platform !== "android") return c.json(notAndroid, 400);
  return c.json(await googleSettings(c, app));
});

/**
 * PUT /apps/:id/google-play { serviceAccount?: <JSON key> | object, credentialId?: string | null, pushServiceAccount?: string | null }.
 * serviceAccount stores a new google_play key (workspace credential) and makes it the app's.
 */
appRoutes.put("/apps/:id/google-play", requirePermission("manage"), async (c) => {
  const app = await getApp(c, c.req.param("id"));
  if (!app) return c.json({ error: "Not found" }, 404);
  if (app.platform !== "android") return c.json(notAndroid, 400);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const db = c.var.db;
  let credentialId: string | null | undefined;
  if (body.serviceAccount !== undefined && body.serviceAccount !== null) {
    const sa = await parseServiceAccount(body.serviceAccount);
    if ("error" in sa) return c.json({ error: sa.error }, 400);
    credentialId = await saveGoogleCredential(c, sa, null);
  } else if (body.credentialId !== undefined) {
    if (body.credentialId === null) credentialId = null;
    else {
      const ok = typeof body.credentialId === "string" && (await db.prepare("SELECT 1 AS x FROM credentials WHERE id = ? AND workspace_id = ? AND kind = 'google_play'").bind(body.credentialId, wsId(c)).first());
      if (!ok) return c.json({ error: "credentialId must be a google_play credential of this workspace" }, 400);
      credentialId = body.credentialId as string;
    }
  }
  let push: string | null | undefined;
  if (body.pushServiceAccount !== undefined) {
    const v = typeof body.pushServiceAccount === "string" ? body.pushServiceAccount.trim() : body.pushServiceAccount;
    if (v === null || v === "") push = null;
    else if (typeof v === "string" && EMAIL_RE.test(v) && v.length <= 200) push = v.toLowerCase();
    else return c.json({ error: "pushServiceAccount must be a service account email (…@….iam.gserviceaccount.com) or null" }, 400);
  }
  await db
    .prepare(
      `UPDATE apps SET google_credential_id = CASE WHEN ? THEN ? ELSE google_credential_id END, google_push_account = CASE WHEN ? THEN ? ELSE google_push_account END,
       google_check = CASE WHEN ? THEN NULL ELSE google_check END, updated_at = ? WHERE id = ?`,
    )
    .bind(credentialId !== undefined ? 1 : 0, credentialId ?? null, push !== undefined ? 1 : 0, push ?? null, credentialId !== undefined ? 1 : 0, now(), app.id)
    .run();
  return c.json(await googleSettings(c, (await getApp(c, app.id))!));
});

/** Read-only check that the service account can read the app's orders (voided purchases of the last hour). */
appRoutes.post("/apps/:id/google-play/test", requirePermission("manage"), async (c) => {
  const app = await getApp(c, c.req.param("id"));
  if (!app) return c.json({ error: "Not found" }, 404);
  if (app.platform !== "android") return c.json(notAndroid, 400);
  return c.json(await checkGooglePlay(c.env, { appId: app.id }));
});

/** Polls voided purchases (refunds) now instead of at the next daily run. */
appRoutes.post("/apps/:id/google-play/voided", requirePermission("manage"), async (c) => {
  const app = await getApp(c, c.req.param("id"));
  if (!app) return c.json({ error: "Not found" }, 404);
  if (app.platform !== "android") return c.json(notAndroid, 400);
  const r = await pollVoidedPurchases(c.env, { appIds: [app.id], maxApps: 1, force: true });
  if (r.refunded) await bumpDataVersion(c.var.db, wsId(c));
  return c.json(r);
});

const notWeb = { error: "Polar settings are for web apps (add one with POST /apps { platform: \"web\" }, or PATCH an iOS app without sales to platform web)" };

appRoutes.get("/apps/:id/polar", requirePermission("read"), async (c) => {
  const app = await getApp(c, c.req.param("id"));
  if (!app) return c.json({ error: "Not found" }, 404);
  if (app.platform !== "web") return c.json(notWeb, 400);
  return c.json(await getPolarSettings(c.env, { appId: app.id, requestUrl: c.req.url }));
});

/**
 * PUT /apps/:id/polar { webhookSecret?, accessToken?, products?: { <Polar product id>: <product id> }, sandbox?, createWebhook? }.
 * With an access token and no webhook secret, Revflare creates the webhook endpoint in Polar and keeps its secret.
 */
appRoutes.put("/apps/:id/polar", requirePermission("manage"), async (c) => {
  const app = await getApp(c, c.req.param("id"));
  if (!app) return c.json({ error: "Not found" }, 404);
  if (app.platform !== "web") return c.json(notWeb, 400);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const str = (v: unknown, max: number): string | null | undefined | false =>
    v === undefined ? undefined : v === null || v === "" ? null : typeof v === "string" && v.trim().length <= max ? v.trim() : false;
  const webhookSecret = str(body.webhookSecret, 500);
  const accessToken = str(body.accessToken, 500);
  if (webhookSecret === false) return c.json({ error: "webhookSecret must be the endpoint's signing secret (string) or null" }, 400);
  if (accessToken === false) return c.json({ error: "accessToken must be a Polar organization access token (string) or null" }, 400);
  let products: Record<string, string> | null | undefined;
  if (body.products !== undefined) {
    if (body.products !== null && (typeof body.products !== "object" || Array.isArray(body.products))) return c.json({ error: "products must be an object { <Polar product id>: <product id> }" }, 400);
    products = {};
    for (const [k, v] of Object.entries((body.products ?? {}) as Record<string, unknown>)) {
      if (typeof v !== "string" || k.length > 100 || v.length > 150) return c.json({ error: "products values must be product ids (strings)" }, 400);
      products[k] = v;
    }
  }
  if (body.sandbox !== undefined && typeof body.sandbox !== "boolean") return c.json({ error: "sandbox must be a boolean" }, 400);
  const r = await updatePolarSettings(c.env, {
    appId: app.id,
    requestUrl: c.req.url,
    webhookSecret,
    accessToken,
    products,
    sandbox: body.sandbox as boolean | undefined,
    createWebhook: body.createWebhook === false ? false : undefined,
  });
  if ("error" in r) return c.json(r, 400);
  return c.json(r);
});

/** Imports past Polar orders with the access token (newest first; maxPages × 100 orders, default 5). */
appRoutes.post("/apps/:id/polar/sync", requirePermission("manage"), async (c) => {
  const app = await getApp(c, c.req.param("id"));
  if (!app) return c.json({ error: "Not found" }, 404);
  if (app.platform !== "web") return c.json(notWeb, 400);
  const body = await c.req.json<{ maxPages?: unknown }>().catch(() => ({}) as { maxPages?: unknown });
  const r = await syncPolarOrders(c.env, { appId: app.id, maxPages: typeof body.maxPages === "number" ? body.maxPages : undefined });
  if (r.stored) await bumpDataVersion(c.var.db, wsId(c));
  return c.json(r, r.error && !r.orders ? 400 : 200);
});

appRoutes.patch("/credentials/:id", requirePermission("manage"), async (c) => {
  const body = await c.req.json<{ vendorNumber?: unknown; name?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const row = await c.var.db.prepare("SELECT config FROM credentials WHERE id = ? AND workspace_id = ?").bind(c.req.param("id"), wsId(c)).first<{ config: string }>();
  if (!row) return c.json({ error: "Not found" }, 404);
  const config = JSON.parse(row.config) as Record<string, unknown>;
  if (typeof body.vendorNumber === "string") config.vendorNumber = body.vendorNumber.trim() || undefined;
  await c.var.db
    .prepare("UPDATE credentials SET config = ?, name = COALESCE(?, name), updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(config), normalizeName(body.name), now(), c.req.param("id"))
    .run();
  return c.json({ ok: true });
});

appRoutes.delete("/credentials/:id", requirePermission("manage"), async (c) => {
  await c.var.db.prepare("DELETE FROM credentials WHERE id = ? AND workspace_id = ?").bind(c.req.param("id"), wsId(c)).run();
  // An In-App Purchase key stops signing offers at once in this isolate (other isolates: within 60 s, docs/offers.md).
  forgetWorkspaceOfferContexts(wsId(c));
  // Google Play keys: the database object (where the Play API calls run) forgets its cached accounts and tokens.
  await forgetPlayCaches(c.env, {});
  return c.json({ ok: true });
});

/** New public SDK key for the app (the old one stops working: ship an app update first). */
appRoutes.post("/apps/:id/sdk-key", requirePermission("manage"), async (c) => {
  const app = await getApp(c, c.req.param("id"));
  if (!app) return c.json({ error: "Not found" }, 404);
  const key = `rfp_${randomToken(16)}`;
  await c.var.db.prepare("UPDATE apps SET sdk_key = ?, updated_at = ? WHERE id = ?").bind(key, now(), app.id).run();
  await forgetSdkOfferings(app.sdk_key, c.req.url);
  await forgetSdkRemoteConfig(app.sdk_key, c.req.url);
  forgetSdkApp(app.sdk_key);
  forgetOfferContext(app.sdk_key);
  return c.json({ sdkKey: key });
});
