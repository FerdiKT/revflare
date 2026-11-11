import { Link } from "react-router";
import { AlertTriangle, ArrowRight, Award, CalendarCheck, Info, LifeBuoy, PartyPopper, Plus, Sparkles, Target, TrendingUp, XOctagon } from "lucide-react";
import type { Alert, Kpi, Overview } from "@shared/types";
import { ChartSkeleton, Legend, ProgressRing, Sparkline, TimeChart } from "../components/charts";
import { FilterBar } from "../components/FilterBar";
import { AppIcon } from "../components/Logo";
import { StoreGlyph } from "../components/Platform";
import { Badge, Card, CardHeader, Delta, EmptyState, ErrorState, PageHeader, Skeleton } from "../components/ui/Misc";
import { api } from "../lib/api";
import { useApps } from "../lib/apps";
import { useFilters, useGlobalSearch } from "../lib/filters";
import { ago, cn, dayLabel, formatAxis, formatValue, fullNumber, money, moneyCompact, monthLabel, percent } from "../lib/format";
import { useFetch, useNow } from "../lib/useFetch";
import { PACE, currentPeriodText, daysLeftText, goalValue, goalValueCompact, scopeText } from "../lib/goals";
import { AppWindow } from "lucide-react";

export function OverviewPage() {
  const { scope, apps: selected } = useFilters();
  const { apps, loading: appsLoading } = useApps();
  const key = selected.join(",");
  const ov = useFetch(`overview:${key}`, () => api.overview(scope), { refreshMs: 60_000, tags: ["metrics", "goals", "alerts"] });
  const now = useNow(15_000);

  if (!appsLoading && apps.length === 0) return <Onboarding />;
  const d = ov.data;

  return (
    <>
      <PageHeader
        title="Overview"
        description={d ? <span>Updated {ago(d.asOf, now)} · refreshes every minute</span> : "Your revenue at a glance"}
      />
      <FilterBar />
      {ov.error && <ErrorState error={ov.error} onRetry={ov.refetch} className="mb-6" />}
      <div className="grid gap-5 lg:grid-cols-3 [&>*]:min-w-0">
        <TodayCard d={d} />
        <div className="grid gap-5">
          <AtRiskCard d={d} />
          <ForecastCard d={d} />
        </div>
      </div>
      <KpiGrid kpis={d?.kpis} currency={d?.currency ?? "USD"} />
      <div className="mt-5 grid gap-5 lg:grid-cols-3 lg:items-start [&>*]:min-w-0">
        <MrrCard scopeKey={key} />
        <div className="grid gap-5">
          <GoalsCard d={d} />
          <RecordsCard d={d} />
        </div>
        <RevenueCard scopeKey={key} />
        <TopAppsCard d={d} />
        <MovementCard scopeKey={key} />
        <AlertsCard alerts={d?.alerts} />
      </div>
    </>
  );
}

function Onboarding() {
  return (
    <>
      <PageHeader title="Welcome to Revflare" description="Three steps and your revenue shows up here." />
      <Card>
        <EmptyState
          icon={<AppWindow />}
          title="Connect your apps"
          description={
            <ol className="mt-2 space-y-1.5 text-left">
              <li>
                1. Add an <strong>App Store Connect API key</strong> and an <strong>In-App Purchase key</strong> in Settings → Store credentials.
              </li>
              <li>2. Import your apps from App Store Connect (Apps page).</li>
              <li>3. Start the Apple backfill on the Imports page; live sales arrive through App Store Server Notifications.</li>
            </ol>
          }
          action={
            <>
              <Link to="/settings/credentials" className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand-600 px-3.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700 dark:bg-brand-500">
                Add credentials <ArrowRight className="size-4" />
              </Link>
              <Link to="/apps" className="inline-flex h-9 items-center gap-2 rounded-lg bg-white px-3.5 text-sm font-medium text-zinc-800 ring-1 ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-zinc-700">
                Go to Apps
              </Link>
            </>
          }
        />
      </Card>
    </>
  );
}

