// Hand-built SVG charts (no chart library), following the dataviz method: thin marks (2px lines, columns ≤ 28px
// with 4px rounded data-ends and a 2px surface gap between stacked segments), hairline grid, one y-scale per chart,
// text in ink tokens (never the series color), a hover/focus layer with one tooltip, keyboard reading with arrows.

import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Interval } from "@shared/types";
import { bucketLabel, cn } from "../lib/format";

/** Categorical slots in fixed order (never cycled past 8: fold the rest into "Other"). */
export const PALETTE = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)", "var(--viz-5)", "var(--viz-6)", "var(--viz-7)", "var(--viz-8)"];
export const OTHER_COLOR = "var(--viz-muted-mark)";

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Round tick values covering [min, max] (min ≤ 0 ≤ max when `zero`). */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    if (max === 0) return [0, 1];
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  const span = max - min;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v / step) * step);
  return out;
}

/** Column path: square at the baseline, rounded data-end (radius ≤ 4). Works downwards when y > base. */
function columnPath(x: number, top: number, w: number, bottom: number, roundTop: boolean, roundBottom: boolean): string {
  const h = bottom - top;
  if (h <= 0.25) return "";
  const r = Math.min(4, w / 2, h / (roundTop && roundBottom ? 2 : 1));
  const rt = roundTop ? r : 0;
  const rb = roundBottom ? r : 0;
  return `M${x},${bottom - rb}V${top + rt}${rt ? `Q${x},${top} ${x + rt},${top}` : ""}H${x + w - rt}${rt ? `Q${x + w},${top} ${x + w},${top + rt}` : ""}V${bottom - rb}${rb ? `Q${x + w},${bottom} ${x + w - rb},${bottom}` : ""}H${x + rb}${rb ? `Q${x},${bottom} ${x},${bottom - rb}` : ""}Z`;
}

export function LineKey({ color, dashed }: { color: string; dashed?: boolean }) {
  return dashed ? (
    <svg width="14" height="4" aria-hidden className="shrink-0">
      <line x1="1" y1="2" x2="13" y2="2" stroke={color} strokeWidth="2" strokeDasharray="3 2" strokeLinecap="round" />
    </svg>
  ) : (
    <span aria-hidden className="inline-block h-0.5 w-3.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
  );
}

export function SwatchKey({ color }: { color: string }) {
  return <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: color }} />;
}

function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(180);
  useLayoutEffect(() => {
    if (ref.current && ref.current.offsetWidth !== w) setW(ref.current.offsetWidth);
  });
  const left = x + 14 + w > width ? Math.max(0, x - 14 - w) : x + 14;
  return (
    <div
      ref={ref}
      role="presentation"
      className="pointer-events-none absolute top-0 z-10 min-w-40 rounded-xl bg-white/95 px-3 py-2.5 text-xs shadow-lg ring-1 ring-zinc-200 backdrop-blur dark:bg-zinc-800/95 dark:ring-zinc-700"
      style={{ left }}
    >
      {children}
    </div>
  );
}

export function TooltipRow({ color, value, label, bar, dashed, strong }: { color?: string; value: ReactNode; label: ReactNode; bar?: boolean; dashed?: boolean; strong?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2 py-0.5", strong && "mt-1 border-t border-zinc-100 pt-1.5 dark:border-zinc-700")}>
      {color ? bar ? <SwatchKey color={color} /> : <LineKey color={color} dashed={dashed} /> : <span className="w-3.5" />}
      <span className="min-w-0 flex-1 truncate text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="pl-3 font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{value}</span>
    </div>
  );
}

function useIndexNav(count: number) {
  const [index, setIndex] = useState<number | null>(null);
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!count) return;
      if (e.key === "Escape") return setIndex(null);
      const cur = index ?? count - 1;
      const next = e.key === "ArrowRight" ? Math.min(count - 1, cur + 1) : e.key === "ArrowLeft" ? Math.max(0, cur - 1) : e.key === "Home" ? 0 : e.key === "End" ? count - 1 : null;
      if (next === null) return;
      e.preventDefault();
      setIndex(next);
    },
    [count, index],
  );
  return { index, setIndex, onKeyDown, onFocus: () => setIndex((i) => i ?? count - 1), onBlur: () => setIndex(null) };
}

const MONTH_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short" });
const DAY_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });

function axisLabel(date: string, interval: Interval, first: boolean): string {
  const d = new Date(`${date.length === 7 ? `${date}-01` : date.slice(0, 10)}T00:00:00Z`);
  if (interval === "month") {
    const m = MONTH_FMT.format(d);
    return first || d.getUTCMonth() === 0 ? `${m} ’${String(d.getUTCFullYear()).slice(2)}` : m;
  }
  return DAY_FMT.format(d);
}

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  values: number[];
  /** Drawn as a line over the bars (e.g. net MRR movement). */
  line?: boolean;
  dashed?: boolean;
}

