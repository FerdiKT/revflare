// Reconciliation with Apple's Sales and Trends daily summary reports: Apple's own unit counts and developer proceeds
// per product, country and day. They replace the estimated proceeds of matching transactions and show where Revflare
// is missing sales (reconciliation report).

import { reportCredentials } from "../lib/credentials";
import { defineDbFunction, type Db } from "../lib/db";
import { FxCache, addDays, dayOf, dayStart } from "../lib/money";
import { errorMessage, now } from "../lib/util";
import { AppStoreConnectApi, AscError } from "./connect";

const DAY = 86_400_000;

export interface SalesRow {
  day: string;
  sku: string;
  appleId: string;
  parentId: string;
  country: string;
  productType: string;
  /** Paid units net of refunds. */
  units: number;
  /** Units at no charge: free trial starts, free downloads. */
  freeUnits: number;
  /** Net of refunds. */
  proceedsUsd: number;
  customerPriceUsd: number;
  /** Paid units and their proceeds without refunds: Apple's proceeds per sold unit. */
  soldUnits: number;
  soldProceedsUsd: number;
}

/**
 * Aggregates report rows (one per SKU / country / price point / offer) to SKU / country / product type. Apple writes a
 * refund as negative Units with a negative Customer Price and a positive Developer Proceeds per unit; free trial starts
 * and free downloads are rows with a Customer Price of 0.
 */
export async function aggregateReport(fx: FxCache, day: string, rows: Record<string, string>[]): Promise<SalesRow[]> {
  const out = new Map<string, SalesRow>();
  for (const r of rows) {
    const units = Number(r["Units"] ?? 0);
    if (!units) continue;
    const sku = r["SKU"] ?? "";
    const country = (r["Country Code"] ?? "").toUpperCase();
    const productType = r["Product Type Identifier"] ?? "";
    const unitPrice = Math.abs(Number(r["Customer Price"] ?? 0));
    const free = unitPrice === 0;
    const proceedsUsd = await fx.toUsd(Math.abs(Number(r["Developer Proceeds"] ?? 0)) * units, r["Currency of Proceeds"], day);
    const priceUsd = await fx.toUsd(unitPrice * units, r["Customer Currency"], day);
    const key = `${sku}|${country}|${productType}`;
    const cur =
      out.get(key) ??
      out
        .set(key, { day, sku, appleId: r["Apple Identifier"] ?? "", parentId: r["Parent Identifier"] ?? "", country, productType, units: 0, freeUnits: 0, proceedsUsd: 0, customerPriceUsd: 0, soldUnits: 0, soldProceedsUsd: 0 })
        .get(key)!;
    if (free) {
      if (units > 0) cur.freeUnits += units;
      continue;
    }
    cur.units += units;
    cur.proceedsUsd += proceedsUsd;
    cur.customerPriceUsd += priceUsd;
    if (units > 0) {
      cur.soldUnits += units;
      cur.soldProceedsUsd += proceedsUsd;
    }
  }
  return [...out.values()];
}

/** Pacific-time day window (Sales and Trends days are Pacific time) as UTC ms, approximated as UTC-8/UTC-7. */
function pacificWindow(day: string): [number, number] {
  const month = Number(day.slice(5, 7));
  const offset = month >= 4 && month <= 10 ? 7 : 8;
  const start = dayStart(day) + offset * 3_600_000;
  return [start, start + DAY];
}

async function storeAndApply(db: Db, workspaceId: string, day: string, rows: SalesRow[]) {
  const { results: products } = await db
    .prepare("SELECT app_id, product_id FROM products WHERE workspace_id = ? AND product_id != ''")
    .bind(workspaceId)
    .all<{ app_id: string; product_id: string }>();
  const appBySku = new Map(products.map((p) => [p.product_id, p.app_id]));
  const { results: apps } = await db.prepare("SELECT id, apple_app_id FROM apps WHERE workspace_id = ?").bind(workspaceId).all<{ id: string; apple_app_id: string | null }>();
  const appByAppleId = new Map(apps.filter((a) => a.apple_app_id).map((a) => [a.apple_app_id!, a.id]));
  const stmts = [db.prepare("DELETE FROM sales_reports WHERE workspace_id = ? AND day = ?").bind(workspaceId, day)];
  const [from, to] = pacificWindow(day);
  for (const r of rows) {
    const appId = appBySku.get(r.sku) ?? appByAppleId.get(r.appleId) ?? null;
    stmts.push(
      db
        .prepare(
          `INSERT INTO sales_reports (workspace_id, app_id, day, sku, apple_id, country, product_type, units, free_units, proceeds_usd, customer_price_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, day, sku, country, product_type) DO UPDATE SET
           units = excluded.units, free_units = excluded.free_units, proceeds_usd = excluded.proceeds_usd, customer_price_usd = excluded.customer_price_usd, app_id = excluded.app_id`,
        )
        .bind(workspaceId, appId, day, r.sku, r.appleId, r.country, r.productType, r.units, r.freeUnits, r.proceedsUsd, r.customerPriceUsd),
    );
    // Apple's proceeds per unit replace the estimate of the paid transactions of that product, country and day.
    if (appId && r.soldUnits > 0 && r.soldProceedsUsd > 0 && appBySku.has(r.sku)) {
      stmts.push(
        db
          .prepare(
            `UPDATE transactions SET proceeds_usd = ?, proceeds_reported = 1 WHERE app_id = ? AND product_id = ? AND country = ?
             AND purchased_at >= ? AND purchased_at < ? AND gross_usd > 0 AND environment = 'Production'`,
          )
          .bind(r.soldProceedsUsd / r.soldUnits, appId, r.sku, r.country, from, to),
      );
    }
  }
  const touched = new Set(rows.map((r) => appBySku.get(r.sku) ?? appByAppleId.get(r.appleId)).filter(Boolean) as string[]);
  for (const appId of touched) {
    stmts.push(db.prepare("INSERT INTO rollup_queue (app_id, queued_at) VALUES (?, ?) ON CONFLICT(app_id) DO NOTHING").bind(appId, now()));
  }
  stmts.push(
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(`sales_report:${workspaceId}:${day}`, rows.length ? "ok" : "empty"),
  );
  await db.batch(stmts);
}

