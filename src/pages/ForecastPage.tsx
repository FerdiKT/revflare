import { useState } from "react";
import { CheckCircle2, TriangleAlert } from "lucide-react";
import type { Interval, Projection, ProjectionBand, ProjectionHorizon, ProjectionPoint } from "@shared/types";
import { ChartSkeleton, Legend, TimeChart, type ChartSeries } from "../components/charts";
import { FilterBar } from "../components/FilterBar";
import { Badge, Card, CardHeader, ErrorState, PageHeader, Segmented, Skeleton, Stat, Table, td, th } from "../components/ui/Misc";
import { api } from "../lib/api";
import { useFilters } from "../lib/filters";
import { cn, date, formatAxis, money, percent, periodLabel, signedPercent } from "../lib/format";
import { useFetch } from "../lib/useFetch";

// Revenue projection (docs/projection.md): expected proceeds and MRR for the next 30 / 90 / 365 days from today's
// subscriptions (renewal rates per app, billing period and renewal order), new subscribers and one-time purchases,
// with 90% bands, upcoming long renewals, the renewal rates used and the backtest against what really happened.

type View = "withNew" | "existing";
const HORIZON_DAYS: Record<ProjectionHorizon, number> = { d30: 30, d90: 90, d365: 365 };
const STAGE_LABEL: Record<string, string> = { trial: "Trial → paid", intro: "Intro → full price", r1: "1st renewal", r2: "2nd renewal", r3: "3rd+ renewal" };
const STATUS_LABEL: Record<string, string> = { on: "Auto-renew", off: "Auto-renew off", retry: "Billing retry", grace: "Grace period" };
const SOURCE_LABEL: Record<string, string> = { app: "App history", portfolio: "Portfolio", default: "Default" };
/** A backtest error above this marks the projection as rough. */
const ROUGH = 0.15;

const bandText = (b: ProjectionBand, currency: string) => `${money(b.low, currency)} – ${money(b.high, currency)}`;

