import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Download, Info, Table2 } from "lucide-react";
import { METRICS, type Chart, type Interval, type Metric } from "@shared/types";
import { ChartSkeleton, Legend, OTHER_COLOR, PALETTE, TimeChart, type ChartSeries } from "../components/charts";
import { FilterBar } from "../components/FilterBar";
import { Button } from "../components/ui/Button";
import { Select } from "../components/ui/Form";
import { Card, Delta, ErrorState, PageHeader, Segmented, Table, td, th } from "../components/ui/Misc";
import { api } from "../lib/api";
import { useFilters } from "../lib/filters";
import { bucketLabel, cn, csv, downloadFile, formatAxis, formatValue } from "../lib/format";
import { METRIC_GROUPS, METRIC_INFO } from "../lib/metrics";
import { useFetch } from "../lib/useFetch";

type GroupBy = "none" | "app" | "country" | "product";

export function ChartsPage() {
  const [params, setParams] = useSearchParams();
  const f = useFilters();
  const metric = (METRICS as readonly string[]).includes(params.get("metric") ?? "") ? (params.get("metric") as Metric) : "revenue";
  const interval = (["day", "week", "month"].includes(params.get("interval") ?? "") ? params.get("interval") : "auto") as Interval | "auto";
  const groupBy = (["app", "country", "product"].includes(params.get("groupBy") ?? "") ? params.get("groupBy") : "none") as GroupBy;
  const style = params.get("style") === "lines" ? "lines" : "stacked";
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showTable, setShowTable] = useState(true);

  const set = (k: string, v: string | null) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v === null) n.delete(k);
        else n.set(k, v);
        return n;
      },
      { replace: true },
    );

  const key = `chart:${metric}:${interval}:${groupBy}:${JSON.stringify(f.scope)}`;
  const c = useFetch(key, () => api.chart(metric, { ...f.scope, interval: interval === "auto" ? undefined : interval, groupBy: groupBy === "none" ? undefined : groupBy }), { tags: ["metrics"] });
  const info = METRIC_INFO[metric];
  const data = c.data;
  const isRate = data?.format === "percent";
  const asLines = groupBy !== "none" && (style === "lines" || isRate);

  const series: ChartSeries[] = useMemo(() => {
    if (!data) return [];
    if (data.series?.length) {
      let slot = 0;
      return data.series.map((s) => ({
        key: s.key,
        label: s.label,
        color: s.key === "other" ? OTHER_COLOR : PALETTE[slot++ % PALETTE.length],
        values: s.points.map((p) => p.value),
      }));
    }
    return [{ key: metric, label: info.label, color: "var(--viz-1)", values: data.points.map((p) => p.value) }];
  }, [data, metric, info.label]);
  const shown = series.filter((s) => !hidden.has(s.key));
  const dates = data?.points.map((p) => p.date) ?? (data?.series?.[0]?.points.map((p) => p.date) ?? []);

  const change = data && data.previousTotal ? data.total / data.previousTotal - 1 : null;
  const totalLabel = info.stock ? "At the end of the range" : isRate ? "Over the range" : "Total";

  const exportCsv = () => {
    if (!data) return;
    const header = ["date", ...(data.series?.length ? series.map((s) => s.label) : [metric])];
    const rows = dates.map((d, i) => [d, ...(data.series?.length ? series.map((s) => s.values[i] ?? 0) : [data.points[i]?.value ?? 0])]);
    downloadFile(`revflare-${metric}-${data.from}-${data.to}${groupBy !== "none" ? `-by-${groupBy}` : ""}.csv`, csv([header, ...rows]));
  };

  return (
    <>
      <PageHeader title="Charts" description="Explore every metric over time, by app, country or product." />
      <FilterBar range>
        <div className="flex-1" />
        <Button icon={<Download className="size-4" />} onClick={exportCsv} disabled={!data}>
          Export CSV
        </Button>
      </FilterBar>

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-zinc-100 p-4 sm:p-5 dark:border-zinc-800">
          <label className="min-w-56 flex-1 sm:flex-none">
            <span className="mb-1 block text-xs font-medium text-zinc-500">Metric</span>
            <Select
              value={metric}
              onChange={(e) => {
                setHidden(new Set());
                set("metric", e.target.value);
              }}
              aria-label="Metric"
            >
              {METRIC_GROUPS.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.metrics.map((m) => (
                    <option key={m} value={m}>
                      {METRIC_INFO[m].label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </label>
          <div>
            <span className="mb-1 block text-xs font-medium text-zinc-500">Interval</span>
            <Segmented
              label="Interval"
              value={interval}
              onChange={(v) => set("interval", v === "auto" ? null : v)}
              options={[
                { value: "auto", label: "Auto" },
                { value: "day", label: "Day" },
                { value: "week", label: "Week" },
                { value: "month", label: "Month" },
              ]}
            />
          </div>
          <div>
            <span className="mb-1 block text-xs font-medium text-zinc-500">Group by</span>
            <Segmented
              label="Group by"
              value={groupBy}
              onChange={(v) => {
                setHidden(new Set());
                set("groupBy", v === "none" ? null : v);
              }}
              options={[
                { value: "none", label: "None" },
                { value: "app", label: "App" },
                { value: "country", label: "Country" },
                { value: "product", label: "Product" },
              ]}
            />
          </div>
          {groupBy !== "none" && !isRate && (
            <div>
              <span className="mb-1 block text-xs font-medium text-zinc-500">Style</span>
              <Segmented
                label="Chart style"
                value={style}
                onChange={(v) => set("style", v === "stacked" ? null : v)}
                options={[
                  { value: "stacked", label: "Stacked" },
                  { value: "lines", label: "Lines" },
                ]}
              />
            </div>
          )}
        </div>

        <div className="p-4 sm:p-6">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold">{info.label}</h2>
              <p className="mt-0.5 max-w-xl text-[13px] text-zinc-500 dark:text-zinc-400">{info.description}</p>
            </div>
            {data && (
              <div className="sm:text-right">
                <p className="text-xs text-zinc-500">{totalLabel}</p>
                <p className="text-2xl font-semibold tracking-tight tabular-nums">{formatValue(data.total, data.format, data.currency)}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500 sm:justify-end">
                  <Delta change={change} invert={info.invert} />
                  {data.previousTotal !== null && <span>vs {formatValue(data.previousTotal, data.format, data.currency)} in the previous period</span>}
                </p>
              </div>
            )}
          </div>

          {c.error ? (
            <ErrorState error={c.error} onRetry={c.refetch} />
          ) : !data ? (
            <ChartSkeleton height={340} />
          ) : (
            <>
              {series.length > 1 && (
                <Legend
                  className="mb-4"
                  hidden={hidden}
                  onToggle={(k) =>
                    setHidden((h) => {
                      const n = new Set(h);
                      if (n.has(k)) n.delete(k);
                      else n.add(k);
                      return n;
                    })
                  }
                  items={series.map((s, i) => ({ key: s.key, label: s.label, color: s.color, line: asLines, value: data.series?.[i]?.total !== undefined ? formatValue(data.series[i].total!, data.format, data.currency) : undefined }))}
                />
              )}
              <TimeChart
                dates={dates}
                interval={data.interval}
                type={asLines || (groupBy === "none" && (info.stock || isRate)) ? "line" : "bar"}
                area={groupBy === "none"}
                height={340}
                series={shown}
                showTotal={!asLines && !isRate}
                formatValue={(v) => formatValue(v, data.format, data.currency)}
                formatAxis={(v) => formatAxis(v, data.format, data.currency)}
                label={`${info.label} from ${data.from} to ${data.to}, by ${data.interval}${groupBy !== "none" ? `, grouped by ${groupBy}` : ""}`}
                importedUntil={data.importedUntil}
              />
              {data.importedUntil && (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-zinc-500">
                  <Info className="size-3.5" /> Values up to {data.importedUntil} come from the RevenueCat import (shaded); later values are computed from Apple transactions.
                </p>
              )}
            </>
          )}
        </div>
      </Card>

      {data && (
        <Card className="mt-5">
          <div className="flex items-center justify-between px-5 py-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Table2 className="size-4 text-zinc-400" /> Data
            </h2>
            <Button size="sm" variant="ghost" onClick={() => setShowTable((s) => !s)} aria-expanded={showTable}>
              {showTable ? "Hide" : "Show"}
            </Button>
          </div>
          {showTable && <DataTable data={data} series={series} dates={dates} />}
        </Card>
      )}
    </>
  );
}

function DataTable({ data, series, dates }: { data: Chart; series: ChartSeries[]; dates: string[] }) {
  const grouped = !!data.series?.length;
  const fmt = (v: number) => formatValue(v, data.format, data.currency);
  const rows = [...dates.keys()].reverse();
  return (
    <Table className="max-h-[480px] overflow-y-auto border-t border-zinc-100 dark:border-zinc-800">
      <thead className="sticky top-0 bg-zinc-50/95 backdrop-blur dark:bg-zinc-900/95">
        <tr>
          <th className={th}>{data.interval === "day" ? "Day" : data.interval === "week" ? "Week" : "Month"}</th>
          {grouped ? series.map((s) => <th key={s.key} className={cn(th, "text-right")}>{s.label}</th>) : <th className={cn(th, "text-right")}>{METRIC_INFO[data.metric].label}</th>}
          {grouped && data.format !== "percent" && <th className={cn(th, "text-right")}>Total</th>}
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {rows.map((i) => {
          const imported = !!data.importedUntil && dates[i].slice(0, 10) <= data.importedUntil;
          return (
            <tr key={dates[i]} className="hover:bg-zinc-50/60 dark:hover:bg-zinc-800/30">
              <td className={cn(td, "text-zinc-600 dark:text-zinc-300")}>
                {bucketLabel(dates[i], data.interval)}
                {imported && (
                  <span className="ml-2 rounded bg-sky-50 px-1.5 py-px text-[10px] font-medium text-sky-700 dark:bg-sky-950/60 dark:text-sky-300" title="From the RevenueCat import">
                    imported
                  </span>
                )}
              </td>
              {grouped ? (
                series.map((s) => (
                  <td key={s.key} className={cn(td, "text-right tabular-nums")}>
                    {fmt(s.values[i] ?? 0)}
                  </td>
                ))
              ) : (
                <td className={cn(td, "text-right font-medium tabular-nums")}>{fmt(data.points[i]?.value ?? 0)}</td>
              )}
              {grouped && data.format !== "percent" && <td className={cn(td, "text-right font-medium tabular-nums")}>{fmt(series.reduce((a, s) => a + (s.values[i] ?? 0), 0))}</td>}
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