/**
 * Time series: columns (stacked, with negatives going down) or lines, over UTC buckets. One crosshair and tooltip;
 * an optional shaded band marks buckets whose values come from an import.
 */
export function TimeChart({
  dates,
  interval,
  series,
  type = "bar",
  overlay = false,
  height = 240,
  formatValue,
  formatAxis,
  label,
  importedUntil,
  importedLabel = "Imported from RevenueCat",
  showTotal,
  totalLabel = "Total",
  area,
  compact,
}: {
  dates: string[];
  interval: Interval;
  series: ChartSeries[];
  type?: "bar" | "line";
  /** Bars drawn over each other (due vs expected) instead of stacked: the later series is narrower, in front. */
  overlay?: boolean;
  height?: number;
  formatValue: (v: number) => string;
  formatAxis: (v: number) => string;
  /** Accessible title. */
  label: string;
  importedUntil?: string | null;
  importedLabel?: string;
  /** Show a total row in the tooltip (stacked bars of several series). */
  showTotal?: boolean;
  totalLabel?: string;
  /** Fill under a single line. */
  area?: boolean;
  /** Smaller paddings and fewer ticks (cards). */
  compact?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const gradient = useId();
  const n = dates.length;
  const nav = useIndexNav(n);
  const bars = type === "bar" ? series.filter((s) => !s.line) : [];
  const lines = type === "line" ? series : series.filter((s) => s.line);

  // Domain: stacked sums (positive and negative separately) or plain values.
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    if (bars.length && !overlay) {
      let p = 0;
      let m = 0;
      for (const s of bars) {
        const v = s.values[i] ?? 0;
        if (v >= 0) p += v;
        else m += v;
      }
      hi = Math.max(hi, p);
      lo = Math.min(lo, m);
    } else
      for (const s of bars) {
        hi = Math.max(hi, s.values[i] ?? 0);
        lo = Math.min(lo, s.values[i] ?? 0);
      }
    for (const s of lines) {
      hi = Math.max(hi, s.values[i] ?? 0);
      lo = Math.min(lo, s.values[i] ?? 0);
    }
  }
  const ticks = niceTicks(lo, hi, compact ? 3 : 4);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const gutter = Math.max(36, ...ticks.map((t) => formatAxis(t).length * 6.4 + 12));
  const padT = 8;
  const axisH = 22;
  const plotH = height - padT - axisH;
  const plotW = Math.max(0, width - gutter - 4);
  const band = n ? plotW / n : 0;
  const barW = band >= 4 ? Math.min(28, band - Math.max(2, band * 0.22)) : Math.max(1, band);
  const yOf = (v: number) => padT + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
  const cx = (i: number) => gutter + i * band + band / 2;
  const base = yOf(0);

  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 70))));
  const xLabels: number[] = [];
  for (let i = n - 1; i >= 0; i -= labelEvery) xLabels.unshift(i);

  const hover = nav.index;
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    nav.setIndex(Math.max(0, Math.min(n - 1, Math.floor((e.clientX - rect.left) / band))));
  };

  // Imported band: buckets up to and including importedUntil.
  let importedEnd = -1;
  if (importedUntil) for (let i = 0; i < n; i++) if (dates[i].slice(0, 10) <= importedUntil) importedEnd = i;

  const linePath = (s: ChartSeries) => {
    let d = "";
    for (let i = 0; i < n; i++) d += `${i ? "L" : "M"}${cx(i).toFixed(1)},${yOf(s.values[i] ?? 0).toFixed(1)}`;
    return d;
  };

  const total = (i: number) => bars.reduce((a, s) => a + (s.values[i] ?? 0), 0);

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}>
      {width > 0 && n > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${label}. Use the left and right arrow keys to read each ${interval}.`}
          tabIndex={0}
          onKeyDown={nav.onKeyDown}
          onFocus={nav.onFocus}
          onBlur={nav.onBlur}
          className="block overflow-visible rounded-md focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-500"
        >
          <title>{label}</title>
          {lines.length === 1 && area && (
            <defs>
              <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor={lines[0].color} stopOpacity={0.18} />
                <stop offset="1" stopColor={lines[0].color} stopOpacity={0.01} />
              </linearGradient>
            </defs>
          )}
          {importedEnd >= 0 && (
            <g>
              <rect x={gutter} y={padT} width={(importedEnd + 1) * band} height={plotH} fill="var(--viz-imported)" />
              <line x1={gutter + (importedEnd + 1) * band} x2={gutter + (importedEnd + 1) * band} y1={padT} y2={padT + plotH} stroke="var(--viz-axis)" strokeDasharray="3 3" />
              {(importedEnd + 1) * band > 120 && (
                <text x={gutter + 6} y={padT + 12} className="text-[10px] font-medium" fill="var(--viz-ink-muted)">
                  {importedLabel}
                </text>
              )}
            </g>
          )}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={gutter} x2={width - 4} y1={yOf(t)} y2={yOf(t)} stroke={t === 0 ? "var(--viz-axis)" : "var(--viz-grid)"} strokeWidth={1} shapeRendering="crispEdges" />
              <text x={gutter - 8} y={yOf(t) + 3.5} textAnchor="end" className="text-[10.5px] tabular-nums" fill="var(--viz-ink-muted)">
                {formatAxis(t)}
              </text>
            </g>
          ))}
          {hover !== null && type === "bar" && <rect x={gutter + hover * band} y={padT} width={band} height={plotH} className="fill-zinc-900/[0.04] dark:fill-white/[0.06]" />}
          {/* Columns */}
          {bars.length > 0 &&
            dates.map((d, i) => {
              const dim = hover !== null && hover !== i ? 0.55 : 1;
              const x = cx(i) - barW / 2;
              if (overlay)
                return (
                  <g key={d} opacity={dim}>
                    {bars.map((s, k) => {
                      const v = s.values[i] ?? 0;
                      const w = k === 0 ? barW : Math.max(1, barW * 0.55);
                      const top = Math.min(yOf(v), base);
                      const bottom = Math.max(yOf(v), base);
                      return <path key={s.key} d={columnPath(cx(i) - w / 2, top, w, bottom, v > 0, v < 0)} fill={s.color} />;
                    })}
                  </g>
                );
              // Stack: positives up from 0, negatives down; 2px surface gap between segments.
              let up = 0;
              let down = 0;
              const pos = bars.filter((s) => (s.values[i] ?? 0) > 0);
              const neg = bars.filter((s) => (s.values[i] ?? 0) < 0);
              const gap = barW >= 4 ? 2 : 0;
              return (
                <g key={d} opacity={dim}>
                  {pos.map((s, k) => {
                    const v = s.values[i];
                    const bottom = yOf(up) - (k ? gap / 2 : 0);
                    up += v;
                    const top = yOf(up) + (k < pos.length - 1 ? gap / 2 : 0);
                    return <path key={s.key} d={columnPath(x, top, barW, bottom, k === pos.length - 1, false)} fill={s.color} />;
                  })}
                  {neg.map((s, k) => {
                    const v = s.values[i];
                    const top = yOf(down) + (k ? gap / 2 : 0);
                    down += v;
                    const bottom = yOf(down) - (k < neg.length - 1 ? gap / 2 : 0);
                    return <path key={s.key} d={columnPath(x, top, barW, bottom, false, k === neg.length - 1)} fill={s.color} />;
                  })}
                </g>
              );
            })}
          {/* Lines */}
          {lines.map((s) => (
            <g key={s.key}>
              {area && lines.length === 1 && n > 1 && <path d={`${linePath(s)}L${cx(n - 1)},${padT + plotH}L${cx(0)},${padT + plotH}Z`} fill={`url(#${gradient})`} />}
              <path d={linePath(s)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? "4 3" : undefined} />
              {n <= 16 && type === "line" && dates.map((d, i) => <circle key={d} cx={cx(i)} cy={yOf(s.values[i] ?? 0)} r={2.5} fill={s.color} />)}
            </g>
          ))}
          {hover !== null && lines.length > 0 && (
            <g>
              {type === "line" && <line x1={cx(hover)} x2={cx(hover)} y1={padT} y2={padT + plotH} stroke="var(--viz-axis)" shapeRendering="crispEdges" />}
              {lines.map((s) => (
                <circle key={s.key} cx={cx(hover)} cy={yOf(s.values[hover] ?? 0)} r={4.5} fill={s.color} stroke="var(--viz-surface)" strokeWidth={2} />
              ))}
            </g>
          )}
          {hover === null && type === "line" && lines.length === 1 && n > 16 && (
            <circle cx={cx(n - 1)} cy={yOf(lines[0].values[n - 1] ?? 0)} r={4} fill={lines[0].color} stroke="var(--viz-surface)" strokeWidth={2} />
          )}
          {xLabels.map((i, k) => (
            <text key={dates[i]} x={cx(i)} y={height - 6} textAnchor={i === n - 1 && band < 50 ? "end" : k === 0 && band < 50 && i === 0 ? "start" : "middle"} className="text-[10.5px]" fill="var(--viz-ink-muted)">
              {axisLabel(dates[i], interval, k === 0)}
            </text>
          ))}
          <rect x={gutter} y={0} width={plotW} height={padT + plotH} fill="transparent" onPointerMove={onMove} onPointerLeave={() => nav.setIndex(null)} />
        </svg>
      )}
      {hover !== null && n > 0 && (
        <Tooltip x={cx(hover)} width={width}>
          <p className="mb-1 font-medium text-zinc-700 dark:text-zinc-200">{bucketLabel(dates[hover], interval)}</p>
          {series.map((s) => (
            <TooltipRow key={s.key} color={s.color} bar={type === "bar" && !s.line} dashed={s.dashed} value={formatValue(s.values[hover] ?? 0)} label={s.label} />
          ))}
          {showTotal && bars.length > 1 && <TooltipRow value={formatValue(total(hover))} label={totalLabel} strong />}
          {importedEnd >= hover && <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">{importedLabel}</p>}
        </Tooltip>
      )}
    </div>
  );
}

