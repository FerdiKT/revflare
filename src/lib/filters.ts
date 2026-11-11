// Global filters live in the URL: `apps=id1,id2`, and `range=28d` or `from=YYYY-MM-DD&to=YYYY-MM-DD`.
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import type { Scope } from "./api";

export const RANGE_PRESETS = [
  { value: "7d", label: "Last 7 days", short: "7D" },
  { value: "28d", label: "Last 28 days", short: "28D" },
  { value: "90d", label: "Last 90 days", short: "90D" },
  { value: "12m", label: "Last 12 months", short: "12M" },
  { value: "mtd", label: "Month to date", short: "MTD" },
  { value: "ytd", label: "Year to date", short: "YTD" },
  { value: "all", label: "All time", short: "All" },
] as const;

export const DEFAULT_RANGE = "28d";
export const GLOBAL_KEYS = ["apps", "range", "from", "to"] as const;

const isDay = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export interface Filters {
  apps: string[];
  range: string;
  from: string | null;
  to: string | null;
  /** Range part of the API scope (custom from/to wins over the preset). */
  scope: Scope;
  /** Short human label of the range. */
  rangeLabel: string;
  setApps: (ids: string[]) => void;
  setRange: (r: { range: string } | { from: string; to: string }) => void;
}

export function useFilters(defaultRange = DEFAULT_RANGE): Filters {
  const [params, setParams] = useSearchParams();
  const appsParam = params.get("apps") ?? "";
  const rangeParam = params.get("range");
  const fromParam = params.get("from");
  const toParam = params.get("to");

  const setApps = useCallback(
    (ids: string[]) =>
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          if (ids.length) n.set("apps", ids.join(","));
          else n.delete("apps");
          return n;
        },
        { replace: true },
      ),
    [setParams],
  );

  const setRange = useCallback(
    (r: { range: string } | { from: string; to: string }) =>
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          n.delete("range");
          n.delete("from");
          n.delete("to");
          if ("range" in r) n.set("range", r.range);
          else {
            n.set("from", r.from);
            n.set("to", r.to);
          }
          return n;
        },
        { replace: true },
      ),
    [setParams],
  );

  return useMemo(() => {
    const apps = appsParam.split(",").filter(Boolean);
    const custom = isDay(fromParam) && isDay(toParam);
    const range = custom ? "custom" : rangeParam && RANGE_PRESETS.some((p) => p.value === rangeParam) ? rangeParam : defaultRange;
    const scope: Scope = { apps, ...(custom ? { from: fromParam, to: toParam } : { range }) };
    const rangeLabel = custom ? `${fromParam} – ${toParam}` : (RANGE_PRESETS.find((p) => p.value === range)?.label ?? range);
    return { apps, range, from: custom ? fromParam : null, to: custom ? toParam : null, scope, rangeLabel, setApps, setRange };
  }, [appsParam, rangeParam, fromParam, toParam, defaultRange, setApps, setRange]);
}

/** "?apps=…&range=…" of the current URL, to carry the global filters across navigation. */
export function useGlobalSearch(): string {
  const [params] = useSearchParams();
  return useMemo(() => {
    const n = new URLSearchParams();
    for (const k of GLOBAL_KEYS) {
      const v = params.get(k);
      if (v) n.set(k, v);
    }
    const s = n.toString();
    return s ? `?${s}` : "";
  }, [params]);
}

/** Today in UTC, YYYY-MM-DD. */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