export function ForecastPage() {
  const { scope, apps } = useFilters();
  const [view, setView] = useState<View>("withNew");
  const [horizon, setHorizon] = useState<ProjectionHorizon>("d90");
  const [grain, setGrain] = useState<"auto" | "day" | "week">("auto");
  const r = useFetch(`projection:${apps.join()}`, () => api.projection(scope), { tags: ["metrics"] });
  const p = r.data;
  const n = HORIZON_DAYS[horizon];
  const interval: Interval = grain === "auto" ? (n > 30 ? "week" : "day") : grain;
  const pts: ProjectionPoint[] = p ? (interval === "week" ? p.weekly.slice(0, Math.ceil(n / 7)) : p.daily.slice(0, n)) : [];
  const t = p?.totals[horizon];
  const err = p ? (view === "withNew" ? p.backtestError.withNew : p.backtestError.existing) : null;
  const rough = err !== null && err > ROUGH;

  return (
    <>
      <PageHeader
        title="Projection"
        description="Expected proceeds and MRR from today's subscriptions (renewal rates per app, billing period and renewal order), new subscribers and one-time purchases, with a 90% band and a backtest."
      />
      <FilterBar>
        <div className="flex-1" />
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: "withNew" as const, label: "With new subscribers" },
            { value: "existing" as const, label: "Existing only" },
          ]}
        />
        <Segmented
          label="Horizon"
          value={horizon}
          onChange={setHorizon}
          options={[
            { value: "d30" as const, label: "30 days" },
            { value: "d90" as const, label: "90 days" },
            { value: "d365" as const, label: "365 days" },
          ]}
        />
        <Segmented
          label="Granularity"
          value={grain}
          onChange={setGrain}
          options={[
            { value: "auto" as const, label: "Auto" },
            { value: "day" as const, label: "Day" },
            { value: "week" as const, label: "Week" },
          ]}
        />
      </FilterBar>
      {r.error && <ErrorState error={r.error} onRetry={r.refetch} className="mb-5" />}

      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-5">
          {p && t ? (
            <Stat
              label={`Expected proceeds, next ${n} days`}
              value={money(t[view].expected, p.currency)}
              sub={
                <>
                  90% band {bandText(t[view], p.currency)}
                  <span className="block">gross {money(view === "withNew" ? t.withNewGross : t.existingGross, p.currency)} · after refunds and commission</span>
                </>
              }
            />
          ) : (
            <Skeleton className="h-20" />
          )}
        </Card>
        <Card className="p-5">
          {p && t ? (
            <Stat
              label={`MRR in ${n} days`}
              value={money((view === "withNew" ? t.mrrWithNew : t.mrr).expected, p.currency)}
              sub={
                <>
                  now {money(p.summary.mrrNow, p.currency)} · band {bandText(view === "withNew" ? t.mrrWithNew : t.mrr, p.currency)}
                </>
              }
            />
          ) : (
            <Skeleton className="h-20" />
          )}
        </Card>
        <Card className="p-5">
          {p ? (
            <Stat
              label="Backtest error"
              value={<span className={cn(rough && "text-amber-600 dark:text-amber-400")}>{err === null ? "—" : `±${percent(err)}`}</span>}
              sub={
                err === null ? (
                  "Not enough history to replay the model"
                ) : (
                  <>
                    mean absolute error, model run {p.backtest.map((b) => `${b.days}`).join(" and ")} days ago
                    {rough && <span className="block text-amber-700 dark:text-amber-400">Small or changing volume: treat the projection as rough.</span>}
                  </>
                )
              }
            />
          ) : (
            <Skeleton className="h-20" />
          )}
        </Card>
        <Card className="p-5">
          {p ? (
            <Stat
              label="Long renewals, next 90 days"
              value={money(p.upcoming.price, p.currency)}
              sub={`${p.upcoming.count} renewals of 6 months or more (full price) · ${money(p.upcoming.expectedProceeds, p.currency)} expected proceeds`}
            />
          ) : (
            <Skeleton className="h-20" />
          )}
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-5 [&>*]:min-w-0">
        <Card className="xl:col-span-3">
          <CardHeader
            title={`Expected proceeds per ${interval}`}
            description={view === "withNew" ? "Renewals of today's subscriptions, new subscribers and one-time purchases; whisker: 90% band of the total" : "Renewals and trial conversions of today's subscriptions; whisker: 90% band"}
          />
          <div className="px-3 pb-5 sm:px-5">{!p ? <ChartSkeleton height={280} /> : <ProceedsChart p={p} pts={pts} view={view} interval={interval} />}</div>
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader title="MRR" description="At the end of each day (gross): today's subscriptions only, and with new subscribers; shaded: 90% band" />
          <div className="px-3 pb-5 sm:px-5">{!p ? <ChartSkeleton height={280} /> : <MrrChart p={p} pts={pts} view={view} interval={interval} />}</div>
        </Card>
      </div>

      {p && <Backtest p={p} />}
      {p && p.apps.length > 1 && <AppsTable p={p} view={view} />}
      {p && <Upcoming p={p} />}
      {p && <Segments p={p} />}
      {p && <Assumptions p={p} />}
    </>
  );
}

function ProceedsChart({ p, pts, view, interval }: { p: Projection; pts: ProjectionPoint[]; view: View; interval: Interval }) {
  const series: ChartSeries[] = [{ key: "renewals", label: "Renewals", color: "var(--viz-1)", values: pts.map((x) => x.renewals.expected) }];
  if (view === "withNew") {
    series.push({ key: "new", label: "New subscribers", color: "var(--viz-2)", values: pts.map((x) => x.newSubscribers) });
    series.push({ key: "oneTime", label: "One-time", color: "var(--viz-3)", values: pts.map((x) => x.oneTime) });
  }
  const band = view === "withNew" ? pts.map((x) => x.total) : pts.map((x) => x.renewals);
  return (
    <>
      <Legend className="mb-3 px-2" items={series.map((s) => ({ key: s.key, label: s.label, color: s.color }))} />
      <TimeChart
        dates={pts.map((x) => x.date)}
        interval={interval}
        height={280}
        series={series}
        showTotal={view === "withNew"}
        bands={[{ key: "band", label: "90% band", color: "var(--viz-ink-muted)", low: band.map((b) => b.low), high: band.map((b) => b.high) }]}
        formatValue={(v) => money(v, p.currency)}
        formatAxis={(v) => formatAxis(v, "money", p.currency)}
        label={`Expected proceeds per ${interval}`}
      />
    </>
  );
}