function TodayCard({ d }: { d: Overview | undefined }) {
  const record = d?.records.todayIsRecord;
  const t = d?.today;
  const diff = d && d.yesterday.revenue > 0 ? d.today.revenue / d.yesterday.revenue - 1 : null;
  return (
    <Card className={cn("relative overflow-hidden lg:col-span-2", record && "ring-2 ring-brand-400/70 dark:ring-brand-500/60")}>
      {record && <Celebration />}
      <div className={cn("relative flex h-full flex-col justify-between gap-4 p-6", record && "bg-gradient-to-br from-brand-50/90 via-white to-amber-50/80 dark:from-brand-950/50 dark:via-zinc-900 dark:to-amber-950/30")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:hidden" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
            Today
            {t && <span className="font-normal text-zinc-500 dark:text-zinc-400">· {dayLabel(t.date)} (UTC)</span>}
          </h2>
          {record && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-brand-500 to-amber-400 px-3 py-1 text-xs font-semibold text-white shadow-sm">
              <PartyPopper className="size-3.5" /> New record day!
            </span>
          )}
        </div>
        {!d || !t ? (
          <div className="mt-5 space-y-4">
            <Skeleton className="h-10 w-48" />
            <div className="grid grid-cols-3 gap-4 sm:grid-cols-5">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-1">
              <p className="text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">{money(t.revenue, d.currency)}</p>
              <p className="pb-1.5 text-sm text-zinc-500 dark:text-zinc-400">
                revenue · yesterday {money(d.yesterday.revenue, d.currency)} {diff !== null && <Delta change={diff} className="ml-1" />}
              </p>
            </div>
            <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-zinc-100 pt-5 sm:grid-cols-5 dark:border-zinc-800">
              <TodayStat label="Proceeds" value={money(t.proceeds, d.currency)} />
              <TodayStat label="Sales" value={fullNumber(t.sales)} />
              <TodayStat label="New subscriptions" value={fullNumber(t.newSubscriptions)} />
              <TodayStat label="Trials started" value={fullNumber(t.trialsStarted)} />
              <TodayStat label="Refunds" value={fullNumber(t.refunds)} warn={t.refunds > 0} />
            </dl>
          </>
        )}
      </div>
    </Card>
  );
}

function TodayStat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className={cn("mt-0.5 text-lg font-semibold tabular-nums", warn && "text-red-600 dark:text-red-400")}>{value}</dd>
    </div>
  );
}

const SPARKS = Array.from({ length: 18 }, (_, i) => {
  const angle = (i / 18) * Math.PI * 2;
  const dist = 90 + ((i * 53) % 70);
  return { dx: Math.cos(angle) * dist, dy: Math.sin(angle) * dist * 0.6, delay: (i % 6) * 0.25, color: ["#f95716", "#fbbf24", "#fb7a3c", "#f59e0b"][i % 4] };
});

function Celebration() {
  return (
    <div aria-hidden className="pointer-events-none absolute top-8 right-16">
      {SPARKS.map((s, i) => (
        <span key={i} className="spark" style={{ "--dx": `${s.dx}px`, "--dy": `${s.dy}px`, "--delay": `${s.delay}s`, background: s.color } as React.CSSProperties} />
      ))}
    </div>
  );
}

function AtRiskCard({ d }: { d: Overview | undefined }) {
  const search = useGlobalSearch();
  return (
    <Link to={`/at-risk${search}`} className="group block rounded-2xl focus-visible:outline-2">
      <Card className="h-full p-5 transition group-hover:ring-zinc-300 dark:group-hover:ring-zinc-700">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <LifeBuoy className="size-4 text-amber-500" /> Revenue at risk
          </p>
          <ArrowRight className="size-4 text-zinc-300 transition group-hover:translate-x-0.5 group-hover:text-zinc-500" />
        </div>
        {d ? (
          <>
            <p className="mt-3 text-2xl font-semibold tabular-nums">
              {money(d.atRisk.mrr, d.currency)}
              <span className="ml-1 text-sm font-normal text-zinc-500">MRR</span>
            </p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{fullNumber(d.atRisk.subscriptions)} subscriptions in billing retry, grace period or with auto-renew off</p>
          </>
        ) : (
          <Skeleton className="mt-3 h-12" />
        )}
      </Card>
    </Link>
  );
}

