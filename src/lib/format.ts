import type { InstallSource, Interval, MetricFormat } from "@shared/types";
import { COUNTRY_NAMES, flag } from "@shared/countries";

export function cn(...classes: Array<string | number | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const cache = new Map<string, Intl.NumberFormat>();
function nf(key: string, make: () => Intl.NumberFormat): Intl.NumberFormat {
  let f = cache.get(key);
  if (!f) {
    f = make();
    cache.set(key, f);
  }
  return f;
}

function safeCurrency(currency: string): string {
  return /^[A-Z]{3}$/.test(currency) ? currency : "USD";
}

/** $123.45, $1,235 (no cents from 1,000 up unless `cents`). */
export function money(value: number, currency: string, opts: { cents?: boolean } = {}): string {
  const c = safeCurrency(currency);
  const cents = opts.cents ?? Math.abs(value) < 1000;
  return nf(`m:${c}:${cents}`, () => new Intl.NumberFormat("en-US", { style: "currency", currency: c, minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })).format(value);
}

/** $1.2K, $3.4M */
export function moneyCompact(value: number, currency: string): string {
  const c = safeCurrency(currency);
  if (Math.abs(value) < 1000) return nf(`mc0:${c}`, () => new Intl.NumberFormat("en-US", { style: "currency", currency: c, maximumFractionDigits: Math.abs(value) < 10 && value % 1 ? 2 : 0 })).format(value);
  return nf(`mc:${c}`, () => new Intl.NumberFormat("en-US", { style: "currency", currency: c, notation: "compact", maximumFractionDigits: 1 })).format(value);
}

export function fullNumber(n: number): string {
  return nf("full", () => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })).format(n);
}

export function compactNumber(n: number): string {
  if (Math.abs(n) < 1000) return nf("c0", () => new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })).format(n);
  return nf("c", () => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })).format(n);
}

/** 0.0423 → "4.2%" */
export function percent(rate: number, digits = 1): string {
  return `${(rate * 100).toFixed(digits)}%`;
}

/** Relative change: "+12.3%", "−4.0%" (true minus). */
export function signedPercent(rate: number, digits = 1): string {
  const v = Math.abs(rate * 100);
  const s = v >= 100 ? v.toFixed(0) : v.toFixed(digits);
  return `${rate > 0 ? "+" : rate < 0 ? "−" : ""}${s}%`;
}

export function formatValue(value: number, format: MetricFormat, currency: string): string {
  if (format === "money") return money(value, currency);
  if (format === "percent") return percent(value);
  return fullNumber(value);
}

export function formatAxis(value: number, format: MetricFormat, currency: string): string {
  if (format === "money") return moneyCompact(value, currency);
  if (format === "percent") return `${Math.round(value * 1000) / 10}%`;
  return compactNumber(value);
}

// Dates ---------------------------------------------------------------------------------------------------------------
// Metric dates are UTC days ("YYYY-MM-DD"), months ("YYYY-MM") or week starts.

function utc(day: string): Date {
  return new Date(day.length === 7 ? `${day}-01T00:00:00Z` : `${day.slice(0, 10)}T00:00:00Z`);
}

const dtf = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...o });
const SHORT = dtf({ month: "short", day: "numeric" });
const LONG = dtf({ weekday: "short", month: "short", day: "numeric", year: "numeric" });
const MONTH = dtf({ month: "short", year: "numeric" });
const MONTH_SHORT = dtf({ month: "short" });
const MONTH_LONG = dtf({ month: "long", year: "numeric" });

/** Axis label for a bucket. */
export function axisDate(date: string, interval: Interval, spanYears = false): string {
  const d = utc(date);
  if (interval === "month") return spanYears && d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : spanYears ? MONTH_SHORT.format(d) : MONTH_SHORT.format(d);
  return SHORT.format(d);
}

/** Tooltip heading for a bucket. */
export function bucketLabel(date: string, interval: Interval): string {
  const d = utc(date);
  if (interval === "month") return MONTH_LONG.format(d);
  if (interval === "week") return `Week of ${SHORT.format(d)}, ${d.getUTCFullYear()}`;
  return LONG.format(d);
}

export function dayLabel(day: string): string {
  return LONG.format(utc(day));
}
export function shortDay(day: string): string {
  return SHORT.format(utc(day));
}
export function monthLabel(month: string): string {
  return MONTH.format(utc(month));
}

const DT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const D = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const T = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

export function dateTime(ms: number): string {
  return DT.format(ms);
}
export function date(ms: number): string {
  return D.format(ms);
}
export function time(ms: number): string {
  return T.format(ms);
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", else a date. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 0) return inFuture(ms, now);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return date(ms);
}

/** A duration: "45 s", "2 min 14 s", "3 h 5 min", "4 days 2 h", "3 months". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 && m < 10 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  if (d < 60) return h % 24 && d < 7 ? `${d} day${d === 1 ? "" : "s"} ${h % 24} h` : `${d} day${d === 1 ? "" : "s"}`;
  return `${Math.round(d / 30)} months`;
}

/** "+2 min" between two steps (empty under a second). */
export function gap(ms: number): string {
  return ms >= 1000 ? `+${duration(ms)}` : "";
}

export function inFuture(ms: number, now = Date.now()): string {
  const s = Math.round((ms - now) / 1000);
  if (s < 60) return "in a moment";
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h} h`;
  return `in ${Math.round(h / 24)} days`;
}

/** ISO 8601 period → words: P1M → "Monthly". */
export function periodLabel(p: string | null | undefined): string {
  if (!p) return "—";
  const map: Record<string, string> = { P1W: "Weekly", P1M: "Monthly", P2M: "2 months", P3M: "Quarterly", P6M: "6 months", P1Y: "Yearly", trial: "Trials" };
  return map[p] ?? p;
}

export function countryName(code: string | null | undefined): string {
  if (!code) return "Unknown";
  return COUNTRY_NAMES[code.toUpperCase()] ?? code;
}

export function countryLabel(code: string | null | undefined): string {
  if (!code) return "—";
  return `${flag(code)} ${countryName(code)}`;
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${fullNumber(n)} ${n === 1 ? word : pluralWord}`;
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

export function downloadFile(name: string, content: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function csv(rows: Array<Array<string | number | null>>): string {
  return rows.map((r) => r.map((v) => (v === null ? "" : typeof v === "number" ? String(Math.round(v * 10000) / 10000) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")).join("\n");
}

/** Acquisition source of an install (google_ads / referral: Android Play Install Referrer). */
export const SOURCE_LABELS: Record<InstallSource, string> = { apple_ads: "Apple Ads", google_ads: "Google Ads", referral: "Referral", organic: "Organic", unknown: "Unknown" };

/** Google Play cancel reason (user[:REASON] | system | developer | replacement) in words. */
export function cancelReasonLabel(r: string | null | undefined): string | null {
  if (!r) return null;
  const [who, reason] = r.split(":");
  const base = who === "user" ? "by the user" : who === "system" ? "by Google (billing problem)" : who === "developer" ? "by the developer" : who === "replacement" ? "replaced by another subscription" : who;
  return reason ? `${base} (${reason.toLowerCase().replace(/_/g, " ")})` : base;
}
