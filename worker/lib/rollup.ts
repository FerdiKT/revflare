// Daily metrics per app (daily_metrics), rebuilt from the app's transactions. Runs inside the database object.
//
// Flow metrics (revenue, refunds, new subscriptions, renewals, trials...) are sums by UTC day. Stock metrics (MRR,
// active subscriptions and trials) come from a sweep over each subscription's paid periods: a subscription is active
// at the end of a day when one of its non-refunded paid periods covers that instant. MRR movement compares each
// subscription's MRR at the start and the end of the day: new, reactivation (active again after a lapse), expansion,
// contraction and churn. Only Production transactions count.

import { defineDbFunction, type Db } from "./db";
import { addDays, dayOf, dayStart, estimateProceeds, monthly, refundedShare } from "./money";
import { now } from "./util";

const DAY = 86_400_000;

interface Tx {
  id: string;
  product_id: string;
  customer_id: string | null;
  original_transaction_id: string;
  product_type: string | null;
  kind: string;
  offer_type: number | null;
  offer_discount_type: string | null;
  purchased_at: number;
  expires_at: number | null;
  period: string | null;
  gross_usd: number;
  proceeds_usd: number;
  refunded_at: number | null;
  /** Prorated refund: refunded share in milliunits (null = full refund). */
  refund_milli?: number | null;
  revoked_at: number | null;
}

export interface DayRow {
  day: string;
  gross_usd: number;
  proceeds_usd: number;
  refunds_usd: number;
  refunds: number;
  new_subscriptions: number;
  renewals: number;
  one_time_purchases: number;
  trials_started: number;
  trial_conversions: number;
  new_customers: number;
  new_payers: number;
  active_subscriptions: number;
  active_trials: number;
  mrr_usd: number;
  mrr_proceeds_usd: number;
  mrr_new: number;
  mrr_expansion: number;
  mrr_contraction: number;
  mrr_churn: number;
  mrr_reactivation: number;
  churned_subscriptions: number;
}

const emptyDay = (day: string): DayRow => ({
  day,
  gross_usd: 0,
  proceeds_usd: 0,
  refunds_usd: 0,
  refunds: 0,
  new_subscriptions: 0,
  renewals: 0,
  one_time_purchases: 0,
  trials_started: 0,
  trial_conversions: 0,
  new_customers: 0,
  new_payers: 0,
  active_subscriptions: 0,
  active_trials: 0,
  mrr_usd: 0,
  mrr_proceeds_usd: 0,
  mrr_new: 0,
  mrr_expansion: 0,
  mrr_contraction: 0,
  mrr_churn: 0,
  mrr_reactivation: 0,
  churned_subscriptions: 0,
});

/** Kinds from the whole history of each subscription: trial, conversion, new, renewal (one_time for the rest). */
export function classify(txs: Tx[]): Map<string, string> {
  const kinds = new Map<string, string>();
  const groups = new Map<string, Tx[]>();
  for (const t of txs) {
    if (t.product_type !== "auto_renewable") {
      kinds.set(t.id, "one_time");
      continue;
    }
    const g = groups.get(t.original_transaction_id);
    if (g) g.push(t);
    else groups.set(t.original_transaction_id, [t]);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => a.purchased_at - b.purchased_at);
    let trial = false;
    let paid = false;
    for (const t of g) {
      const isTrial = t.offer_discount_type === "FREE_TRIAL" || (t.kind === "trial" && t.gross_usd === 0);
      if (isTrial) {
        kinds.set(t.id, "trial");
        trial = true;
      } else if (!paid) {
        kinds.set(t.id, trial ? "conversion" : "new");
        paid = true;
      } else kinds.set(t.id, "renewal");
    }
  }
  return kinds;
}

/** End of a period: expiry, cut short by a refund or revocation. */
function periodEnd(t: Tx): number {
  let end = t.expires_at ?? t.purchased_at;
  if (t.refunded_at) end = Math.min(end, t.refunded_at);
  if (t.revoked_at) end = Math.min(end, t.revoked_at);
  return end;
}

/** New customers / new payers per UTC day. */
export interface CustomerCounts {
  seen: Map<string, number>;
  paid: Map<string, number>;
}

/**
 * The daily series of one app (or of any filtered set of transactions) from `fromDay` to `toDay`. The transactions
 * must include every one that is active at the start of `fromDay` or starts / is refunded later. New customers and
 * payers come from `customers` when given (the customers table), else from the transactions.
 */