function MrrChart({ p, pts, view, interval }: { p: Projection; pts: ProjectionPoint[]; view: View; interval: Interval }) {
  const band = pts.map((x) => (view === "withNew" ? x.mrrWithNew : x.mrr));
  const series: ChartSeries[] = [
    { key: "withNew", label: "With new subscribers", color: "var(--viz-2)", values: pts.map((x) => x.mrrWithNew.expected), dashed: view !== "withNew" },
    { key: "existing", label: "Today's subscriptions", color: "var(--viz-1)", values: pts.map((x) => x.mrr.expected), dashed: view !== "existing" },
  ];
  return (
    <>
      <Legend className="mb-3 px-2" items={series.map((s) => ({ key: s.key, label: s.label, color: s.color, dashed: s.dashed }))} />
      <TimeChart
        dates={pts.map((x) => x.date)}
        interval={interval}
        type="line"
        height={280}
        series={series}
        bands={[{ key: "band", label: "90% band", color: view === "withNew" ? "var(--viz-2)" : "var(--viz-1)", low: band.map((b) => b.low), high: band.map((b) => b.high) }]}
        formatValue={(v) => money(v, p.currency)}
        formatAxis={(v) => formatAxis(v, "money", p.currency)}
        label="Projected MRR"
      />
    </>
  );
}

