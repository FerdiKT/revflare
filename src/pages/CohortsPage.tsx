import { useState } from "react";
import { Grid3x3 } from "lucide-react";
import { FilterBar } from "../components/FilterBar";
import { Select } from "../components/ui/Form";
import { Card, EmptyState, ErrorState, PageHeader, Segmented, Skeleton } from "../components/ui/Misc";
import { api } from "../lib/api";
import { useFilters } from "../lib/filters";
import { cn, fullNumber, money, moneyCompact, monthLabel, percent } from "../lib/format";
import { useFetch } from "../lib/useFetch";

type Mode = "ltv" | "revenue" | "retained";

export function CohortsPage() {
  const { scope, apps } = useFilters();
  const [mode, setMode] = useState<Mode>("ltv");
  const [months, setMonths] = useState(12);
  const r = useFetch(`cohorts:${apps.join()}:${months}`, () => api.cohorts(scope, months), { tags: ["metrics"] });
  const d = r.data;
  const rows = d ? [...d.rows].sort((a, b) => b.cohort.localeCompare(a.cohort)) : [];
  const width = Math.max(0, ...rows.map((x) => x.revenue.length));

  const value = (row: (typeof rows)[number], i: number): number | null => {
    if (i >= row.revenue.length) return null;
    if (mode === "ltv") return row.ltv[i] ?? 0;
    if (mode === "revenue") return row.revenue[i] ?? 0;
    return row.customers ? (row.retained[i] ?? 0) / row.customers : 0;
  };
  // Color spans the observed range (min → max), so close values still read apart.
  let max = -Infinity;
  let min = Infinity;
  for (const row of rows)
    for (let i = 0; i < row.revenue.length; i++) {
      const v = value(row, i) ?? 0;
      max = Math.max(max, v);
      min = Math.min(min, v);
    }
  const fmt = (v: number) => (mode === "retained" ? percent(v, 0) : d ? (v >= 10_000 ? moneyCompact(v, d.currency) : money(v, d.currency, { cents: v < 100 })) : "");

  return (
    <>
      <PageHeader title="Cohorts" description="Customers grouped by the month of their first payment, followed month by month." />
      <FilterBar>
        <div className="flex-1" />
        <Segmented
          label="Value"
          value={mode}
          onChange={setMode}
          options={[
            { value: "ltv", label: "LTV", title: "Cumulative revenue per customer" },
            { value: "revenue", label: "Revenue", title: "Revenue of the cohort in each month" },
            { value: "retained", label: "Retained %", title: "Share of the cohort still paying" },
          ]}
        />
        <Select value={String(months)} onChange={(e) => setMonths(Number(e.target.value))} aria-label="Cohorts" className="w-36">
          <option value="6">6 months</option>
          <option value="12">12 months</option>
          <option value="24">24 months</option>
        </Select>
      </FilterBar>
      {r.error && <ErrorState error={r.error} onRetry={r.refetch} className="mb-5" />}
      <Card className="overflow-hidden">
        {!d ? (
          <div className="space-y-1.5 p-5">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<Grid3x3 />} title="No cohorts yet" description="Cohorts appear once customers have paid. Import history from Apple or RevenueCat on the Imports page." />
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full min-w-max border-separate border-spacing-[3px] p-3 text-sm" aria-label={`Cohort ${mode === "ltv" ? "LTV" : mode === "revenue" ? "revenue" : "retention"} by month since first payment`}>
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 bg-white px-3 py-2 text-left text-xs font-medium text-zinc-500 dark:bg-zinc-900">Cohort</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-zinc-500">Customers</th>
                  {Array.from({ length: width }, (_, i) => (
                    <th key={i} className="px-2 py-2 text-center text-xs font-medium text-zinc-500">
                      {i === 0 ? "Month 0" : `+${i}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.cohort}>
                    <th scope="row" className="sticky left-0 z-10 bg-white px-3 py-1.5 text-left font-medium whitespace-nowrap dark:bg-zinc-900">
                      {monthLabel(row.cohort)}
                    </th>
                    <td className="px-3 py-1.5 text-right text-zinc-600 tabular-nums dark:text-zinc-300">{fullNumber(row.customers)}</td>
                    {Array.from({ length: width }, (_, i) => {
                      const v = value(row, i);
                      if (v === null) return <td key={i} />;
                      const p = max > min ? Math.round(6 + ((v - min) / (max - min)) * 94) : 50;
                      const title = `${monthLabel(row.cohort)}, month ${i}: ${fmt(v)}${mode === "retained" ? ` (${fullNumber(row.retained[i] ?? 0)} of ${fullNumber(row.customers)})` : ""}`;
                      return (
                        <td
                          key={i}
                          title={title}
                          className={cn("min-w-16 rounded-md px-2 py-1.5 text-center text-xs font-medium tabular-nums", p > 62 ? "text-white" : "text-zinc-800 dark:text-zinc-100")}
                          style={{ backgroundColor: `color-mix(in oklab, var(--viz-seq) ${p}%, var(--viz-surface))` }}
                        >
                          {fmt(v)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {d && rows.length > 0 && (
        <p className="mt-3 text-xs text-zinc-500">
          {mode === "ltv" ? "LTV: cumulative revenue per customer of the cohort, month by month." : mode === "revenue" ? "Revenue of each cohort in each month after the first payment." : "Retained: share of the cohort's customers paying in that month."} Stronger color is higher. Amounts in {d.currency}.
        </p>
      )}
    </>
  );
}