export function computeDays(
  txs: Tx[],
  kinds: Map<string, string>,
  fromDay: string,
  toDay: string,
  proceedsRatio = (t: Tx) => (t.gross_usd ? t.proceeds_usd / t.gross_usd : 0),
  customers?: CustomerCounts,
  /** Sales after this instant (renewals Apple announced ahead of their period) are not counted yet. */
  nowMs = Number.POSITIVE_INFINITY,
): DayRow[] {
  const days = new Map<string, DayRow>();
  const dayRow = (d: string) => {
    let r = days.get(d);
    if (!r) days.set(d, (r = emptyDay(d)));
    return r;
  };

  // Flow metrics
  const firstSeen = new Map<string, number>();
  const firstPaid = new Map<string, number>();
  for (const t of txs) {
    if (t.purchased_at > nowMs) continue;
    const kind = kinds.get(t.id) ?? t.kind;
    const d = dayOf(t.purchased_at);
    if (t.customer_id && !customers) {
      const f = firstSeen.get(t.customer_id);
      if (f === undefined || t.purchased_at < f) firstSeen.set(t.customer_id, t.purchased_at);
      if (kind !== "trial" && t.gross_usd > 0) {
        const p = firstPaid.get(t.customer_id);
        if (p === undefined || t.purchased_at < p) firstPaid.set(t.customer_id, t.purchased_at);
      }
    }
    // A prorated refund takes back only its share: the rest stays revenue.
    const refunded = refundedShare(t);
    if (t.refunded_at) {
      const r = dayRow(dayOf(t.refunded_at));
      r.refunds += 1;
      r.refunds_usd += t.gross_usd * refunded;
    }
    const row = dayRow(d);
    if (kind === "trial") {
      row.trials_started += 1;
      continue;
    }
    if (refunded < 1) {
      row.gross_usd += t.gross_usd * (1 - refunded);
      row.proceeds_usd += t.proceeds_usd * (1 - refunded);
    }
    if (kind === "one_time") row.one_time_purchases += 1;
    else if (kind === "renewal") row.renewals += 1;
    else {
      row.new_subscriptions += 1;
      if (kind === "conversion") row.trial_conversions += 1;
    }
  }
  if (customers) {
    for (const [d, n] of customers.seen) dayRow(d).new_customers += n;
    for (const [d, n] of customers.paid) dayRow(d).new_payers += n;
  } else {
    for (const first of firstSeen.values()) dayRow(dayOf(first)).new_customers += 1;
    for (const first of firstPaid.values()) dayRow(dayOf(first)).new_payers += 1;
  }

  // Stock metrics: sweep over period starts/ends.
  type Change = { at: number; otid: string; tx: Tx; start: boolean };
  const changes: Change[] = [];
  for (const t of txs) {
    if (t.product_type !== "auto_renewable") continue;
    const end = periodEnd(t);
    if (end <= t.purchased_at) continue;
    changes.push({ at: t.purchased_at, otid: t.original_transaction_id, tx: t, start: true });
    changes.push({ at: end, otid: t.original_transaction_id, tx: t, start: false });
  }
  // Ends before starts at the same instant, so a renewal that starts exactly when the previous period ends is seamless.
  changes.sort((a, b) => a.at - b.at || Number(a.start) - Number(b.start));

  const current = new Map<string, Tx>(); // otid → covering transaction (latest started)
  const mrrOf = (t: Tx | undefined) => (t && (kinds.get(t.id) ?? t.kind) !== "trial" ? monthly(t.gross_usd, t.period) : 0);
  let ci = 0;
  let activeSubs = 0;
  let activeTrials = 0;
  let mrr = 0;
  let mrrProceeds = 0;
  const isTrial = (t: Tx) => (kinds.get(t.id) ?? t.kind) === "trial";
  const add = (t: Tx, sign: 1 | -1) => {
    if (isTrial(t)) activeTrials += sign;
    else {
      activeSubs += sign;
      const m = mrrOf(t);
      mrr += sign * m;
      mrrProceeds += sign * m * proceedsRatio(t);
    }
  };

  // Apply everything before the first day (state at its start).
  const start = dayStart(fromDay);
  const touched = new Map<string, number>(); // otid → MRR at the start of the day
  const apply = (c: Change) => {
    const cur = current.get(c.otid);
    if (!touched.has(c.otid)) touched.set(c.otid, mrrOf(cur));
    if (c.start) {
      if (cur) add(cur, -1);
      current.set(c.otid, c.tx);
      add(c.tx, 1);
    } else if (cur === c.tx) {
      add(cur, -1);
      current.delete(c.otid);
    }
  };
  for (; ci < changes.length && changes[ci].at < start; ci++) apply(changes[ci]);
  touched.clear();

  for (let d = fromDay, t0 = start; d <= toDay; d = addDays(d, 1), t0 += DAY) {
    // The day still running is measured now, not at its end: periods ending later today are not dropped before Apple
    // had the chance to renew them (else today's MRR dips at 00:00 UTC and climbs back as renewals arrive). The
    // nightly cron rebuilds yesterday, so every closed day ends at its end-of-day state.
    const end = Math.min(t0 + DAY, Math.max(nowMs, t0));
    for (; ci < changes.length && changes[ci].at < end; ci++) apply(changes[ci]);
    const row = dayRow(d);
    for (const [otid, before] of touched) {
      const after = mrrOf(current.get(otid));
      if (before === 0 && after > 0) {
        // The subscription's first payment is new MRR; a later payment after a lapse is a reactivation.
        const k = kinds.get(current.get(otid)!.id) ?? current.get(otid)!.kind;
        if (k === "renewal") row.mrr_reactivation += after;
        else row.mrr_new += after;
      } else if (before > 0 && after === 0) {
        row.mrr_churn += before;
        row.churned_subscriptions += 1;
      } else if (after > before) row.mrr_expansion += after - before;
      else if (after < before) row.mrr_contraction += before - after;
    }
    touched.clear();
    row.active_subscriptions = activeSubs;
    row.active_trials = activeTrials;
    row.mrr_usd = Math.max(0, mrr);
    row.mrr_proceeds_usd = Math.max(0, mrrProceeds);
  }
  return [...days.values()].filter((r) => r.day >= fromDay && r.day <= toDay).sort((a, b) => (a.day < b.day ? -1 : 1));
}

