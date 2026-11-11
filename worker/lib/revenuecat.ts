// RevenueCat import.
//
// 1. Discovery (server side, secret API key v2): walks the project's customers and collects their App Store
//    transaction ids (subscriptions' original transaction id, purchases' transaction id). Apple's Get Transaction
//    History then fills in every transaction with Apple's own data (worker/apple/ingest.ts) — Apple stays the single
//    source of truth, RevenueCat only tells us which ids exist (including customers who left more than 180 days ago).
// 2. Charts (pushed by `revflare import revenuecat-charts`, which reads RevenueCat Charts with the user's local
//    RevenueCat login): daily revenue, MRR, actives... for the time before Revflare's own data (external_metrics).

import { backgroundAllowed, metered } from "./budget";
import { getCredential } from "./credentials";
import { defineDbFunction, type Db } from "./db";
import { bumpDataVersion } from "./metrics";
import { errorMessage, now, parseJson } from "./util";

const RC = "https://api.revenuecat.com/v2";

export const EXTERNAL_METRICS = ["revenue", "proceeds", "mrr", "active_subscriptions", "active_trials", "new_customers", "new_subscriptions", "trials_started", "refunds", "churned_subscriptions"] as const;

class RcError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

async function rc<T>(apiKey: string, path: string): Promise<T> {
  const res = await fetch(RC + path, { headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text();
    let msg = text.slice(0, 200);
    try {
      msg = (JSON.parse(text) as { message?: string }).message ?? msg;
    } catch {}
    throw new RcError(`RevenueCat ${res.status}: ${msg}`, res.status, Number(res.headers.get("retry-after")) || undefined);
  }
  return (await res.json()) as T;
}

interface RcList<T> {
  items: T[];
  next_page: string | null;
}

interface Cursor {
  startingAfter?: string;
  customers: number;
  ids: number;
  appMap?: Record<string, string>;
}

/** Maps RevenueCat app ids (App Store apps of the project) to Revflare apps by bundle id. */
async function appMap(db: Db, workspaceId: string, apiKey: string, projectId: string): Promise<Record<string, string>> {
  const apps = await rc<RcList<{ id: string; type: string; app_store?: { bundle_id?: string } }>>(apiKey, `/projects/${projectId}/apps?limit=100`);
  const out: Record<string, string> = {};
  for (const a of apps.items) {
    const bundle = a.app_store?.bundle_id;
    if (a.type !== "app_store" || !bundle) continue;
    const row = await db.prepare("SELECT id FROM apps WHERE workspace_id = ? AND bundle_id = ? AND platform = 'ios'").bind(workspaceId, bundle).first<{ id: string }>();
    if (row) {
      out[a.id] = row.id;
      await db.prepare("UPDATE apps SET rc_project_id = COALESCE(rc_project_id, ?) WHERE id = ?").bind(projectId, row.id).run();
    }
  }
  return out;
}

/**
 * One round of discovery: a page of customers and, per customer, their subscriptions and purchases (2 requests each).
 * The cursor is kept in settings; returns done when the last page is through.
 */
export const discoverRevenueCat = defineDbFunction(
  "discoverRevenueCat",
  async (db, args: { workspaceId: string; credentialId: string; maxRequests?: number }, env): Promise<{ done: boolean; customers: number; ids: number; error?: string; rateLimited?: boolean; budget?: boolean }> => {
    if (!(await backgroundAllowed(db, env))) return { done: false, customers: 0, ids: 0, budget: true };
    const cred = await getCredential(env, db, args.workspaceId, "revenuecat", args.credentialId);
    const projectId = cred?.config.projectId as string | undefined;
    if (!cred?.secret.apiKey || !projectId) return { done: true, customers: 0, ids: 0, error: "RevenueCat key or project id missing" };
    const key = `rc_discovery:${cred.id}`;
    const cursor = parseJson<Cursor>((await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>())?.value, { customers: 0, ids: 0 });
    let requests = 0;
    const max = args.maxRequests ?? 40;
    const save = () => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, JSON.stringify(cursor)).run();
    try {
      if (!cursor.appMap) {
        cursor.appMap = await appMap(db, args.workspaceId, cred.secret.apiKey, projectId);
        requests++;
        if (!Object.keys(cursor.appMap).length) return { done: true, customers: 0, ids: 0, error: "None of the project's App Store apps are in this workspace (matched by bundle id)" };
      }
      const perPage = Math.max(1, Math.floor((max - requests - 1) / 2));
      const q = new URLSearchParams({ limit: String(Math.min(perPage, 100)) });
      if (cursor.startingAfter) q.set("starting_after", cursor.startingAfter);
      const page = await rc<RcList<{ id: string }>>(cred.secret.apiKey, `/projects/${projectId}/customers?${q}`);
      requests++;
      const found: { appId: string; id: string }[] = [];
      for (const cust of page.items) {
        const cid = encodeURIComponent(cust.id);
        const [subs, purchases] = await Promise.all([
          rc<RcList<{ app_id?: string; store?: string; store_subscription_identifier?: string; environment?: string }>>(cred.secret.apiKey, `/projects/${projectId}/customers/${cid}/subscriptions?limit=100`),
          rc<RcList<{ app_id?: string; store?: string; store_purchase_identifier?: string; environment?: string }>>(cred.secret.apiKey, `/projects/${projectId}/customers/${cid}/purchases?limit=100`),
        ]);
        requests += 2;
        for (const s of subs.items) {
          const appId = s.app_id ? cursor.appMap[s.app_id] : undefined;
          if (appId && s.store === "app_store" && s.store_subscription_identifier && s.environment !== "sandbox") found.push({ appId, id: s.store_subscription_identifier });
        }
        for (const p of purchases.items) {
          const appId = p.app_id ? cursor.appMap[p.app_id] : undefined;
          if (appId && p.store === "app_store" && p.store_purchase_identifier && p.environment !== "sandbox") found.push({ appId, id: p.store_purchase_identifier });
        }
        cursor.startingAfter = cust.id;
        cursor.customers++;
      }
      if (found.length) {
        await db.batch(
          found.map((f) =>
            db.prepare("INSERT INTO pending_history (app_id, transaction_id, source, created_at) VALUES (?, ?, 'revenuecat', ?) ON CONFLICT DO NOTHING").bind(f.appId, f.id, now()),
          ),
        );
        cursor.ids += found.length;
      }
      const done = !page.next_page || !page.items.length;
      if (done) await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
      else await save();
      return { done, customers: cursor.customers, ids: cursor.ids };
    } catch (err) {
      await save();
      if (err instanceof RcError && err.status === 429) return { done: false, customers: cursor.customers, ids: cursor.ids, rateLimited: true };
      return { done: false, customers: cursor.customers, ids: cursor.ids, error: errorMessage(err) };
    }
  },
);

