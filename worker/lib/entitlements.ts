// Server-driven entitlements and non-renewing durations of an app (RevflareKit 1.9+, docs/api.md#entitlements).
//
// Storage: `offering_configs.entitlements` (JSON, next to the offerings of the app). Every change runs inside the
// database object (`changeEntitlements`): read the row, apply, validate, write the row back with the rebuilt RevflareKit
// payload (`sdk_json`, `version`), so GET /sdk/v1/offerings keeps serving one prebuilt, cached row.
//
// Durations also shape the ledger: a one-time transaction of a product with a duration gets expires_at = purchase +
// duration (worker/lib/ledger.ts; never non-consumables or subscriptions). A duration set, changed or removed later
// recomputes the stored transactions of that product (idx_tx_app_product_onetime; writes only rows whose expiry
// changes): day / week / removal in one UPDATE, month / year in batches of RECOMPUTE_BATCH rows, the rest continued by
// the cron (continuePassRecompute, metered). Durations are refused for products known to be non-consumable or
// auto-renewable (a duration on a lifetime product would end paying customers' access). Non-renewing purchases stay
// one-time revenue: they never count in MRR or active subscriptions.

import type { EntitlementsChange, EntitlementsConfig, ProductDuration } from "../../shared/types";
import { defineDbFunction, type Db } from "./db";
import {
  addDuration,
  entitlementsPayload,
  normalize,
  parseDuration,
  parseEntitlementsInput,
  readStoredEntitlements,
  validEntitlementId,
  validProductId,
  type StoredEntitlements,
} from "./entitlement-config";
import { backgroundAllowed, metered } from "./budget";
import { bumpDataVersion } from "./metrics";
import { EMPTY_CONFIG, sdkPayload, type StoredConfig } from "./offerings";
import { now, parseJson } from "./util";

export type EntitlementsOp =
  | { kind: "replace"; body: unknown }
  | { kind: "set"; entitlement: string; productIds: unknown }
  | { kind: "addProducts"; entitlement: string; productIds: unknown }
  | { kind: "removeProduct"; entitlement: string; productId: string }
  | { kind: "delete"; entitlement: string }
  | { kind: "setDuration"; productId: string; duration: unknown }
  | { kind: "deleteDuration"; productId: string };

type Fail = { error: string; status: 400 | 404 };

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/** Applies a change; the result goes through the same validation as a PUT. */
export function applyEntitlementsOp(e: StoredEntitlements, op: EntitlementsOp): { value: StoredEntitlements; status: 200 | 201 } | Fail {
  const fail = (error: string, status: 400 | 404 = 400): Fail => ({ error, status });
  const done = (next: StoredEntitlements, status: 200 | 201 = 200) => {
    const r = parseEntitlementsInput({ entitlements: next.entitlements, durations: next.durations }, e);
    return "error" in r ? fail(r.error) : { value: r, status };
  };
  const badId = (v: unknown) => `Entitlement ${JSON.stringify(v)} is not a valid identifier (letters, digits, _ . $ -, at most 64 characters)`;
  switch (op.kind) {
    case "replace":
      return (() => {
        const r = parseEntitlementsInput(op.body, e);
        return "error" in r ? fail(r.error) : { value: r, status: 200 as const };
      })();
    case "set": {
      if (!validEntitlementId(op.entitlement)) return fail(badId(op.entitlement));
      if (!Array.isArray(op.productIds)) return fail("productIds must be a list of product ids");
      const exists = op.entitlement in e.entitlements;
      return done({ ...e, entitlements: { ...e.entitlements, [op.entitlement]: op.productIds as string[] } }, exists ? 200 : 201);
    }
    case "addProducts": {
      if (!validEntitlementId(op.entitlement)) return fail(badId(op.entitlement));
      const add = list(op.productIds);
      if (!add.length) return fail("productIds must list at least one product id");
      const exists = op.entitlement in e.entitlements;
      return done({ ...e, entitlements: { ...e.entitlements, [op.entitlement]: [...(e.entitlements[op.entitlement] ?? []), ...(add as string[])] } }, exists ? 200 : 201);
    }
    case "removeProduct": {
      const ids = e.entitlements[op.entitlement];
      if (!ids) return fail(`No entitlement "${op.entitlement}"`, 404);
      if (!ids.includes(op.productId)) return fail(`Entitlement "${op.entitlement}" has no product "${op.productId}"`, 404);
      return done({ ...e, entitlements: { ...e.entitlements, [op.entitlement]: ids.filter((p) => p !== op.productId) } });
    }
    case "delete": {
      if (!(op.entitlement in e.entitlements)) return fail(`No entitlement "${op.entitlement}"`, 404);
      const { [op.entitlement]: _, ...rest } = e.entitlements;
      return done({ ...e, entitlements: rest });
    }
    case "setDuration": {
      if (!validProductId(op.productId)) return fail(`${JSON.stringify(op.productId)} is not a product id`);
      const d = parseDuration(op.duration, `Duration of "${op.productId}"`);
      if ("error" in d) return fail(d.error);
      const exists = op.productId in e.durations;
      return done({ ...e, durations: { ...e.durations, [op.productId]: d } }, exists ? 200 : 201);
    }
    case "deleteDuration": {
      if (!(op.productId in e.durations)) return fail(`No duration for "${op.productId}"`, 404);
      const { [op.productId]: _, ...rest } = e.durations;
      return done({ ...e, durations: rest });
    }
  }
}