export const TX_COLUMNS =
  "id, product_id, customer_id, original_transaction_id, product_type, kind, offer_type, offer_discount_type, purchased_at, expires_at, period, gross_usd, proceeds_usd, refunded_at, refund_milli, revoked_at";

export async function loadTransactions(db: Db, where: string, params: unknown[]): Promise<Tx[]> {
  const { results } = await db
    .prepare(`SELECT ${TX_COLUMNS} FROM transactions WHERE environment = 'Production' AND ${where} ORDER BY purchased_at`)
    .bind(...params)
    .all<Tx>();
  return results;
}

const COLUMNS: (keyof DayRow)[] = [
  "gross_usd",
  "proceeds_usd",
  "refunds_usd",
  "refunds",
  "new_subscriptions",
  "renewals",
  "one_time_purchases",
  "trials_started",
  "trial_conversions",
  "new_customers",
  "new_payers",
  "active_subscriptions",
  "active_trials",
  "mrr_usd",
  "mrr_proceeds_usd",
  "mrr_new",
  "mrr_expansion",
  "mrr_contraction",
  "mrr_churn",
  "mrr_reactivation",
  "churned_subscriptions",
];

const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** Transactions that matter for the days from `day` on: started since, active at its start, or refunded since. */
async function loadFrom(db: Db, appId: string, day: string): Promise<Tx[]> {
  const t0 = dayStart(day);
  const base = `SELECT ${TX_COLUMNS} FROM transactions WHERE app_id = ? AND environment = 'Production'`;
  const [a, b, c] = await Promise.all([
    db.prepare(`${base} AND purchased_at >= ?`).bind(appId, t0).all<Tx>(),
    db.prepare(`${base} AND expires_at > ? AND purchased_at < ?`).bind(appId, t0, t0).all<Tx>(),
    db.prepare(`${base} AND refunded_at >= ? AND purchased_at < ? AND (expires_at IS NULL OR expires_at <= ?)`).bind(appId, t0, t0, t0).all<Tx>(),
  ]);
  const byId = new Map<string, Tx>();
  for (const t of [...a.results, ...b.results, ...c.results]) byId.set(t.id, t);
  return [...byId.values()].sort((x, y) => x.purchased_at - y.purchased_at);
}