/** Legend: swatch (bars) or stroke (lines) + label (+ value). Click toggles a series when `onToggle` is set. */
export function Legend({
  items,
  hidden,
  onToggle,
  className,
}: {
  items: Array<{ key: string; label: string; color: string; value?: string; line?: boolean; dashed?: boolean }>;
  hidden?: Set<string>;
  onToggle?: (key: string) => void;
  className?: string;
}) {
  return (
    <ul className={cn("flex flex-wrap gap-x-4 gap-y-1.5 text-xs", className)}>
      {items.map((it) => {
        const off = hidden?.has(it.key);
        const content = (
          <>
            {it.line ? <LineKey color={it.color} dashed={it.dashed} /> : <SwatchKey color={it.color} />}
            <span className={cn("text-zinc-600 dark:text-zinc-300", off && "line-through opacity-60")}>{it.label}</span>
            {it.value && <span className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{it.value}</span>}
          </>
        );
        return (
          <li key={it.key}>
            {onToggle ? (
              <button type="button" aria-pressed={!off} onClick={() => onToggle(it.key)} className="flex items-center gap-1.5 rounded px-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                {content}
              </button>
            ) : (
              <span className="flex items-center gap-1.5">{content}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Tiny trend line for KPI tiles (decorative: the tile states the value and change). */
export function Sparkline({ values, color = "var(--viz-1)", className, height = 36 }: { values: number[]; color?: string; className?: string; height?: number }) {
  const id = useId();
  const [ref, width] = useWidth<HTMLDivElement>();
  const n = values.length;
  let path = "";
  let areaPath = "";
  if (n > 1 && width > 0) {
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = hi - lo || 1;
    const pad = 3;
    const pts = values.map((v, i) => [(i / (n - 1)) * (width - pad * 2) + pad, pad + (height - pad * 2) * (1 - (v - lo) / span)] as const);
    path = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
    areaPath = `${path}L${pts[n - 1][0]},${height}L${pts[0][0]},${height}Z`;
  }
  return (
    <div ref={ref} className={cn("w-full", className)} style={{ height }} aria-hidden>
      {path && (
        <svg width={width} height={height} className="block overflow-visible">
          <defs>
            <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity={0.16} />
              <stop offset="1" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={areaPath} fill={`url(#${id})`} />
          <path d={path} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      )}
    </div>
  );
}

/** Goal progress ring. */
export function ProgressRing({ progress, size = 64, stroke = 7, children, label }: { progress: number; size?: number; stroke?: number; children?: ReactNode; label: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, progress));
  const id = useId();
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg width={size} height={size} className="-rotate-90">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f95716" />
            <stop offset="1" stopColor="#f59e0b" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-zinc-100 dark:stroke-zinc-800" />
        {p > 0 && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`url(#${id})`} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${c * p} ${c}`} />}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  );
}

/** Horizontal magnitude bar for table cells. */
export function InlineBar({ value, max, color = "var(--viz-1)" }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.max(value > 0 ? 2 : 0, (value / max) * 100) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800" aria-hidden>
      <div className="h-full rounded-r-full" style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  );
}

/** Chart placeholder while loading. */
export function ChartSkeleton({ height = 240 }: { height?: number }) {
  return (
    <div className="flex items-end gap-1.5 px-2" style={{ height }} aria-hidden>
      {Array.from({ length: 24 }, (_, i) => (
        <div key={i} className="flex-1 animate-pulse rounded-t bg-zinc-100 dark:bg-zinc-800/80" style={{ height: `${25 + ((i * 37) % 60)}%` }} />
      ))}
    </div>
  );
}
