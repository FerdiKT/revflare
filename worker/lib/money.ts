import { VAT_PCT } from "../../shared/countries";
import type { Db } from "./db";
import { FALLBACK_PER_USD } from "./fx-fallback";

const DAY = 86_400_000;

export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`);
export const addDays = (day: string, n: number) => dayOf(dayStart(day) + n * DAY);

/** ISO 8601 subscription period → months it covers (P1W = 7/30.4375). */
export function periodMonths(period: string | null | undefined): number | null {
  const m = /^P(\d+)([DWMY])$/.exec(period ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case "D":
      return (n * 12) / 365.25;
    case "W":
      return (n * 7 * 12) / 365.25;
    case "M":
      return n;
    default:
      return n * 12;
  }
}

/** Monthly recurring amount of a price that covers `period`. */
export function monthly(amount: number, period: string | null | undefined): number {
  const months = periodMonths(period);
  return months ? amount / months : 0;
}

// Sandbox renewals are accelerated: 1 week = 3 min, 1 month = 5 min, 2 = 10, 3 = 15, 6 = 30, 1 year = 1 hour.
const SANDBOX_MINUTES: [number, string][] = [
  [3, "P1W"],
  [5, "P1M"],
  [10, "P2M"],
  [15, "P3M"],
  [30, "P6M"],
  [60, "P1Y"],
];
const PRODUCTION_DAYS: [number, string][] = [
  [3, "P3D"],
  [7, "P1W"],
  [14, "P2W"],
  [30.4, "P1M"],
  [61, "P2M"],
  [91.3, "P3M"],
  [182.6, "P6M"],
  [365.25, "P1Y"],
];

/** The standard period closest to a billing interval (purchase → expiry). */
export function periodFromDuration(ms: number, environment = "Production"): string | null {
  if (!(ms > 0)) return null;
  const table = environment === "Production" ? PRODUCTION_DAYS : SANDBOX_MINUTES;
  const unit = environment === "Production" ? DAY : 60_000;
  const v = ms / unit;
  let best: string | null = null;
  let bestErr = Infinity;
  for (const [len, p] of table) {
    const err = Math.abs(Math.log(v / len));
    if (err < bestErr) {
      bestErr = err;
      best = p;
    }
  }
  // More than ~40% off any standard period: not a billing interval (e.g. a refund-shortened one).
  return bestErr < 0.35 ? best : null;
}

/** Estimated developer proceeds of a tax-inclusive store price. */
export function estimateProceeds(grossUsd: number, country: string | null, commissionPct: number): number {
  const vat = country ? (VAT_PCT[country] ?? 0) : 0;
  return (grossUsd / (1 + vat / 100)) * (1 - commissionPct / 100);
}

/**
 * Currency → USD conversion for one database call: rates are read once per (currency, day) and cached. Falls back to
 * the nearest earlier stored day, then to the bundled table.
 */
export class FxCache {
  private readonly cache = new Map<string, number>();
  constructor(private readonly db: Db) {}

  async perUsd(currency: string | null | undefined, day: string): Promise<number> {
    const cur = (currency ?? "USD").toUpperCase();
    if (cur === "USD") return 1;
    const key = `${cur}:${day}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const row = await this.db
      .prepare("SELECT per_usd FROM fx_rates WHERE currency = ? AND day <= ? ORDER BY day DESC LIMIT 1")
      .bind(cur, day)
      .first<{ per_usd: number }>();
    let rate = row?.per_usd;
    if (!rate) {
      const later = await this.db
        .prepare("SELECT per_usd FROM fx_rates WHERE currency = ? AND day > ? ORDER BY day ASC LIMIT 1")
        .bind(cur, day)
        .first<{ per_usd: number }>();
      rate = later?.per_usd ?? FALLBACK_PER_USD[cur] ?? 1;
    }
    this.cache.set(key, rate);
    return rate;
  }

  async toUsd(amount: number, currency: string | null | undefined, day: string): Promise<number> {
    return amount / (await this.perUsd(currency, day));
  }
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

// Refunds ------------------------------------------------------------------------------------------------------------

/** Share of a transaction refunded: 0 (not refunded), the prorated share, or 1 (full refund). */
export function refundedShare(t: { refunded_at?: number | null; refund_milli?: number | null }): number {
  if (!t.refunded_at) return 0;
  return t.refund_milli == null ? 1 : Math.min(1, Math.max(0, t.refund_milli / 100_000));
}

/** SQL (transaction alias `t`): share of the transaction kept after refunds (1, 1 - prorated share, 0). */
export const keptShareSql = (t = "t") => `(CASE WHEN ${t}.refunded_at IS NULL THEN 1.0 ELSE (100000 - COALESCE(${t}.refund_milli, 100000)) / 100000.0 END)`;
/** SQL: share of the transaction refunded (0, prorated share, 1). */
export const refundedShareSql = (t = "t") => `(CASE WHEN ${t}.refunded_at IS NULL THEN 0.0 ELSE COALESCE(${t}.refund_milli, 100000) / 100000.0 END)`;