export function entitlementsView(e: StoredEntitlements, updatedAt: number | null): EntitlementsConfig {
  return {
    entitlements: Object.keys(e.entitlements)
      .sort()
      .map((identifier) => ({ identifier, productIds: e.entitlements[identifier] })),
    durations: Object.keys(e.durations)
      .sort()
      .map((productId) => ({ productId, ...e.durations[productId] })),
    updatedAt,
    preview: entitlementsPayload(e),
  };
}

/** Product types whose transactions never take a duration: lifetime purchases and subscriptions. */
const NO_DURATION_TYPES: Record<string, string> = {
  non_consumable: "a non-consumable (lifetime) product",
  auto_renewable: "an auto-renewable subscription",
};

/** Product ids the app does not know (from App Store Connect / sales), durations on products that take none, Android one-time products with a duration. */
export function entitlementWarnings(e: StoredEntitlements, products: { product_id: string; type: string | null }[], platform = "ios"): string[] {
  const known = new Map(products.map((p) => [p.product_id, p.type]));
  const used = [...new Set([...Object.values(e.entitlements).flat(), ...Object.keys(e.durations)])].sort();
  const out: string[] = [];
  if (used.length && !known.size) out.push("The app has no known products yet (sync products from App Store Connect on the app page): product ids were not checked.");
  else for (const p of used) if (!known.has(p)) out.push(`Product "${p}" is not one of the app's known products.`);
  for (const p of Object.keys(e.durations)) {
    const type = known.get(p);
    if (type === "auto_renewable" || type === "non_consumable") out.push(`Product "${p}" is ${NO_DURATION_TYPES[type]}: its duration is ignored (remove it; only non-renewing / one-time passes use one).`);
    else if (type === "consumable" && platform === "android") out.push(`Product "${p}" is a Google Play one-time product: RevflareKit treats it as a pass that expires. Never give a duration to a lifetime product.`);
    else if (type === "consumable") out.push(`Product "${p}" is a consumable: on iOS only non-renewing subscriptions use a duration (consumables never grant entitlements).`);
  }
  for (const [name, ids] of Object.entries(e.entitlements)) if (!ids.length) out.push(`Entitlement "${name}" has no products: it grants nothing.`);
  return out;
}

interface Row {
  id: string;
  workspace_id: string;
  sdk_key: string | null;
  platform: string | null;
  config: string | null;
  entitlements: string | null;
}

const ROW_SQL =
  "SELECT a.id, a.workspace_id, a.sdk_key, a.platform, o.config, o.entitlements FROM apps a LEFT JOIN offering_configs o ON o.app_id = a.id WHERE a.id = ? AND a.workspace_id = ?";

const updatedAtOf = (json: string | null) => parseJson<{ updatedAt?: number }>(json, {}).updatedAt ?? null;

/** GET /apps/:id/entitlements (null: no such app in the workspace). One indexed read. */
export async function readEntitlements(db: Db, workspaceId: string, appId: string): Promise<EntitlementsConfig | null> {
  const row = await db.prepare(ROW_SQL).bind(appId, workspaceId).first<Row>();
  if (!row) return null;
  return entitlementsView(readStoredEntitlements(row.entitlements), updatedAtOf(row.entitlements));
}

/** The durations of an app (the ledger: one primary-key read, only for one-time transactions without an expiry). */
export async function appDurations(db: Db, appId: string): Promise<Record<string, ProductDuration>> {
  const row = await db.prepare("SELECT entitlements FROM offering_configs WHERE app_id = ?").bind(appId).first<{ entitlements: string | null }>();
  return readStoredEntitlements(row?.entitlements).durations;
}

/**
 * The known type of a product that refuses a duration (null: unknown or a type that takes one). From the product
 * catalog (App Store Connect sync, and every sale: worker/lib/ledger.ts ensureProduct) and, as a second source, the
 * stored transactions of the product (one seek on the partial index idx_tx_app_product_onetime). Google Play one-time
 * products are stored as `consumable` (Play does not say whether they are lifetime): they are allowed.
 */
