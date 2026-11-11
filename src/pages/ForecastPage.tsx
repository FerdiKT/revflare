import { useState } from "react";
import { ChartSkeleton, InlineBar, Legend, TimeChart } from "../components/charts";
import { FilterBar } from "../components/FilterBar";
import { Card, CardHeader, ErrorState, PageHeader, Segmented, Skeleton, Stat } from "../components/ui/Misc";
import { api } from "../lib/api";
import { useFilters } from "../lib/filters";
import { formatAxis, money, percent, periodLabel } from "../lib/format";
import { useFetch } from "../lib/useFetch";

export function ForecastPage() {
  const { scope, apps } = useFilters();
  const [days, setDays] = useState("30");
  const r = useFetch(`forecast:${apps.join()}:${days}`, () => api.forecast(scope, Number(days)), { tags: ["metrics"] });
  const d = r.data;
  const due = d?.points.reduce((a, p) => a + p.due, 0) ?? 0;
  const rates = d ? Object.entries(d.renewalRates).sort((a, b) => (a[0] === "trial" ? 1 : b[0] === "trial" ? -1 : a[0].localeCompare(b[0]))) : [];

  return (
    <>
      <PageHeader title="Forecast" description="Renewal revenue expected from subscriptions that come up for renewal." />
      <FilterBar>
        <div className="flex-1" />
        <Segmented
          label="Horizon"
          value={days}
          onChange={setDays}
          options={[
            { value: "7", label: "7 days" },
            { value: "30", label: "30 days" },
            { value: "90", label: "90 days" },
          ]}
        />
      </FilterBar>
      {r.error && <ErrorState error={r.error} onRetry={r.refetch} className="mb-5" />}
      <div className="grid gap-5 sm:grid-cols-3">
        <Card className="p-5">
          {d ? <Stat label={`Expected in the next ${d.days} days`} value={money(d.expected, d.currency)} sub="Due renewals × renewal rate of their period" /> : <Skeleton className="h-16" />}
        </Card>
        <Card className="p-5">{d ? <Stat label="Due if everyone renews" value={money(due, d.currency)} sub="Price of every renewal coming up" /> : <Skeleton className="h-16" />}</Card>
        <Card className="p-5">{d ? <Stat label="Expected share" value={due ? percent(d.expected / due) : "—"} sub="Blended renewal rate" /> : <Skeleton className="h-16" />}</Card>
      </div>
      <div className="mt-5 grid gap-5 lg:grid-cols-3 [&>*]:min-w-0">
        <Card className="lg:col-span-2">
          <CardHeader title="Daily renewals" description="Due (the full price of renewals coming up) vs expected (after renewal rates)" />
          <div className="px-3 pb-5 sm:px-5">
            {!d ? (
              <ChartSkeleton height={280} />
            ) : (
              <>
                <Legend
                  className="mb-3 px-2"
                  items={[
                    { key: "due", label: "Due", color: "var(--viz-muted-mark)" },
                    { key: "expected", label: "Expected", color: "var(--viz-1)" },
                  ]}
                />
                <TimeChart
                  dates={d.points.map((p) => p.date)}
                  interval="day"
                  overlay
                  height={280}
                  series={[
                    { key: "due", label: "Due", color: "var(--viz-muted-mark)", values: d.points.map((p) => p.due) },
                    { key: "expected", label: "Expected", color: "var(--viz-1)", values: d.points.map((p) => p.expected) },
                  ]}
                  formatValue={(v) => money(v, d.currency)}
                  formatAxis={(v) => formatAxis(v, "money", d.currency)}
                  label={`Renewal revenue due and expected per day over the next ${d.days} days`}
                />
              </>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Renewal rates used" description="Share of subscriptions that renewed recently, per billing period" />
          <div className="space-y-4 px-5 pb-5">
            {!d
              ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-8" />)
              : rates.map(([period, rate]) => (
                  <div key={period}>
                    <div className="mb-1.5 flex items-center justify-between text-sm">
                      <span>{period === "trial" ? "Trial conversion" : periodLabel(period)}</span>
                      <span className="font-semibold tabular-nums">{percent(rate)}</span>
                    </div>
                    <InlineBar value={rate} max={1} />
                  </div>
                ))}
            {d && rates.length === 0 && <p className="text-sm text-zinc-500">Not enough renewal history yet.</p>}
          </div>
        </Card>
      </div>
    </>
  );
}
