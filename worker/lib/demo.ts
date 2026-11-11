// Synthetic data for local development and screenshots (POST /api/v1/dev/seed, only with DEV_SEED="true").
import { upsertApp } from "../apple/setup";
import { defineDbFunction, type Db } from "./db";
import { applyImportedTransactionsLocal, type TxInput } from "./ledger";
import { rebuildApp } from "./rollup";
import { now } from "./util";

const DAY = 86_400_000;

// Made-up apps (no icons: the apps show their initials).
const APPS = [
  { name: "Sky Routes", bundleId: "com.example.skyroutes", weight: 1.4, icon: null },
  { name: "Stylix", bundleId: "com.example.stylix", weight: 1.0, icon: null },
  { name: "Creator Cam", bundleId: "com.example.creatorcam", weight: 0.8, icon: null },
  { name: "Safekeep", bundleId: "com.example.safekeep", weight: 0.6, icon: null },
  { name: "Cubix", bundleId: "com.example.cubix", weight: 0.4, icon: null },
];

const COUNTRIES: [string, string, number, number][] = [
  // alpha-2, currency, local price multiplier, weight
  ["US", "USD", 1, 34],
  ["GB", "GBP", 0.8, 8],
  ["DE", "EUR", 0.95, 8],
  ["TR", "TRY", 32, 7],
  ["JP", "JPY", 150, 6],
  ["FR", "EUR", 0.95, 5],
  ["BR", "BRL", 5, 5],
  ["CA", "CAD", 1.35, 4],
  ["AU", "AUD", 1.5, 4],
  ["IN", "INR", 60, 4],
  ["KR", "KRW", 1300, 3],
  ["MX", "MXN", 17, 3],
  ["IT", "EUR", 0.95, 3],
  ["ES", "EUR", 0.95, 3],
  ["NL", "EUR", 0.95, 3],
];