function Backtest({ p }: { p: Projection }) {
  if (!p.backtest.length) return null;
  const row = (label: string, b: Projection["backtest"][number]["withNew"]) => (
    <>
      <td className={cn(td, "text-right tabular-nums")}>
        {money(b.predicted.expected, p.currency)}
        <span className="block text-xs text-zinc-500">{bandText(b.predicted, p.currency)}</span>
      </td>
      <td className={cn(td, "text-right tabular-nums")}>{money(b.actual, p.currency)}</td>
      <td className={cn(td, "text-right tabular-nums", b.error !== null && Math.abs(b.error) > ROUGH && "text-amber-700 dark:text-amber-400")} title={label}>
        {b.error === null ? "—" : signedPercent(b.error)}
        <span className="ml-1.5 inline-block align-middle">{b.inBand ? <CheckCircle2 className="size-3.5 text-emerald-600" aria-label="inside the band" /> : <TriangleAlert className="size-3.5 text-amber-600" aria-label="outside the band" />}</span>
      </td>
    </>
  );
  return (
    <Card className="mt-5 overflow-hidden">
      <CardHeader title="Backtest" description="The same model run as of an earlier day, with only what was known then, against the proceeds that really came in since (refunds as known today)." />
      <Table>
        <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
          <tr>
            <th className={th}>Model run on</th>
            <th className={cn(th, "text-right")}>Days</th>
            <th className={cn(th, "text-right")}>Predicted, with new</th>
            <th className={cn(th, "text-right")}>Actual</th>
            <th className={cn(th, "text-right")}>Error</th>
            <th className={cn(th, "text-right")}>Predicted, existing</th>
            <th className={cn(th, "text-right")}>Actual</th>
            <th className={cn(th, "text-right")}>Error</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {p.backtest.map((b) => (
            <tr key={b.asOf}>
              <td className={td}>{b.asOf}</td>
              <td className={cn(td, "text-right tabular-nums")}>{b.days}</td>
              {row("With new subscribers", b.withNew)}
              {row("Existing subscriptions", b.existing)}
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function AppsTable({ p, view }: { p: Projection; view: View }) {
  return (
    <Card className="mt-5 overflow-hidden">
      <CardHeader title="Per app" description={view === "withNew" ? "Expected proceeds with new subscribers and one-time purchases" : "Expected proceeds of today's subscriptions"} />
      <Table>
        <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
          <tr>
            <th className={th}>App</th>
            <th className={cn(th, "text-right")}>MRR now</th>
            <th className={cn(th, "text-right")}>30 days</th>
            <th className={cn(th, "text-right")}>90 days</th>
            <th className={cn(th, "text-right")}>365 days</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {p.apps.slice(0, 25).map((a) => (
            <tr key={a.appId}>
              <td className={cn(td, "max-w-64 truncate text-sm font-medium")}>{a.name}</td>
              <td className={cn(td, "text-right tabular-nums")}>{money(a.mrrNow, p.currency)}</td>
              {(["d30", "d90", "d365"] as const).map((h) => (
                <td key={h} className={cn(td, "text-right tabular-nums")}>
                  {money(a.totals[h][view].expected, p.currency)}
                  <span className="block text-xs text-zinc-500">{bandText(a.totals[h][view], p.currency)}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function Upcoming({ p }: { p: Projection }) {
  const [all, setAll] = useState(false);
  if (!p.upcoming.items.length) return null;
  const shown = all ? p.upcoming.items : p.upcoming.items.slice(0, 15);
  return (
    <Card className="mt-5 overflow-hidden">
      <CardHeader title="Upcoming long renewals" description={`Subscriptions of 6 months or more renewing in the next 90 days (${p.upcoming.count}${p.upcoming.count > p.upcoming.items.length ? `, first ${p.upcoming.items.length} shown` : ""}). Trials: the first charge after the trial.`} />
      <Table>
        <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
          <tr>
            <th className={th}>Date</th>
            <th className={th}>App</th>
            <th className={th}>Product</th>
            <th className={th}>Kind</th>
            <th className={cn(th, "text-right")}>Price</th>
            <th className={cn(th, "text-right")}>P(renew)</th>
            <th className={cn(th, "text-right")}>Expected proceeds</th>
            <th className={th}>Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {shown.map((u, i) => (
            <tr key={`${u.date}:${i}`}>
              <td className={cn(td, "tabular-nums")}>{date(u.date)}</td>
              <td className={cn(td, "max-w-48 truncate text-sm")}>{u.appName ?? u.appId}</td>
              <td className={cn(td, "font-mono text-xs")}>{u.productId}</td>
              <td className={cn(td, "text-sm")}>
                {periodLabel(u.period)} · {STAGE_LABEL[u.stage] ?? u.stage}
              </td>
              <td className={cn(td, "text-right tabular-nums")}>{money(u.price, p.currency)}</td>
              <td className={cn(td, "text-right tabular-nums")}>{percent(u.probability, 0)}</td>
              <td className={cn(td, "text-right tabular-nums")}>{money(u.expectedProceeds, p.currency)}</td>
              <td className={td}>
                <Badge tone={u.status === "on" ? "green" : u.status === "off" ? "zinc" : "amber"}>{STATUS_LABEL[u.status] ?? u.status}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {p.upcoming.items.length > 15 && (
        <div className="border-t border-zinc-100 px-5 py-2.5 text-xs dark:border-zinc-800">
          <button type="button" className="font-medium text-brand-600 hover:underline dark:text-brand-400" onClick={() => setAll((x) => !x)}>
            {all ? "Show fewer" : `Show all ${p.upcoming.items.length}`}
          </button>
        </div>
      )}
    </Card>
  );
}

function Segments({ p }: { p: Projection }) {
  const [all, setAll] = useState(false);
  const order = ["trial", "intro", "r1", "r2", "r3"];
  const rows = [...p.segments].sort((a, b) => (a.appName ?? "").localeCompare(b.appName ?? "") || a.period.localeCompare(b.period) || order.indexOf(a.stage) - order.indexOf(b.stage));
  const shown = all ? rows : rows.slice(0, 20);
  const low = rows.filter((s) => s.lowData).length;
  return (
    <Card className="mt-5 overflow-hidden">
      <CardHeader
        title="Renewal rates used"
        description={`Per app, billing period and stage: periods that ended recently and how many paid again. ${low ? `${low} with fewer than 30 renewals lean on the portfolio (all apps) or a default, with a wide interval.` : ""}`}
      />
      <Table>
        <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
          <tr>
            <th className={th}>App</th>
            <th className={th}>Period</th>
            <th className={th}>Stage</th>
            <th className={cn(th, "text-right")}>Renewed</th>
            <th className={cn(th, "text-right")}>Observed</th>
            <th className={cn(th, "text-right")}>Rate used</th>
            <th className={th}>95% interval</th>
            <th className={th}>Source</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {shown.map((s) => (
            <tr key={`${s.appId}:${s.period}:${s.stage}`}>
              <td className={cn(td, "max-w-48 truncate text-sm")}>{s.appName ?? s.appId}</td>
              <td className={cn(td, "text-sm")}>{periodLabel(s.period)}</td>
              <td className={cn(td, "text-sm")}>{STAGE_LABEL[s.stage] ?? s.stage}</td>
              <td className={cn(td, "text-right tabular-nums")}>
                {s.renewed} <span className="text-xs text-zinc-500">of {s.observed}</span>
              </td>
              <td className={cn(td, "text-right tabular-nums")}>{s.observedRate === null ? "—" : percent(s.observedRate)}</td>
              <td className={cn(td, "text-right font-medium tabular-nums")}>{percent(s.rate)}</td>
              <td className={cn(td, "text-xs tabular-nums text-zinc-500")}>
                {percent(s.low, 0)} – {percent(s.high, 0)}
              </td>
              <td className={td}>{s.lowData ? <Badge tone="amber">Low data · {SOURCE_LABEL[s.source]}</Badge> : <span className="text-xs text-zinc-500">{SOURCE_LABEL[s.source]}</span>}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      {rows.length > 20 && (
        <div className="border-t border-zinc-100 px-5 py-2.5 text-xs dark:border-zinc-800">
          <button type="button" className="font-medium text-brand-600 hover:underline dark:text-brand-400" onClick={() => setAll((x) => !x)}>
            {all ? "Show fewer" : `Show all ${rows.length}`}
          </button>
        </div>
      )}
    </Card>
  );
}

function Assumptions({ p }: { p: Projection }) {
  const w = p.assumptions.weights;
  return (
    <Card className="mt-5">
      <CardHeader title="Inputs and assumptions" description={`Computed ${new Date(p.generatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC, once a day.`} />
      <div className="grid gap-5 px-5 pb-5 text-sm md:grid-cols-2">
        <ul className="space-y-1 text-zinc-600 dark:text-zinc-300">
          <li>
            {p.inputs.activeSubscriptions} active subscriptions: {p.inputs.trials} in trial, {p.inputs.autoRenewOff} with auto-renew off (next payment weight {percent(w.autoRenewOff, 0)}), {p.inputs.billingRetry} in billing retry ({percent(w.billingRetry, 0)}), {p.inputs.grace} in grace ({percent(w.grace, 0)}).
          </li>
          <li>
            New subscribers: {p.inputs.newStartsPerDay.toFixed(1)} starts a day; one-time purchases: {money(p.inputs.oneTimePerDay, p.currency)} a day (last 28 days).
          </li>
          <li>Prices: each product&rsquo;s full price in the buyer&rsquo;s currency at today&rsquo;s exchange rate.</li>
          {p.notes.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
        <Table className="text-xs">
          <thead>
            <tr>
              <th className={th}>App</th>
              <th className={cn(th, "text-right")}>Proceeds share, 1st year</th>
              <th className={cn(th, "text-right")}>After a year</th>
              <th className={cn(th, "text-right")}>Refunds</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {p.assumptions.proceedsShare.slice(0, 15).map((s) => (
              <tr key={s.appId}>
                <td className={cn(td, "max-w-48 truncate py-1.5")}>{s.appName ?? s.appId}</td>
                <td className={cn(td, "py-1.5 text-right tabular-nums")}>{percent(s.firstYear)}</td>
                <td className={cn(td, "py-1.5 text-right tabular-nums")} title={s.afterYearAssumed ? "Assumed: Apple's commission drops from 30% to 15% after a year of paid service" : "Measured"}>
                  {percent(s.afterYear)}
                  {s.afterYearAssumed && "*"}
                </td>
                <td className={cn(td, "py-1.5 text-right tabular-nums")}>{percent(p.assumptions.refundShare.find((r) => r.appId === s.appId)?.share ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </Card>
  );
}