export async function refusedDurationType(db: Db, appId: string, productId: string): Promise<string | null> {
  const p = await db.prepare("SELECT type FROM products WHERE app_id = ? AND product_id = ?").bind(appId, productId).first<{ type: string | null }>();
  if (p?.type && p.type in NO_DURATION_TYPES) return p.type;
  const t = await db
    .prepare("SELECT product_type FROM transactions WHERE app_id = ? AND product_id = ? AND product_type != 'auto_renewable' AND product_type = 'non_consumable' LIMIT 1")
    .bind(appId, productId)
    .first<{ product_type: string }>();
  return t ? t.product_type : null;
}

/** Rows read (and at most written) per call for month / year durations; the rest continues from the cron. */
export const RECOMPUTE_BATCH = 5000;
const PENDING_PREFIX = "pass_recompute:";
const pendingKey = (appId: string, productId: string) => `${PENDING_PREFIX}${appId}:${productId}`;
interface Pending {
  appId: string;
  productId: string;
  /** Last transactions.rowid done. */
  after: number;
}

/** The transactions of a product that take a duration (the WHERE repeats the partial index's condition so it is used). */
const PASS_ROWS = "app_id = ? AND product_id = ? AND product_type != 'auto_renewable' AND product_type != 'non_consumable'";

/**
 * One step of recomputing the expiry of an app's stored one-time transactions of a product after its duration changed
 * (null: removed → no expiry). Writes only rows whose expiry changes.
 * - day / week / removed: one UPDATE (purchase + fixed milliseconds), whatever the number of rows;
 * - month / year (calendar math): at most RECOMPUTE_BATCH rows from `after` (rowid order, an index range), one UPDATE
 *   per changed row; `next` is the rowid to continue from, null when done.
 */
export async function recomputePassExpiry(
  db: Db,
  appId: string,
  productId: string,
  duration: ProductDuration | null,
  after = 0,
  limit = RECOMPUTE_BATCH,
): Promise<{ changed: number; next: number | null }> {
  const t = now();
  if (!duration) {
    const r = await db.prepare(`UPDATE transactions SET expires_at = NULL, updated_at = ? WHERE ${PASS_ROWS} AND expires_at IS NOT NULL`).bind(t, appId, productId).run();
    return { changed: r.meta.changes ?? 0, next: null };
  }
  if (duration.unit === "day" || duration.unit === "week") {
    const ms = (duration.unit === "day" ? 1 : 7) * duration.count * 86_400_000;
    const r = await db
      .prepare(`UPDATE transactions SET expires_at = purchased_at + ?, updated_at = ? WHERE ${PASS_ROWS} AND (expires_at IS NULL OR expires_at != purchased_at + ?)`)
      .bind(ms, t, appId, productId, ms)
      .run();
    return { changed: r.meta.changes ?? 0, next: null };
  }
  const { results } = await db
    .prepare(`SELECT rowid AS rid, id, purchased_at, expires_at FROM transactions WHERE ${PASS_ROWS} AND rowid > ? ORDER BY rowid LIMIT ?`)
    .bind(appId, productId, after, limit)
    .all<{ rid: number; id: string; purchased_at: number; expires_at: number | null }>();
  let changed = 0;
  for (const r of results) {
    const expires = addDuration(r.purchased_at, duration);
    if (expires === r.expires_at) continue;
    await db.prepare("UPDATE transactions SET expires_at = ?, updated_at = ? WHERE id = ?").bind(expires, t, r.id).run();
    changed++;
  }
  return { changed, next: results.length === limit ? results[results.length - 1].rid : null };
}

/** Records (or clears) the place a month / year recompute continues from (cron: continuePassRecompute). */
async function setPending(db: Db, appId: string, productId: string, next: number | null) {
  if (next === null) await db.prepare("DELETE FROM settings WHERE key = ?").bind(pendingKey(appId, productId)).run();
  else
    await db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(pendingKey(appId, productId), JSON.stringify({ appId, productId, after: next } satisfies Pending))
      .run();
}

/**
 * Continues month / year recomputes left over by large changes: one batch of the oldest pending product, with the
 * product's current duration. Background work: metered and skipped once the daily budget is spent
 * (worker/lib/budget.ts). Called from the cron; reads one settings row when nothing is pending.
 */