function ForecastCard({ d }: { d: Overview | undefined }) {
  const search = useGlobalSearch();
  return (
    <Link to={`/forecast${search}`} className="group block rounded-2xl focus-visible:outline-2">
      <Card className="h-full p-5 transition group-hover:ring-zinc-300 dark:group-hover:ring-zinc-700">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <TrendingUp className="size-4 text-sky-500" /> Next 30 days
          </p>
          <ArrowRight className="size-4 text-zinc-300 transition group-hover:translate-x-0.5 group-hover:text-zinc-500" />
        </div>
        {d ? (
          <>
            <p className="mt-3 text-2xl font-semibold tabular-nums">{money(d.forecast30, d.currency)}</p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Expected renewal revenue, from renewal rates per period</p>
          </>
        ) : (
          <Skeleton className="mt-3 h-12" />
        )}
      </Card>
    </Link>
  );
}

const INVERT = new Set(["churn_rate", "refund_rate", "refunds", "refunds_amount", "churned_subscriptions"]);

function KpiGrid({ kpis, currency }: { kpis: Kpi[] | undefined; currency: string }) {
  const search = useGlobalSearch();
  const sep = search ? "&" : "?";
  return (
    <div className="mt-5 grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4">
      {!kpis
        ? Array.from({ length: 8 }, (_, i) => (
            <Card key={i} className="p-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-3 h-7 w-28" />
              <Skeleton className="mt-3 h-9" />
            </Card>
          ))
        : kpis.map((k) => (
            <Link key={k.id} to={`/charts${search}${sep}metric=${k.metric}`} className="group rounded-2xl">
              <Card className="h-full p-4 transition group-hover:ring-zinc-300 sm:p-5 dark:group-hover:ring-zinc-700">
                <p className="truncate text-xs font-medium text-zinc-500 dark:text-zinc-400" title={k.label}>
                  {k.label}
                </p>
                <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-2">
                  <p className="text-lg font-semibold tracking-tight tabular-nums sm:text-2xl">{k.format === "money" && k.value >= 100_000 ? moneyCompact(k.value, currency) : formatValue(k.value, k.format, currency)}</p>
                  <Delta change={k.change} invert={INVERT.has(k.metric)} />
                </div>
                <Sparkline values={k.spark} className="mt-3" color={INVERT.has(k.metric) ? "var(--viz-2)" : "var(--viz-1)"} />
              </Card>
            </Link>
          ))}
    </div>
  );
}

function MrrCard({ scopeKey }: { scopeKey: string }) {
  const { scope } = useFilters();
  const c = useFetch(`ov-mrr:${scopeKey}`, () => api.chart("mrr", { apps: scope.apps, range: "12m", interval: "week" }), { tags: ["metrics"], refreshMs: 300_000 });
  const last = c.data?.points[c.data.points.length - 1]?.value;
  const first = c.data?.points.find((p) => p.value > 0)?.value;
  return (
    <Card className="lg:col-span-2">
      <CardHeader
        title="MRR"
        description="Last 12 months, weekly"
        action={
          c.data && last !== undefined ? (
            <div className="text-right">
              <p className="text-lg font-semibold tabular-nums">{money(last, c.data.currency)}</p>
              {first ? <Delta change={last / first - 1} /> : null}
            </div>
          ) : undefined
        }
      />
      <div className="px-3 pb-4 sm:px-5">
        {c.error ? (
          <ErrorState error={c.error} onRetry={c.refetch} />
        ) : !c.data ? (
          <ChartSkeleton height={220} />
        ) : (
          <TimeChart
            dates={c.data.points.map((p) => p.date)}
            interval="week"
            type="line"
            area
            height={220}
            series={[{ key: "mrr", label: "MRR", color: "var(--viz-1)", values: c.data.points.map((p) => p.value) }]}
            formatValue={(v) => money(v, c.data!.currency)}
            formatAxis={(v) => formatAxis(v, "money", c.data!.currency)}
            label="MRR over the last 12 months, weekly"
            importedUntil={c.data.importedUntil}
          />
        )}
      </div>
    </Card>
  );
}

