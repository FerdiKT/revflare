// Terminal output helpers: colors, tables, numbers, dates. No dependencies.

let colorEnabled = !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

export function setColor(enabled: boolean) {
  colorEnabled = enabled;
}

const wrap = (open: number, close: number) => (s: string | number) => (colorEnabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

export const visibleLength = (s: string) => Array.from(s.replace(ANSI, "")).length;

/** One line, at most `max` visible characters (with an ellipsis). Not for colored strings. */
export function truncate(s: string | null | undefined, max: number): string {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(one);
  if (max <= 0) return "";
  return chars.length > max ? chars.slice(0, Math.max(max - 1, 0)).join("") + "…" : one;
}

export interface Column {
  header: string;
  align?: "left" | "right";
  /** This column shrinks (its cells are truncated) when the table is wider than the terminal. */
  flex?: boolean;
  /** Hard cap on the column width. */
  max?: number;
}

/** A plain text table. Cells may contain ANSI colors (only non-flex columns: flex cells are truncated as text). */
export function table(columns: Column[], rows: Array<Array<string | number | null | undefined>>, width = process.stdout.columns || 120): string {
  const cells = rows.map((r) => columns.map((col, i) => {
    const v = r[i];
    const s = v === null || v === undefined || v === "" ? "-" : String(v);
    return col.max ? truncate(s, col.max) : s;
  }));
  const widths = columns.map((col, i) => Math.max(visibleLength(col.header), ...cells.map((r) => visibleLength(r[i]))));
  const total = () => widths.reduce((a, b) => a + b, 0) + (columns.length - 1) * 2;
  const flex = columns.map((col, i) => (col.flex ? i : -1)).filter((i) => i >= 0);
  if (total() > width && flex.length) {
    const over = total() - width;
    const share = Math.ceil(over / flex.length);
    for (const i of flex) widths[i] = Math.max(visibleLength(columns[i].header), 12, widths[i] - share);
    for (const r of cells) for (const i of flex) r[i] = truncate(r[i], widths[i]);
  }
  const pad = (s: string, i: number) => {
    const n = widths[i] - visibleLength(s);
    if (n <= 0) return s;
    return columns[i].align === "right" ? " ".repeat(n) + s : s + " ".repeat(n);
  };
  const line = (r: string[]) => r.map(pad).join("  ").replace(/\s+$/, "");
  return [line(columns.map((col) => c.bold(col.header))), ...cells.map(line)].join("\n");
}

/** 1234 → "1,234"; 123456 → "123.5K"; 1234567 → "1.2M". */
export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const a = Math.abs(n);
  if (a >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (a >= 1e5) return `${+(n / 1e3).toFixed(1)}K`;
  return Math.round(n).toLocaleString("en-US");
}

const moneyFormats = new Map<string, Intl.NumberFormat>();

/** 1234.5 + "EUR" → "€1,234.50"; `compact` drops the cents from 1,000 up (tables, sparks). */
export function fmtMoney(n: number | null | undefined, currency: string, opts: { compact?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const digits = opts.compact && Math.abs(n) >= 1000 ? 0 : 2;
  const key = `${currency}:${digits}`;
  let f = moneyFormats.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits });
    } catch {
      f = new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }
    moneyFormats.set(key, f);
  }
  const out = f.format(n);
  return f.resolvedOptions().style === "currency" ? out : `${out} ${currency}`;
}

/** A value of a metric in its format (money in `currency`, counts, rates as percents). */
export function fmtValue(n: number | null | undefined, format: "money" | "count" | "percent", currency: string, opts: { compact?: boolean } = {}): string {
  if (format === "money") return fmtMoney(n, currency, opts);
  if (format === "percent") return fmtPct(n);
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return Number.isInteger(n) ? n.toLocaleString("en-US") : (+n.toFixed(2)).toLocaleString("en-US");
}

/** Relative change as a colored "+12.3%" (null → ""). `invert`: a rise is bad (churn, refunds). */
export function fmtChange(r: number | null | undefined, invert = false): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return "";
  const s = `${r > 0 ? "+" : ""}${+(r * 100).toFixed(1)}%`;
  if (!r) return c.gray(s);
  return (r > 0) !== invert ? c.green(s) : c.red(s);
}

const BARS = "▁▂▃▄▅▆▇█";

/** Unicode sparkline. */
export function sparkline(values: number[]): string {
  if (!values.length) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  return values.map((v) => BARS[max === min ? 0 : Math.round(((v - min) / (max - min)) * (BARS.length - 1))]).join("");
}

/** A horizontal bar of `width` cells for `share` (0..1). */
export function bar(share: number, width = 20): string {
  const n = Math.max(0, Math.min(width, Math.round(share * width)));
  return "█".repeat(n) + c.gray("·".repeat(width - n));
}

/** 0.0567 → "5.67%". */
export function fmtPct(r: number | null | undefined, digits = 2): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return "-";
  return `${+(r * 100).toFixed(digits)}%`;
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** Local "2026-10-14 09:00". */
export function fmtDate(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** "in 2h", "3d ago". */
export function fmtRelative(ms: number | null | undefined, now = Date.now()): string {
  if (ms === null || ms === undefined) return "";
  const d = ms - now;
  const a = Math.abs(d);
  const unit =
    a < 60_000 ? "now" : a < 3_600_000 ? `${Math.round(a / 60_000)}m` : a < 86_400_000 ? `${Math.round(a / 3_600_000)}h` : `${Math.round(a / 86_400_000)}d`;
  if (unit === "now") return "now";
  return d > 0 ? `in ${unit}` : `${unit} ago`;
}

/** A duration: "45s", "2m 14s", "3h 5m", "4d 2h". */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 && m < 10 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 && d < 7 ? `${d}d ${h % 24}h` : `${d}d`;
}

export const fmtWhen = (ms: number | null | undefined) => (ms === null || ms === undefined ? "-" : `${fmtDate(ms)} ${c.gray(`(${fmtRelative(ms)})`)}`);

/** "+12 (+5.3%)" colored green/red. */
export function fmtDelta(cur: number | null | undefined, prev: number | null | undefined): string {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return "";
  const d = cur - prev;
  if (!d) return c.gray("±0");
  const pct = prev ? ` ${d > 0 ? "+" : ""}${+((d / prev) * 100).toFixed(1)}%` : "";
  const s = `${d > 0 ? "+" : ""}${fmtNum(d)}${pct}`;
  return d > 0 ? c.green(s) : c.red(s);
}

const STATUS_COLORS: Record<string, (s: string) => string> = {
  done: c.green,
  active: c.green,
  trial: c.cyan,
  running: c.cyan,
  queued: c.gray,
  cancelled: c.gray,
  expired: c.gray,
  info: c.blue,
  grace: c.yellow,
  warning: c.yellow,
  billing_retry: c.yellow,
  failed: c.red,
  critical: c.red,
  revoked: c.red,
  refunded: c.red,
};

export const fmtStatus = (s: string) => (STATUS_COLORS[s] ?? ((x: string) => x))(s);

export function printJson(data: unknown) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

/** Prints lines (no argument: an empty line). */
export function println(...lines: string[]): void {
  process.stdout.write((lines.length ? lines.join("\n") : "") + "\n");
}

export function eprintln(s = ""): void {
  process.stderr.write(s + "\n");
}