export async function continuePassRecompute(db: Db, env: Env): Promise<{ appId: string; productId: string; changed: number; done: boolean } | null> {
  const row = await db
    .prepare("SELECT key, value FROM settings WHERE key >= ? AND key < ? ORDER BY key LIMIT 1")
    .bind(PENDING_PREFIX, PENDING_PREFIX.slice(0, -1) + ";")
    .first<{ key: string; value: string }>();
  if (!row) return null;
  const p = parseJson<Pending | null>(row.value, null);
  if (!p) {
    await db.prepare("DELETE FROM settings WHERE key = ?").bind(row.key).run();
    return null;
  }
  if (!(await backgroundAllowed(db, env))) return { appId: p.appId, productId: p.productId, changed: 0, done: false };
  return metered(db, async () => {
    const cfg = await db
      .prepare("SELECT a.workspace_id, o.entitlements FROM apps a LEFT JOIN offering_configs o ON o.app_id = a.id WHERE a.id = ?")
      .bind(p.appId)
      .first<{ workspace_id: string; entitlements: string | null }>();
    if (!cfg) {
      await setPending(db, p.appId, p.productId, null);
      return { appId: p.appId, productId: p.productId, changed: 0, done: true };
    }
    const duration = readStoredEntitlements(cfg.entitlements).durations[p.productId] ?? null;
    const r = await recomputePassExpiry(db, p.appId, p.productId, duration, p.after);
    await setPending(db, p.appId, p.productId, r.next);
    if (r.changed) await bumpDataVersion(db, cfg.workspace_id);
    return { appId: p.appId, productId: p.productId, changed: r.changed, done: r.next === null };
  });
}

export type EntitlementsResult = { status: 200 | 201; result: EntitlementsChange; sdkKey: string | null } | { status: 400 | 404; error: string };

/** Applies one change inside the database object (atomic read-modify-write). Writes only when something changed. */
export const changeEntitlements = defineDbFunction(
  "entitlements.change",
  async (db, args: { workspaceId: string; appId: string; op: EntitlementsOp }): Promise<EntitlementsResult> => {
    const row = await db.prepare(ROW_SQL).bind(args.appId, args.workspaceId).first<Row>();
    if (!row) return { status: 404, error: "Not found" };
    const before = readStoredEntitlements(row.entitlements);
    const r = applyEntitlementsOp(before, args.op);
    if ("error" in r) return { status: r.status, error: r.error };
    const next = normalize(r.value);
    const same = (a?: ProductDuration, b?: ProductDuration) => !!a && !!b && a.unit === b.unit && a.count === b.count;
    const changed = [...new Set([...Object.keys(before.durations), ...Object.keys(next.durations)])].filter((p) => !same(before.durations[p], next.durations[p])).sort();
    // A duration never applies to a lifetime product or a subscription: a mistake there would take access away from
    // paying customers (RevflareKit stops granting at the "end").
    for (const p of changed) {
      if (!next.durations[p]) continue;
      const type = await refusedDurationType(db, row.id, p);
      if (type) {
        return {
          status: 400,
          error: `Product "${p}" is ${NO_DURATION_TYPES[type]}: it cannot have a duration (only non-renewing subscriptions and one-time passes can). Lifetime products and subscriptions never expire through a duration.`,
        };
      }
    }
    let updatedAt = updatedAtOf(row.entitlements);
    let updatedTransactions = 0;
    let truncated = false;
    if (JSON.stringify(next) !== JSON.stringify(before)) {
      const at = now();
      updatedAt = at;
      const config = parseJson<StoredConfig>(row.config, EMPTY_CONFIG);
      const sdk = sdkPayload(config, next);
      await db
        .prepare(
          `INSERT INTO offering_configs (app_id, config, sdk_json, version, updated_at, entitlements) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(app_id) DO UPDATE SET sdk_json = excluded.sdk_json, version = excluded.version, entitlements = excluded.entitlements`,
        )
        .bind(row.id, row.config ?? JSON.stringify(EMPTY_CONFIG), JSON.stringify(sdk), sdk.version, at, JSON.stringify({ ...next, updatedAt: at }))
        .run();
      // Durations added, changed or removed: the stored passes of those products get their expiry recomputed (month /
      // year: the first batch now, the rest from the cron).
      for (const p of changed) {
        const r = await recomputePassExpiry(db, row.id, p, next.durations[p] ?? null);
        updatedTransactions += r.changed;
        await setPending(db, row.id, p, r.next);
        if (r.next !== null) truncated = true;
      }
      if (updatedTransactions) await bumpDataVersion(db, row.workspace_id);
    }
    const { results } = await db.prepare("SELECT product_id, type FROM products WHERE app_id = ? AND product_id != ''").bind(row.id).all<{ product_id: string; type: string | null }>();
    return {
      status: r.status,
      result: { ...entitlementsView(next, updatedAt), warnings: entitlementWarnings(next, results, row.platform ?? "ios"), updatedTransactions, truncated },
      sdkKey: row.sdk_key,
    };
  },
);