async function customerCounts(db: Db, appId: string, fromDay: string): Promise<CustomerCounts> {
  const t0 = dayStart(fromDay);
  const toMap = (rows: { d: string; n: number }[]) => new Map(rows.map((r) => [r.d, r.n]));
  const [seen, paid] = await Promise.all([
    db
      .prepare("SELECT strftime('%Y-%m-%d', first_seen_at / 1000, 'unixepoch') AS d, COUNT(*) AS n FROM customers WHERE app_id = ? AND first_seen_at >= ? AND sandbox = 0 GROUP BY d")
      .bind(appId, t0)
      .all<{ d: string; n: number }>(),
    db
      .prepare("SELECT strftime('%Y-%m-%d', first_paid_at / 1000, 'unixepoch') AS d, COUNT(*) AS n FROM customers WHERE app_id = ? AND first_paid_at >= ? GROUP BY d")
      .bind(appId, t0)
      .all<{ d: string; n: number }>(),
  ]);
  return { seen: toMap(seen.results), paid: toMap(paid.results) };
}

/**
 * Rebuilds an app's daily_metrics from `fromDay` (null: from its first transaction, reclassifying every transaction)
 * and writes only the rows that changed. Keeps workspace_daily in step and bumps the workspace's data version.
 */
export async function rebuildApp(db: Db, appId: string, fromDay: string | null = null): Promise<{ days: number; transactions: number; written: number }> {
  const app = await db.prepare("SELECT workspace_id, commission_pct FROM apps WHERE id = ?").bind(appId).first<{ workspace_id: string; commission_pct: number }>();
  if (!app) {
    await db.prepare("DELETE FROM rollup_queue WHERE app_id = ?").bind(appId).run();
    return { days: 0, transactions: 0, written: 0 };
  }
  const today = dayOf(now());
  let txs: Tx[];
  let kinds: Map<string, string>;
  let from: string;
  if (fromDay) {
    from = fromDay > today ? today : fromDay;
    txs = await loadFrom(db, appId, from);
    kinds = new Map(txs.map((t) => [t.id, t.kind]));
  } else {
    txs = await loadTransactions(db, "app_id = ?", [appId]);
    kinds = classify(txs);
    const fixes = txs.filter((t) => kinds.get(t.id) !== t.kind);
    for (let i = 0; i < fixes.length; i += 200) {
      await db.batch(fixes.slice(i, i + 200).map((t) => db.prepare("UPDATE transactions SET kind = ? WHERE id = ?").bind(kinds.get(t.id)!, t.id)));
    }
    for (const t of txs) t.kind = kinds.get(t.id) ?? t.kind;
    from = txs.length ? dayOf(txs[0].purchased_at) : today;
  }

  // Periods: fill missing ones from the product's known period (trials and offers have their own).
  const { results: products } = await db.prepare("SELECT product_id, period FROM products WHERE app_id = ? AND period IS NOT NULL").bind(appId).all<{ product_id: string; period: string }>();
  const productPeriod = new Map(products.map((p) => [p.product_id, p.period]));
  const periodFixes: Tx[] = [];
  for (const t of txs) {
    if (t.period || t.product_type !== "auto_renewable" || t.kind === "trial" || t.offer_type) continue;
    const p = productPeriod.get(t.product_id);
    if (p) {
      t.period = p;
      periodFixes.push(t);
    }
  }
  for (let i = 0; i < periodFixes.length; i += 200) {
    await db.batch(periodFixes.slice(i, i + 200).map((t) => db.prepare("UPDATE transactions SET period = ? WHERE id = ?").bind(t.period, t.id)));
  }

  const computed = computeDays(
    txs,
    kinds,
    from,
    today,
    (t) => (t.gross_usd ? t.proceeds_usd / t.gross_usd : estimateProceeds(1, null, app.commission_pct)),
    await customerCounts(db, appId, from),
    now(),
  );
  const { results: existingRows } = await db.prepare("SELECT * FROM daily_metrics WHERE app_id = ? AND day >= ?").bind(appId, from).all<DayRow>();
  const existing = new Map(existingRows.map((r) => [r.day, r]));

  const stmts = [];
  const changedDays = new Set<string>();
  const cols = ["app_id", "day", "workspace_id", ...COLUMNS];
  const upserts: DayRow[] = [];
  for (const r of computed) {
    const old = existing.get(r.day);
    existing.delete(r.day);
    const empty = COLUMNS.every((c) => r[c] === 0);
    if (empty) {
      if (old) {
        stmts.push(db.prepare("DELETE FROM daily_metrics WHERE app_id = ? AND day = ?").bind(appId, r.day));
        changedDays.add(r.day);
      }
      continue;
    }
    if (old && COLUMNS.every((c) => same(r[c] as number, (old[c] as number) ?? 0))) continue;
    upserts.push(r);
    changedDays.add(r.day);
  }
  // Rows for days that no longer have data.
  for (const old of existing.values()) {
    stmts.push(db.prepare("DELETE FROM daily_metrics WHERE app_id = ? AND day = ?").bind(appId, old.day));
    changedDays.add(old.day);
  }
  // Durable Object SQLite binds at most 100 parameters per statement.
  const perStatement = Math.floor(100 / cols.length);
  for (let i = 0; i < upserts.length; i += perStatement) {
    const chunk = upserts.slice(i, i + perStatement);
    stmts.push(
      db
        .prepare(`INSERT OR REPLACE INTO daily_metrics (${cols.join(", ")}) VALUES ${chunk.map(() => `(${cols.map(() => "?").join(", ")})`).join(", ")}`)
        .bind(...chunk.flatMap((r) => [appId, r.day, app.workspace_id, ...COLUMNS.map((c) => r[c])])),
    );
  }
  // Workspace totals of the changed days.
  const days = [...changedDays].sort();
  for (let i = 0; i < days.length; i += 90) {
    const chunk = days.slice(i, i + 90);
    const marks = chunk.map(() => "?").join(",");
    stmts.push(db.prepare(`DELETE FROM workspace_daily WHERE workspace_id = ? AND day IN (${marks})`).bind(app.workspace_id, ...chunk));
    stmts.push(
      db
        .prepare(
          `INSERT INTO workspace_daily (workspace_id, day, ${COLUMNS.join(", ")})
           SELECT workspace_id, day, ${COLUMNS.map((c) => `SUM(${c})`).join(", ")} FROM daily_metrics
           WHERE workspace_id = ? AND day IN (${marks}) GROUP BY day`,
        )
        .bind(app.workspace_id, ...chunk),
    );
  }
  const written = stmts.length;
  if (written) stmts.push(db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(`data_version:${app.workspace_id}`, String(now())));
  // Days before today changed: the goals' cached bases (worker/lib/goals.ts PAST_VERSION_KEY) are rebuilt.
  if (days.length && days[0] < today) stmts.push(db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(`data_past:${app.workspace_id}`, String(now())));
  stmts.push(db.prepare("DELETE FROM rollup_queue WHERE app_id = ?").bind(appId));
  for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
  return { days: computed.length, transactions: txs.length, written };
}