function RevenueCard({ scopeKey }: { scopeKey: string }) {
  const { scope } = useFilters();
  const c = useFetch(`ov-rev:${scopeKey}`, () => api.chart("revenue", { apps: scope.apps, range: "90d", interval: "day" }), { tags: ["metrics"], refreshMs: 300_000 });
  return (
    <Card className="lg:col-span-2">
      <CardHeader
        title="Revenue"
        description="Last 90 days, daily"
        action={
          c.data ? (
            <div className="text-right">
              <p className="text-lg font-semibold tabular-nums">{money(c.data.total, c.data.currency)}</p>
              {c.data.previousTotal ? <Delta change={c.data.total / c.data.previousTotal - 1} /> : null}
            </div>
          ) : undefined
        }
      />
      <div className="px-3 pb-4 sm:px-5">
        {c.error ? (
          <ErrorState error={c.error} onRetry={c.refetch} />
        ) : !c.data ? (
          <ChartSkeleton height={220} />
        ) : (
          <TimeChart
            dates={c.data.points.map((p) => p.date)}
            interval="day"
            height={220}
            series={[{ key: "revenue", label: "Revenue", color: "var(--viz-1)", values: c.data.points.map((p) => p.value) }]}
            formatValue={(v) => money(v, c.data!.currency)}
            formatAxis={(v) => formatAxis(v, "money", c.data!.currency)}
            label="Daily revenue over the last 90 days"
            importedUntil={c.data.importedUntil}
          />
        )}
      </div>
    </Card>
  );
}

export const MOVEMENT_SERIES = [
  { key: "new", label: "New", color: "var(--viz-2)", sign: 1 },
  { key: "expansion", label: "Expansion", color: "var(--viz-3)", sign: 1 },
  { key: "reactivation", label: "Reactivation", color: "var(--viz-7)", sign: 1 },
  { key: "contraction", label: "Contraction", color: "var(--viz-4)", sign: -1 },
  { key: "churn", label: "Churn", color: "var(--viz-8)", sign: -1 },
] as const;

function MovementCard({ scopeKey }: { scopeKey: string }) {
  const { scope } = useFilters();
  const m = useFetch(`ov-mov:${scopeKey}`, () => api.mrrMovement({ apps: scope.apps, range: "12m", interval: "month" }), { tags: ["metrics"], refreshMs: 300_000 });
  const cur = m.data?.currency ?? "USD";
  return (
    <Card className="lg:col-span-2">
      <CardHeader title="MRR movement" description="Monthly: new, expansion and reactivation up; contraction and churn down; net as a line" />
      <div className="px-3 pb-4 sm:px-5">
        {m.error ? (
          <ErrorState error={m.error} onRetry={m.refetch} />
        ) : !m.data ? (
          <ChartSkeleton height={240} />
        ) : (
          <>
            <Legend
              className="mb-3 px-2"
              items={[...MOVEMENT_SERIES.map((s) => ({ key: s.key, label: s.label, color: s.color })), { key: "net", label: "Net", color: "var(--viz-ink)", line: true }]}
            />
            <TimeChart
              dates={m.data.points.map((p) => p.date)}
              interval="month"
              height={240}
              series={[
                ...MOVEMENT_SERIES.map((s) => ({ key: s.key, label: s.label, color: s.color, values: m.data!.points.map((p) => s.sign * Math.abs(p[s.key])) })),
                { key: "net", label: "Net", color: "var(--viz-ink)", values: m.data.points.map((p) => p.net), line: true },
              ]}
              formatValue={(v) => money(v, cur)}
              formatAxis={(v) => formatAxis(v, "money", cur)}
              label="Monthly MRR movement over the last 12 months"
            />
          </>
        )}
      </div>
    </Card>
  );
}

