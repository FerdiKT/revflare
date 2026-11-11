// Workspace setup from App Store Connect: import apps (name, bundle id, icon, where their notifications go), product
// names and periods, and point notification URLs at Revflare.

import { getCredential } from "../lib/credentials";
import { defineDbFunction, type Db } from "../lib/db";
import { baseUrl } from "../lib/settings";
import { errorMessage, newId, now, randomToken } from "../lib/util";
import { AppStoreConnectApi, lookupIcons } from "./connect";

export function notificationUrl(base: string, key: string): string {
  return `${base}/apple/notifications/${key}`;
}

export function urlStatus(url: string | null, base: string): "revflare" | "other" | "none" {
  if (!url) return "none";
  return url.startsWith(`${base}/apple/notifications/`) ? "revflare" : "other";
}

/** Creates or updates an app by bundle id; returns its id. */
export async function upsertApp(
  db: Db,
  workspaceId: string,
  input: { name: string; bundleId: string; appleAppId?: string | null; iconUrl?: string | null; urlStatus?: string; url?: string | null },
): Promise<{ id: string; created: boolean; notificationKey: string }> {
  const existing = await db
    .prepare("SELECT id, notification_key FROM apps WHERE workspace_id = ? AND bundle_id = ? AND platform = 'ios'")
    .bind(workspaceId, input.bundleId)
    .first<{ id: string; notification_key: string }>();
  const t = now();
  if (existing) {
    await db
      .prepare(
        `UPDATE apps SET name = ?, apple_app_id = COALESCE(?, apple_app_id), icon_url = COALESCE(?, icon_url),
         notification_url_status = COALESCE(?, notification_url_status), notification_url = COALESCE(?, notification_url), updated_at = ? WHERE id = ?`,
      )
      .bind(input.name, input.appleAppId ?? null, input.iconUrl ?? null, input.urlStatus ?? null, input.url ?? null, t, existing.id)
      .run();
    return { id: existing.id, created: false, notificationKey: existing.notification_key };
  }
  const id = newId("app_");
  const key = randomToken(18);
  await db
    .prepare(
      `INSERT INTO apps (id, workspace_id, name, platform, bundle_id, apple_app_id, icon_url, notification_key, notification_url_status, notification_url, sdk_key, created_at, updated_at)
       VALUES (?, ?, ?, 'ios', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, workspaceId, input.name, input.bundleId, input.appleAppId ?? null, input.iconUrl ?? null, key, input.urlStatus ?? "unknown", input.url ?? null, `rfp_${randomToken(16)}`, t, t)
    .run();
  return { id, created: true, notificationKey: key };
}

export interface ImportAppsResult {
  apps: { id: string; name: string; bundleId: string; created: boolean; urlStatus: string; urlSet: boolean; error?: string }[];
  error?: string;
}

/**
 * Imports the team's apps from App Store Connect. `setUrls`: "empty" points apps without a notification URL at
 * Revflare; "none" changes nothing in App Store Connect. URLs pointing elsewhere (e.g. RevenueCat) are never replaced:
 * those apps are kept in sync through Notification History instead.
 */
export const importAppsFromConnect = defineDbFunction(
  "importAppsFromConnect",
  async (db, args: { workspaceId: string; setUrls: "empty" | "none"; requestUrl?: string; only?: string[] }, env): Promise<ImportAppsResult> => {
    const cred = await getCredential(env, db, args.workspaceId, "appstore_connect");
    if (!cred) return { apps: [], error: "Add an App Store Connect API key first" };
    const api = new AppStoreConnectApi(cred);
    const base = await baseUrl(env, db, args.requestUrl);
    let apps;
    try {
      apps = await api.listApps();
    } catch (err) {
      return { apps: [], error: errorMessage(err) };
    }
    if (args.only?.length) apps = apps.filter((a) => args.only!.includes(a.bundleId) || args.only!.includes(a.id));
    const icons = await lookupIcons(apps.map((a) => a.id)).catch(() => ({}) as Record<string, string>);
    const out: ImportAppsResult["apps"] = [];
    for (const a of apps) {
      let status = urlStatus(a.subscriptionStatusUrl, base);
      const icon = icons[a.id] || `https://www.appatar.io/${a.bundleId}/large`;
      const r = await upsertApp(db, args.workspaceId, { name: a.name, bundleId: a.bundleId, appleAppId: a.id, iconUrl: icon, urlStatus: status, url: a.subscriptionStatusUrl });
      let urlSet = false;
      let error: string | undefined;
      if (args.setUrls === "empty" && status === "none" && env.TEST_MODE !== "true") {
        const url = notificationUrl(base, r.notificationKey);
        try {
          await api.setNotificationUrl(a.id, url);
          await db.prepare("UPDATE apps SET notification_url_status = 'revflare', notification_url = ? WHERE id = ?").bind(url, r.id).run();
          status = "revflare";
          urlSet = true;
        } catch (err) {
          error = errorMessage(err);
        }
      }
      out.push({ id: r.id, name: a.name, bundleId: a.bundleId, created: r.created, urlStatus: status, urlSet, ...(error ? { error } : {}) });
    }
    return { apps: out };
  },
);