const PRODUCTS = [
  { id: "weekly", period: "P1W", days: 7, usd: 2.99, weight: 3, trial: false },
  { id: "monthly", period: "P1M", days: 30, usd: 6.99, weight: 4, trial: true },
  { id: "yearly", period: "P1Y", days: 365, usd: 39.99, weight: 3, trial: true },
  { id: "lifetime", period: null, days: 0, usd: 79.99, weight: 1, trial: false },
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function pick<T>(r: () => number, items: T[], weight: (t: T) => number): T {
  const total = items.reduce((s, i) => s + weight(i), 0);
  let x = r() * total;
  for (const i of items) {
    x -= weight(i);
    if (x <= 0) return i;
  }
  return items[items.length - 1];
}

/**
 * RevflareKit installs and cancellations for the newest first purchases of an app (customer activity, quick buyers /
 * cancellers, the cancellations feed): about half get an install (some within 5 minutes before the purchase), about a
 * quarter of the subscriptions turn auto-renew off (some within 5 minutes after it).
 */
async function seedTiming(db: Db, workspaceId: string, appId: string, r: () => number, t: number) {
  const { results } = await db
    .prepare(
      `SELECT x.original_transaction_id AS otid, x.transaction_id AS txid, x.product_id, x.purchased_at, x.kind, x.country FROM transactions x
       WHERE x.app_id = ? AND x.kind IN ('trial', 'new', 'one_time') AND x.purchased_at > ? ORDER BY x.purchased_at DESC LIMIT 40`,
    )
    .bind(appId, t - 20 * DAY)
    .all<{ otid: string; txid: string; product_id: string; purchased_at: number; kind: string; country: string | null }>();
  for (const [i, x] of results.entries()) {
    if (r() < 0.55) {
      const install = `0000${appId.slice(-4).padStart(4, "0")}-${String(i).padStart(4, "0")}-4000-8000-${x.otid.padStart(12, "0").slice(-12)}`.toLowerCase().replace(/[^0-9a-f-]/g, "0");
      const lead = i % 3 === 0 ? 60_000 + Math.floor(r() * 4 * 60_000) : 10 * 60_000 + Math.floor(r() * 2 * DAY);
      const installedAt = x.purchased_at - lead;
      await db
        .prepare(
          `INSERT INTO attributions (app_id, install_id, workspace_id, status, attributed, install_country, installed_at, environment, created_at, updated_at)
           VALUES (?, ?, ?, 'resolved', 0, ?, ?, 'production', ?, ?) ON CONFLICT DO NOTHING`,
        )
        .bind(appId, install, workspaceId, x.country, installedAt, installedAt + 5_000, Math.min(t, x.purchased_at + Math.floor(r() * 3 * DAY)))
        .run();
      await db.prepare("INSERT INTO install_links (app_id, original_transaction_id, install_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(appId, x.otid, install, installedAt + 5_000).run();
    }
    if (x.kind !== "one_time" && r() < 0.3) {
      const after = i % 2 === 0 ? 45_000 + Math.floor(r() * 4 * 60_000) : 30 * 60_000 + Math.floor(r() * 2 * DAY);
      const at = Math.min(t - 60_000, x.purchased_at + after);
      await db
        .prepare(
          `INSERT INTO events (id, workspace_id, app_id, uid, source, type, subtype, environment, transaction_id, original_transaction_id, product_id, country, signed_at, received_at)
           VALUES (?, ?, ?, ?, 'apple', 'DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_DISABLED', 'Production', ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .bind(`evt_demo_${appId}_${x.otid}`, workspaceId, appId, `demo-off-${x.otid}`, x.txid, x.otid, x.product_id, x.country, at, at)
        .run();
      await db.prepare("UPDATE subscriptions SET auto_renew = 0 WHERE app_id = ? AND original_transaction_id = ?").bind(appId, x.otid).run();
    }
  }
}

export const seedDemo = defineDbFunction("seedDemo", async (db, args: { workspaceId: string; days?: number }) => {
  const r = rng(42);
  const t = now();
  const days = args.days ?? 420;
  let txCount = 0;
  let id = 7_000_000_000;
  const appIds: string[] = [];
  for (const a of APPS) {
    const { id: appId } = await upsertApp(db, args.workspaceId, { name: a.name, bundleId: a.bundleId, iconUrl: a.icon, urlStatus: "revflare" });
    appIds.push(appId);
    await db.prepare("UPDATE apps SET last_notification_at = ?, history_backfilled_from = ? WHERE id = ?").bind(t - 7 * 60_000, new Date(t - 180 * DAY).toISOString().slice(0, 10), appId).run();
    for (const p of PRODUCTS) {
      await db
        .prepare("INSERT INTO products (app_id, product_id, workspace_id, type, name, period, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
        .bind(appId, `${a.bundleId}.${p.id}`, args.workspaceId, p.period ? "auto_renewable" : "non_consumable", p.id[0].toUpperCase() + p.id.slice(1), p.period, t, t)
        .run();
    }
    const txs: TxInput[] = [];
    for (let d = days; d >= 0; d--) {
      // Growth: more customers lately, a weekly rhythm and noise.
      const base = a.weight * (4 + (12 * (days - d)) / days);
      const dow = new Date(t - d * DAY).getUTCDay();
      const n = Math.round(base * (dow === 0 || dow === 6 ? 1.25 : 1) * (0.6 + r() * 0.8));
      for (let k = 0; k < n; k++) {
        const start = t - d * DAY - Math.floor(r() * DAY);
        if (start > t) continue;
        const [country, currency, mult] = pick(r, COUNTRIES, (c) => c[3]);
        const p = pick(r, PRODUCTS, (x) => x.weight);
        const otid = String(id++);
        const price = Math.round(p.usd * mult * 100) * 10;
        const common = { source: "apple" as const, environment: "Production", originalTransactionId: otid, productId: `${a.bundleId}.${p.id}`, currency, country, quantity: 1, signedAt: t };
        if (!p.period) {
          txs.push({ ...common, transactionId: otid, productType: "non_consumable", purchasedAt: start, isTrial: false, priceMilli: price, refundedAt: r() < 0.02 ? start + 3 * DAY : null });
          continue;
        }
        let at = start;
        let first = otid;
        if (p.trial && r() < 0.6) {
          txs.push({ ...common, transactionId: otid, productType: "auto_renewable", purchasedAt: at, expiresAt: at + 3 * DAY, isTrial: true, offerType: 1, offerDiscountType: "FREE_TRIAL", offerPeriod: "P3D", priceMilli: 0 });
          at += 3 * DAY;
          first = "";
          if (r() > 0.38) continue; // did not convert
        }
        const keep = p.period === "P1W" ? 0.8 : p.period === "P1M" ? 0.86 : 0.55;
        for (let i = 0; at < t; i++) {
          const txId = first && i === 0 ? first : String(id++);
          const refunded = r() < 0.015 ? at + Math.floor(r() * 5 * DAY) : null;
          txs.push({ ...common, transactionId: txId, productType: "auto_renewable", purchasedAt: at, expiresAt: at + p.days * DAY, isTrial: false, reason: i ? "RENEWAL" : "PURCHASE", priceMilli: price, refundedAt: refunded && refunded < t ? refunded : null });
          at += p.days * DAY;
          if (refunded || r() > keep) break;
        }
      }
    }
    for (let i = 0; i < txs.length; i += 500) await applyImportedTransactionsLocal(db, { appId, transactions: txs.slice(i, i + 500) });
    // Some live subscriptions with billing problems or auto-renew off.
    await db.prepare("UPDATE subscriptions SET auto_renew = 0 WHERE app_id = ? AND status = 'active' AND abs(random()) % 10 = 0").bind(appId).run();
    await db.prepare("UPDATE subscriptions SET status = 'billing_retry', mrr_usd = 0 WHERE app_id = ? AND status = 'active' AND abs(random()) % 40 = 0").bind(appId).run();
    await seedTiming(db, args.workspaceId, appId, r, t);
    await rebuildApp(db, appId);
    txCount += txs.length;
  }
  await db.prepare("INSERT INTO goals (id, workspace_id, metric, period, target_usd, created_at, updated_at) VALUES ('goal_demo', ?, 'revenue', 'month', 6000, ?, ?) ON CONFLICT DO NOTHING").bind(args.workspaceId, t, t).run();
  // A few more goals: named, on several apps, all apps but one, other metrics and periods.
  const year = new Date(t).getUTCFullYear();
  const more: [string, string, string, number, string, string[], string | null, string | null, number][] = [
    ["Q4 push", "revenue", "quarter", 18000, "include", appIds.slice(0, 3), null, null, 1],
    ["Subscribers without the game", "active_subscriptions", "month", 900, "exclude", appIds.slice(-1), null, null, 0],
    ["Weekly trials", "trials_started", "week", 150, "all", [], null, null, 0],
    ["Holiday sale", "sales", "custom", 2500, "include", appIds.slice(0, 2), `${year}-11-15`, `${year}-12-31`, 1],
    ["MRR this year", "mrr", "year", 12000, "all", [], null, null, 0],
  ];
  for (const [i, [name, metric, period, target, scope, ids, start, end, notify]] of more.entries()) {
    await db
      .prepare(
        `INSERT INTO goals (id, workspace_id, name, metric, period, target_usd, scope, app_ids, start_day, end_day, notify, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .bind(`goal_demo${i + 2}_${args.workspaceId}`, args.workspaceId, name, metric, period, target, scope, JSON.stringify(ids), start, end, notify, i + 1, t, t)
      .run();
  }
  return { apps: APPS.length, transactions: txCount };
});