const GOALS_SHOWN = 4;

function GoalsCard({ d }: { d: Overview | undefined }) {
  const { byId } = useApps();
  const goals = d?.goals ?? [];
  const more = goals.length - GOALS_SHOWN;
  return (
    <Card>
      <CardHeader
        title="Goals"
        description={!d ? "Your targets" : goals.length === 0 ? "Targets for any period" : `${goals.length} active goal${goals.length === 1 ? "" : "s"}`}
        action={
          <Link to="/settings/goals" className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-400">
            Manage
          </Link>
        }
      />
      <div className="px-5 pb-5">
        {!d ? (
          <Skeleton className="h-32" />
        ) : goals.length === 0 ? (
          <div className="flex flex-col items-center py-6 text-center">
            <Target className="size-6 text-zinc-300 dark:text-zinc-600" />
            <p className="mt-2 text-sm text-zinc-500">Set a revenue, MRR, subscription, trial or sales target for a week, month, quarter, year or custom dates.</p>
            <Link to="/settings/goals" className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
              <Plus className="size-4" /> Add a goal
            </Link>
          </div>
        ) : (
          <>
            <ul className="space-y-4">
              {goals.slice(0, GOALS_SHOWN).map((g) => {
                const pace = PACE[g.pace];
                return (
                  <li key={g.id} className="flex items-center gap-3.5">
                    <ProgressRing progress={g.progress} size={56} stroke={6} label={`${g.label}: ${percent(g.progress, 0)} of the goal, ${pace.label.toLowerCase()}`}>
                      {g.progress >= 1 ? <Award className="size-5 text-amber-500" /> : <span className="text-[11px] font-semibold tabular-nums">{percent(g.progress, 0)}</span>}
                    </ProgressRing>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium" title={`${g.label} · ${scopeText(g, byId)}`}>
                          {g.label}
                        </p>
                        <Badge tone={pace.tone} className="shrink-0">
                          {pace.label}
                        </Badge>
                      </div>
                      <p className="text-sm tabular-nums">
                        <span className="font-semibold">{goalValue(g, g.current, d.currency)}</span>
                        <span className="text-zinc-500"> / {goalValue(g, g.target, d.currency)}</span>
                      </p>
                      <p className="truncate text-xs text-zinc-500">
                        {currentPeriodText(g)} · {daysLeftText(g)}
                        {g.kind === "flow" && g.status === "active" && g.pace !== "reached" && <> · on pace for {goalValueCompact(g, g.projected, d.currency)}</>}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
            {more > 0 && (
              <Link to="/settings/goals" className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline dark:text-brand-400">
                +{more} more · Manage <ArrowRight className="size-3.5" />
              </Link>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function RecordsCard({ d }: { d: Overview | undefined }) {
  return (
    <Card className="p-5">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <Sparkles className="size-4 text-amber-500" /> Records
      </p>
      {!d ? (
        <Skeleton className="mt-3 h-14" />
      ) : (
        <dl className="mt-3 grid grid-cols-2 gap-4">
          <div>
            <dt className="flex items-center gap-1 text-xs text-zinc-500">
              <CalendarCheck className="size-3.5" /> Best day
            </dt>
            <dd className="mt-0.5 font-semibold tabular-nums">{d.records.bestDay ? money(d.records.bestDay.revenue, d.currency) : "—"}</dd>
            {d.records.bestDay && <dd className="text-xs text-zinc-500">{dayLabel(d.records.bestDay.date)}</dd>}
          </div>
          <div>
            <dt className="flex items-center gap-1 text-xs text-zinc-500">
              <Award className="size-3.5" /> Best month
            </dt>
            <dd className="mt-0.5 font-semibold tabular-nums">{d.records.bestMonth ? money(d.records.bestMonth.revenue, d.currency) : "—"}</dd>
            {d.records.bestMonth && <dd className="text-xs text-zinc-500">{monthLabel(d.records.bestMonth.date)}</dd>}
          </div>
        </dl>
      )}
    </Card>
  );
}

function TopAppsCard({ d }: { d: Overview | undefined }) {
  return (
    <Card>
      <CardHeader
        title="Top apps"
        description="Revenue, last 28 days"
        action={
          <Link to="/apps" className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-400">
            All apps
          </Link>
        }
      />
      <ul className="px-2 pb-3">
        {!d
          ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="mx-3 my-2 h-8" />)
          : d.topApps.slice(0, 5).map((a) => (
              <li key={a.appId}>
                <Link to={`/apps/${a.appId}`} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                  <AppIcon name={a.name} url={a.iconUrl} size={30} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{a.name}</span>
                      {d.topApps.some((x) => x.platform === "android" || x.platform === "web") && <StoreGlyph platform={a.platform} className="size-3" />}
                    </span>
                    <span className="block text-xs text-zinc-500 tabular-nums">MRR {money(a.mrr, d.currency)}</span>
                  </span>
                  <span className="text-right">
                    <span className="block text-sm font-semibold tabular-nums">{money(a.revenue28d, d.currency)}</span>
                    <Delta change={a.change} />
                  </span>
                </Link>
              </li>
            ))}
        {d && d.topApps.length === 0 && <p className="px-3 py-4 text-sm text-zinc-500">No revenue in the last 28 days.</p>}
      </ul>
    </Card>
  );
}

export const SEVERITY = {
  critical: { icon: XOctagon, className: "text-[var(--viz-status-critical)]", label: "Critical" },
  warning: { icon: AlertTriangle, className: "text-[var(--viz-status-warning)]", label: "Warning" },
  info: { icon: Info, className: "text-sky-500", label: "Info" },
} as const;

function AlertsCard({ alerts }: { alerts: Alert[] | undefined }) {
  const open = alerts?.filter((a) => !a.resolvedAt) ?? [];
  return (
    <Card>
      <CardHeader
        title="Open alerts"
        action={
          <Link to="/alerts" className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-400">
            All alerts
          </Link>
        }
      />
      <div className="px-5 pb-5">
        {!alerts ? (
          <Skeleton className="h-20" />
        ) : open.length === 0 ? (
          <p className="flex gap-2.5 py-2 text-sm text-zinc-500">
            <span className="mt-1.5 size-2 shrink-0 rounded-full bg-[var(--viz-status-good)]" aria-hidden /> All clear. Revflare watches for silent notifications, failing syncs, revenue drops, refund spikes and funnel drops.
          </p>
        ) : (
          <ul className="space-y-3">
            {open.slice(0, 5).map((a) => {
              const s = SEVERITY[a.severity] ?? SEVERITY.info;
              return (
                <li key={a.id} className="flex gap-3">
                  <s.icon className={cn("mt-0.5 size-4 shrink-0", s.className)} aria-label={s.label} />
                  <div className="min-w-0">
                    {a.appId && a.funnelId ? (
                      <Link to={`/apps/${a.appId}/funnels/${a.funnelId}`} className="text-sm font-medium hover:underline">
                        {a.title}
                      </Link>
                    ) : a.appId && a.experimentId ? (
                      <Link to={`/apps/${a.appId}/experiments/${a.experimentId}`} className="text-sm font-medium hover:underline">
                        {a.title}
                      </Link>
                    ) : (
                      <p className="text-sm font-medium">{a.title}</p>
                    )}
                    <p className="line-clamp-2 text-xs text-zinc-500">{a.body}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