/** Rebuilds an app as queued (from its queued day, or fully). */
export async function rebuildQueued(db: Db, appId: string) {
  const q = await db.prepare("SELECT from_day FROM rollup_queue WHERE app_id = ?").bind(appId).first<{ from_day: string | null }>();
  return rebuildApp(db, appId, q ? q.from_day : null);
}

/** Rebuilds queued apps (up to `limit`, oldest first). */
export const runRollups = defineDbFunction("runRollups", async (db, args: { limit?: number; appIds?: string[] }) => {
  const ids = args.appIds?.length
    ? args.appIds
    : (await db.prepare("SELECT app_id FROM rollup_queue ORDER BY queued_at LIMIT ?").bind(args.limit ?? 10).all<{ app_id: string }>()).results.map((r) => r.app_id);
  const out: Record<string, { days: number; transactions: number; written: number }> = {};
  for (const id of ids) out[id] = args.appIds?.length ? await rebuildApp(db, id, null) : await rebuildQueued(db, id);
  return out;
});

/** Refreshes subscriptions whose period ended without a notification (expired / still active) — daily. */
export const expireSubscriptions = defineDbFunction("expireSubscriptions", async (db, _args: Record<string, never>) => {
  const t = now();
  const res = await db
    .prepare(
      `UPDATE subscriptions SET status = 'expired', mrr_usd = 0, auto_renew = 0, updated_at = ?
       WHERE status IN ('active', 'trial') AND expires_at IS NOT NULL AND expires_at < ?`,
    )
    // Apple retries billing for up to 60 days, but a missing renewal for 2 days without DID_FAIL_TO_RENEW means it ended.
    .bind(t, t - 2 * DAY)
    .run();
  const retry = await db
    .prepare("UPDATE subscriptions SET status = 'expired', mrr_usd = 0, updated_at = ? WHERE status IN ('billing_retry', 'grace') AND expires_at < ?")
    .bind(t, t - 60 * DAY)
    .run();
  return { expired: res.meta.changes + retry.meta.changes };
});