/** Points one app's notification URL at Revflare (replacing whatever is there: the caller confirmed it). */
export const connectNotificationUrl = defineDbFunction(
  "connectNotificationUrl",
  async (db, args: { appId: string; requestUrl?: string }, env): Promise<{ url?: string; forwardUrl?: string; error?: string }> => {
    const app = await db.prepare("SELECT id, workspace_id, apple_app_id, notification_key, notification_url_status, notification_url, forward_url FROM apps WHERE id = ?").bind(args.appId).first<{
      id: string;
      workspace_id: string;
      apple_app_id: string | null;
      notification_key: string;
      notification_url_status: string | null;
      notification_url: string | null;
      forward_url: string | null;
    }>();
    if (!app?.apple_app_id) return { error: "The app has no App Store id" };
    const cred = await getCredential(env, db, app.workspace_id, "appstore_connect");
    if (!cred) return { error: "Add an App Store Connect API key first" };
    const url = notificationUrl(await baseUrl(env, db, args.requestUrl), app.notification_key);
    try {
      await new AppStoreConnectApi(cred).setNotificationUrl(app.apple_app_id, url);
    } catch (err) {
      return { error: errorMessage(err) };
    }
    // The service whose URL this replaces (e.g. RevenueCat) keeps getting every notification through forwarding.
    const previous = app.notification_url_status === "other" && app.notification_url && !app.forward_url ? app.notification_url : null;
    await db
      .prepare("UPDATE apps SET notification_url_status = 'revflare', notification_url = ?, forward_url = COALESCE(?, forward_url), updated_at = ? WHERE id = ?")
      .bind(url, previous, now(), app.id)
      .run();
    return { url, ...(previous ? { forwardUrl: previous } : {}) };
  },
);

/** Product names, types and billing periods from App Store Connect (a few apps per call). */
export const syncProducts = defineDbFunction(
  "syncProducts",
  async (db, args: { workspaceId: string; appIds?: string[]; limit?: number }, env): Promise<{ apps: number; products: number; errors: string[] }> => {
    const cred = await getCredential(env, db, args.workspaceId, "appstore_connect");
    if (!cred) return { apps: 0, products: 0, errors: ["Add an App Store Connect API key first"] };
    const api = new AppStoreConnectApi(cred);
    const { results: apps } = args.appIds?.length
      ? await db
          .prepare(`SELECT id, apple_app_id FROM apps WHERE workspace_id = ? AND apple_app_id IS NOT NULL AND id IN (${args.appIds.map(() => "?").join(",")})`)
          .bind(args.workspaceId, ...args.appIds)
          .all<{ id: string; apple_app_id: string }>()
      : await db
          .prepare(
            `SELECT id, apple_app_id FROM apps WHERE workspace_id = ? AND apple_app_id IS NOT NULL AND archived = 0
             ORDER BY (SELECT MAX(updated_at) FROM products p WHERE p.app_id = apps.id) IS NOT NULL, (SELECT MAX(updated_at) FROM products p WHERE p.app_id = apps.id) LIMIT ?`,
          )
          .bind(args.workspaceId, args.limit ?? 10)
          .all<{ id: string; apple_app_id: string }>();
    let count = 0;
    const errors: string[] = [];
    const t = now();
    for (const app of apps) {
      try {
        const products = await api.listProducts(app.apple_app_id);
        if (products.length) {
          await db.batch(
            products.map((p) =>
              db
                .prepare(
                  `INSERT INTO products (app_id, product_id, workspace_id, type, name, period, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(app_id, product_id) DO UPDATE SET name = excluded.name, type = excluded.type,
                   period = COALESCE(excluded.period, products.period), updated_at = excluded.updated_at`,
                )
                .bind(app.id, p.productId, args.workspaceId, p.type, p.name, p.period, t, t),
            ),
          );
        } else {
          // Remember the check so apps without products do not stay first in line.
          await db
            .prepare(
              `INSERT INTO products (app_id, product_id, workspace_id, type, name, created_at, updated_at) VALUES (?, '', ?, NULL, NULL, ?, ?)
               ON CONFLICT(app_id, product_id) DO UPDATE SET updated_at = excluded.updated_at`,
            )
            .bind(app.id, args.workspaceId, t, t)
            .run();
        }
        count += products.length;
        await db.prepare("INSERT INTO rollup_queue (app_id, queued_at) VALUES (?, ?) ON CONFLICT(app_id) DO NOTHING").bind(app.id, t).run();
      } catch (err) {
        errors.push(`${app.apple_app_id}: ${errorMessage(err)}`);
      }
    }
    return { apps: apps.length, products: count, errors };
  },
);