/**
 * Fetches the daily summary reports Revflare does not have yet (newest first, the last `days` days, at most
 * `maxRequests` downloads). Needs an App Store Connect key with the Sales (or Finance/Admin) role and the vendor number.
 */
export const syncSalesReports = defineDbFunction(
  "syncSalesReports",
  async (db, args: { workspaceId: string; days?: number; maxRequests?: number }, env): Promise<{ fetched: string[]; missing: string[]; error?: string }> => {
    // The reports key (appstore_reports) first, then the main key; the vendor number is the account's, from either.
    const creds = await reportCredentials(env, db, args.workspaceId);
    const vendor = creds.map((c) => c.config.vendorNumber as string | undefined).find(Boolean);
    if (!creds.length || !vendor) return { fetched: [], missing: [], error: "Add an App Store Connect key with the Sales role and the vendor number" };
    let keyIndex = 0;
    let api = new AppStoreConnectApi(creds[0]);
    const fx = new FxCache(db);
    const fetched: string[] = [];
    const missing: string[] = [];
    const yesterday = dayOf(now() - DAY);
    const days = args.days ?? 14;
    const { results: done } = await db
      .prepare("SELECT key, value FROM settings WHERE key >= ? AND key <= ?")
      .bind(`sales_report:${args.workspaceId}:${addDays(yesterday, -days)}`, `sales_report:${args.workspaceId}:${yesterday}`)
      .all<{ key: string; value: string }>();
    const have = new Set(done.map((d) => d.key.split(":").pop()));
    let requests = 0;
    for (let i = 0; i < days && requests < (args.maxRequests ?? 10); i++) {
      const day = addDays(yesterday, -i);
      if (have.has(day)) continue;
      try {
        requests++;
        const rows = await api.dailySalesReport(vendor, day);
        if (!rows) {
          missing.push(day);
          // Apple publishes a day's report the next day; older days without one had no sales.
          if (day < addDays(yesterday, -2)) await storeAndApply(db, args.workspaceId, day, []);
          continue;
        }
        await storeAndApply(db, args.workspaceId, day, await aggregateReport(fx, day, rows));
        fetched.push(day);
      } catch (err) {
        // A key without access to reports (401/403): try the next one for the same day.
        if (err instanceof AscError && (err.status === 401 || err.status === 403) && keyIndex + 1 < creds.length) {
          api = new AppStoreConnectApi(creds[++keyIndex]);
          i--;
          continue;
        }
        return { fetched, missing, error: `${errorMessage(err)}${creds.length > 1 ? ` (key ${creds[keyIndex].keyId})` : ""}` };
      }
    }
    return { fetched, missing };
  },
);

/** Apple's numbers next to Revflare's for each day and app (units, proceeds), for the reconciliation view. */
export const reconciliation = defineDbFunction(
  "reconciliation",
  async (db, args: { workspaceId: string; from: string; to: string }) => {
    const { results: apple } = await db
      .prepare(
        `SELECT day, app_id, SUM(units) AS units, SUM(proceeds_usd) AS proceeds_usd, SUM(customer_price_usd) AS gross_usd
         FROM sales_reports WHERE workspace_id = ? AND day >= ? AND day <= ? GROUP BY day, app_id`,
      )
      .bind(args.workspaceId, args.from, args.to)
      .all<{ day: string; app_id: string | null; units: number; proceeds_usd: number; gross_usd: number }>();
    const { results: ours } = await db
      .prepare(
        `SELECT day, app_id, SUM(new_subscriptions + renewals + one_time_purchases) AS units, SUM(proceeds_usd) AS proceeds_usd, SUM(gross_usd) AS gross_usd
         FROM daily_metrics WHERE workspace_id = ? AND day >= ? AND day <= ? GROUP BY day, app_id`,
      )
      .bind(args.workspaceId, args.from, args.to)
      .all<{ day: string; app_id: string; units: number; proceeds_usd: number; gross_usd: number }>();
    const key = (d: string, a: string | null) => `${d}|${a ?? ""}`;
    const rows = new Map<string, { day: string; appId: string | null; apple: { units: number; proceedsUsd: number; grossUsd: number } | null; revflare: { units: number; proceedsUsd: number; grossUsd: number } | null }>();
    for (const a of apple) rows.set(key(a.day, a.app_id), { day: a.day, appId: a.app_id, apple: { units: a.units, proceedsUsd: a.proceeds_usd, grossUsd: a.gross_usd }, revflare: null });
    for (const o of ours) {
      const r = rows.get(key(o.day, o.app_id)) ?? { day: o.day, appId: o.app_id, apple: null, revflare: null };
      r.revflare = { units: o.units, proceedsUsd: o.proceeds_usd, grossUsd: o.gross_usd };
      rows.set(key(o.day, o.app_id), r);
    }
    const reportedDays = new Set(apple.map((a) => a.day));
    return { rows: [...rows.values()].sort((a, b) => (a.day < b.day ? 1 : -1)), reportedDays: [...reportedDays].sort() };
  },
);
