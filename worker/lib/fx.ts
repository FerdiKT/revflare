// Exchange rates (units per USD per day). ECB rates via frankfurter.dev (history and ~30 currencies) plus
// open.er-api.com for the rest (latest only). Stored in fx_rates; worker/lib/money.ts reads them.

import { defineDbFunction, type Db } from "./db";
import { FxCache, dayOf, estimateProceeds } from "./money";
import { now } from "./util";

async function storeRates(db: Db, rows: { day: string; currency: string; perUsd: number }[]) {
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    await db.batch(
      chunk.map((r) =>
        db
          .prepare("INSERT INTO fx_rates (day, currency, per_usd) VALUES (?, ?, ?) ON CONFLICT(day, currency) DO UPDATE SET per_usd = excluded.per_usd")
          .bind(r.day, r.currency, r.perUsd),
      ),
    );
  }
}

/** Today's rates (daily cron). */
export const refreshFxRates = defineDbFunction("refreshFxRates", async (db, _args: Record<string, never>, env) => {
  if (env.TEST_MODE === "true") return { stored: 0 };
  const day = dayOf(now());
  const rows: { day: string; currency: string; perUsd: number }[] = [];
  const er = await fetch("https://open.er-api.com/v6/latest/USD").then((r) => (r.ok ? r.json() : null)).catch(() => null) as { rates?: Record<string, number> } | null;
  for (const [currency, perUsd] of Object.entries(er?.rates ?? {})) if (perUsd > 0) rows.push({ day, currency, perUsd });
  // ECB values win for the currencies they cover.
  const ecb = await fetch("https://api.frankfurter.dev/v1/latest?base=USD").then((r) => (r.ok ? r.json() : null)).catch(() => null) as { rates?: Record<string, number> } | null;
  for (const [currency, perUsd] of Object.entries(ecb?.rates ?? {})) rows.push({ day, currency, perUsd });
  await storeRates(db, rows);
  return { stored: rows.length };
});

/** Historical ECB rates for [from, to] (one request), for imports of older transactions. */
export const backfillFxRates = defineDbFunction("backfillFxRates", async (db, args: { from: string; to?: string }, env) => {
  if (env.TEST_MODE === "true") return { stored: 0 };
  const to = args.to ?? dayOf(now());
  const res = await fetch(`https://api.frankfurter.dev/v1/${args.from}..${to}?base=USD`);
  if (!res.ok) throw new Error(`Exchange rate history failed: ${res.status}`);
  const j = (await res.json()) as { rates: Record<string, Record<string, number>> };
  const rows: { day: string; currency: string; perUsd: number }[] = [];
  for (const [day, rates] of Object.entries(j.rates ?? {})) for (const [currency, perUsd] of Object.entries(rates)) rows.push({ day, currency, perUsd });
  await storeRates(db, rows);
  await db.prepare("INSERT INTO settings (key, value) VALUES ('fx_backfilled_from', ?) ON CONFLICT(key) DO UPDATE SET value = MIN(value, excluded.value)").bind(args.from).run();
  return { stored: rows.length };
});

/** Recomputes USD amounts of an app's transactions with the stored rates (after a rate backfill). */
export const recomputeUsd = defineDbFunction("recomputeUsd", async (db, args: { appId: string }) => {
  const app = await db.prepare("SELECT commission_pct FROM apps WHERE id = ?").bind(args.appId).first<{ commission_pct: number }>();
  if (!app) return { updated: 0 };
  const { results } = await db
    .prepare(
      `SELECT id, price_milli, quantity, currency, country, purchased_at, gross_usd, proceeds_reported FROM transactions
       WHERE app_id = ? AND source IN ('apple', 'google_play') AND gross_usd > 0`,
    )
    .bind(args.appId)
    .all<{ id: string; price_milli: number; quantity: number; currency: string | null; country: string | null; purchased_at: number; gross_usd: number; proceeds_reported: number }>();
  const fx = new FxCache(db);
  const updates = [];
  for (const t of results) {
    const gross = await fx.toUsd((t.price_milli / 1000) * Math.max(1, t.quantity), t.currency, dayOf(t.purchased_at));
    if (Math.abs(gross - t.gross_usd) < 0.005) continue;
    updates.push(
      t.proceeds_reported
        ? db.prepare("UPDATE transactions SET gross_usd = ? WHERE id = ?").bind(gross, t.id)
        : db.prepare("UPDATE transactions SET gross_usd = ?, proceeds_usd = ? WHERE id = ?").bind(gross, estimateProceeds(gross, t.country, app.commission_pct), t.id),
    );
  }
  for (let i = 0; i < updates.length; i += 200) await db.batch(updates.slice(i, i + 200));
  if (updates.length) await db.prepare("INSERT INTO rollup_queue (app_id, queued_at) VALUES (?, ?) ON CONFLICT(app_id) DO NOTHING").bind(args.appId, now()).run();
  return { updated: updates.length };
});