/** Stores imported daily values (USD for money metrics) for one app. */
export const storeExternalMetrics = defineDbFunction(
  "storeExternalMetrics",
  async (db, args: { workspaceId: string; appId: string; source: string; metric: string; points: { day: string; value: number }[] }, env): Promise<{ stored: number; budget?: boolean }> => {
    if (!(await backgroundAllowed(db, env))) return { stored: 0, budget: true };
    return metered(db, () => storePoints(db, args));
  },
);

async function storePoints(db: Db, args: { workspaceId: string; appId: string; source: string; metric: string; points: { day: string; value: number }[] }): Promise<{ stored: number }> {
  {
    const app = await db.prepare("SELECT id FROM apps WHERE id = ? AND workspace_id = ?").bind(args.appId, args.workspaceId).first();
    if (!app) throw new Error("App not found");
    const pts = args.points.filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.day) && Number.isFinite(p.value));
    for (let i = 0; i < pts.length; i += 200) {
      await db.batch(
        pts.slice(i, i + 200).map((p) =>
          db
            .prepare(
              `INSERT INTO external_metrics (workspace_id, app_id, source, metric, day, value) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(app_id, source, metric, day) DO UPDATE SET value = excluded.value WHERE external_metrics.value != excluded.value`,
            )
            .bind(args.workspaceId, args.appId, args.source, args.metric, p.day, p.value),
        ),
      );
    }
    const last = pts.reduce((m, p) => (p.day > m ? p.day : m), "");
    if (last) {
      await db.prepare("UPDATE apps SET external_until = MAX(COALESCE(external_until, ''), ?) WHERE id = ?").bind(last, args.appId).run();
      await bumpDataVersion(db, args.workspaceId);
    }
    return { stored: pts.length };
  }
}

/** What has been imported per app and metric (first/last day, count). */
export const externalMetricsSummary = defineDbFunction(
  "externalMetricsSummary",
  async (db, args: { workspaceId: string; appId?: string | null; source: string }) => {
    const { results: apps } = await db
      .prepare(`SELECT id FROM apps WHERE workspace_id = ? AND external_until IS NOT NULL${args.appId ? " AND id = ?" : ""}`)
      .bind(args.workspaceId, ...(args.appId ? [args.appId] : []))
      .all<{ id: string }>();
    const items = [];
    for (const a of apps) {
      const { results } = await db
        .prepare("SELECT metric, MIN(day) AS first, MAX(day) AS last, COUNT(*) AS days FROM external_metrics WHERE app_id = ? AND source = ? GROUP BY metric")
        .bind(a.id, args.source)
        .all<{ metric: string; first: string; last: string; days: number }>();
      for (const r of results) items.push({ appId: a.id, ...r });
    }
    return { items };
  },
);
