import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Compass, DownloadCloud, Send } from "lucide-react";
import type { Acquisition, AcquisitionMetrics, AcquisitionRow, AcquisitionState, AcquisitionStatus, Interval } from "@shared/types";
import { ChartSkeleton, Legend, OTHER_COLOR, PALETTE, TimeChart } from "../components/charts";
import { FilterBar } from "../components/FilterBar";
import { AppIcon } from "../components/Logo";
import { AppleOnlyNotice } from "../components/Platform";
import { Button } from "../components/ui/Button";
import { Badge, Card, CardHeader, EmptyState, ErrorState, PageHeader, Segmented, Skeleton, Stat, Table, td, th, type Tone } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { api, ApiError } from "../lib/api";
import { useApps } from "../lib/apps";
import { addDays, useFilters } from "../lib/filters";
import { ago, cn, dateTime, dayLabel, formatAxis, fullNumber, money, percent, plural } from "../lib/format";
import { useSession } from "../lib/session";
import { invalidate, useFetch, useNow } from "../lib/useFetch";

type TableBy = "source" | "referrer" | "campaign";
type ChartMetric = "downloads" | "pageViews" | "impressions";

const TOP_SOURCES = 6;

const STATE: Record<AcquisitionState, { label: string; tone: Tone; help: string }> = {
  none: { label: "Not requested", tone: "zinc", help: "No App Analytics report request yet." },
  requested: { label: "Requested", tone: "amber", help: "Waiting for Apple's first reports (1–2 days)." },
  producing: { label: "Producing", tone: "green", help: "Apple produces reports; Revflare imports them every few hours." },
  stopped: { label: "Stopped", tone: "zinc", help: "Apple stopped the request after a long time without downloads; Revflare makes a new one." },
  failed: { label: "Failed", tone: "red", help: "The request failed: see the error." },
};

export function AcquisitionStateBadge({ state }: { state: AcquisitionState }) {
  const s = STATE[state] ?? { label: state, tone: "zinc" as Tone, help: "" };
  return (
    <Badge tone={s.tone} dot title={s.help}>
      {s.label}
    </Badge>
  );
}

const METRIC_LABEL: Record<ChartMetric, string> = { downloads: "First-time downloads", pageViews: "Product page views", impressions: "Impressions" };

function chartInterval(from: string, to: string): Interval {
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  return days > 400 ? "month" : days > 120 ? "week" : "day";
}

function bucket(day: string, interval: Interval): string {
  if (interval === "month") return day.slice(0, 7);
  if (interval === "week") {
    const d = new Date(`${day}T00:00:00Z`);
    return addDays(day, -((d.getUTCDay() + 6) % 7));
  }
  return day;
}

const sourceLabel = (s: string | undefined) => s || "Unknown";

export function AcquisitionPage() {
  const f = useFilters();
  const key = JSON.stringify(f.scope);
  const [tableBy, setTableBy] = useState<TableBy>("source");
  const [metric, setMetric] = useState<ChartMetric>("downloads");

  const totals = useFetch(`acq:source:${key}`, () => api.acquisition.get({ ...f.scope, by: ["source"] }), { tags: ["metrics"] });
  const daily = useFetch(`acq:day,source:${key}`, () => api.acquisition.get({ ...f.scope, by: ["day", "source"] }), { tags: ["metrics"] });
  const detail = useFetch(tableBy === "source" ? null : `acq:${tableBy}:${key}`, () => api.acquisition.get({ ...f.scope, by: [tableBy], limit: 500 }), { tags: ["metrics"] });
  const table = tableBy === "source" ? totals : detail;

  const d = totals.data;
  const empty = d && d.firstDay === null;
  const { byId } = useApps();
  const androidOnly = f.apps.length > 0 && f.apps.every((id) => byId.get(id)?.platform === "android");

  if (androidOnly)
    return (
      <>
        <PageHeader title="Acquisition" description="Where App Store visitors and downloads come from (Apple's App Analytics reports)." />
        <FilterBar range />
        <AppleOnlyNotice what="App Store acquisition reports" />
      </>
    );

  return (
    <>
      <PageHeader title="Acquisition" description="Where App Store visitors and downloads come from: impressions, product page views, downloads and proceeds by source, referrer and campaign (Apple's App Analytics reports)." />
      <FilterBar range />
      {totals.error && <ErrorState error={totals.error} onRetry={totals.refetch} className="mb-5" />}

      {!d && !totals.error ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-72" />
        </div>
      ) : empty ? (
        <>
          <Card>
            <EmptyState
              icon={<Compass />}
              title="No App Analytics reports yet"
              description={
                <>
                  <p>
                    Apple produces the first App Analytics reports <strong>1–2 days</strong> after Revflare requests them. Requesting needs an <strong>App Store Connect API key with the Admin role</strong>; reading
                    them later works with the Sales role. Revflare then imports new reports every few hours.
                  </p>
                  <p className="mt-2">
                    Campaign links such as <code className="font-mono text-xs break-all">https://apps.apple.com/app/id&lt;APPID&gt;?pt=&lt;provider token&gt;&amp;ct=&lt;campaign&gt;</code> show up under Campaign.
                  </p>
                </>
              }
            />
          </Card>
          <RequestStatus apps={f.apps} className="mt-5" />
        </>
      ) : d ? (
        <>
          <FunnelTiles d={d} />
          <DailyChart data={daily.data} error={daily.error} onRetry={daily.refetch} metric={metric} onMetric={setMetric} />

          <Card className="mt-5 overflow-hidden">
            <CardHeader
              title="Sources"
              description={
                tableBy === "source"
                  ? "Apple's source types (Standard reports: complete). Apple Ads taps count as App Store search."
                  : "From Apple's Detailed reports: rows with fewer than 5 users are left out and Apple adds a little noise, so they sum to less than the totals."
              }
              action={
                <Segmented
                  size="sm"
                  label="Group by"
                  value={tableBy}
                  onChange={setTableBy}
                  options={[
                    { value: "source", label: "Source type" },
                    { value: "referrer", label: "Referrer" },
                    { value: "campaign", label: "Campaign" },
                  ]}
                />
              }
            />
            {table.error && <ErrorState error={table.error} onRetry={table.refetch} className="mx-5 mb-5" />}
            {!table.data ? (
              !table.error && (
                <div className="space-y-2 px-5 pb-5">
                  {Array.from({ length: 5 }, (_, i) => (
                    <Skeleton key={i} className="h-10" />
                  ))}
                </div>
              )
            ) : (
              <SourceTable data={table.data} by={tableBy} />
            )}
          </Card>

          <RequestStatus apps={f.apps} compact className="mt-5" />
        </>
      ) : null}
    </>
  );
}

function FunnelTiles({ d }: { d: Acquisition }) {
  const t = d.totals;
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
      <Card className="p-5">
        <Stat label="Impressions" value={fullNumber(t.impressions)} sub={`${fullNumber(t.impressionsUnique)} unique`} />
      </Card>
      <Card className="p-5">
        <Stat
          label="Product page views"
          value={fullNumber(t.pageViews)}
          sub={`${fullNumber(t.pageViewsUnique)} unique${t.impressionsUnique ? ` · ${percent(t.pageViewsUnique / t.impressionsUnique)} of impressions` : ""}`}
        />
      </Card>
      <Card className="p-5">
        <Stat label="First-time downloads" value={fullNumber(t.downloads)} sub="New to the app" />
      </Card>
      <Card className="p-5">
        <Stat label="Conversion rate" value={t.conversionRate === null ? "—" : percent(t.conversionRate)} sub="Downloads / unique page views" />
      </Card>
      <Card className="p-5">
        <Stat label="Redownloads" value={fullNumber(t.redownloads)} sub="Downloaded before" />
      </Card>
      <Card className="p-5">
        <Stat label="App Store proceeds" value={money(t.proceeds, d.currency)} sub={`${fullNumber(t.purchases)} purchases · ${money(t.sales, d.currency)} sales`} />
      </Card>
    </div>
  );
}

function DailyChart({ data, error, onRetry, metric, onMetric }: { data?: Acquisition; error?: unknown; onRetry: () => void; metric: ChartMetric; onMetric: (m: ChartMetric) => void }) {
  const chart = useMemo(() => {
    if (!data || !data.rows.length) return null;
    // "All time" starts long before the first report: begin at the first day with data.
    const first = data.rows.reduce((m, x) => (x.day && x.day < m ? x.day : m), data.to);
    const start = data.from < first ? first : data.from;
    const interval = chartInterval(start, data.to);
    const dates: string[] = [];
    for (let day = start; day <= data.to; day = addDays(day, 1)) {
      const b = bucket(day, interval);
      if (dates[dates.length - 1] !== b) dates.push(b);
    }
    const index = new Map(dates.map((x, i) => [x, i]));
    const bySource = new Map<string, number>();
    for (const r of data.rows) bySource.set(sourceLabel(r.sourceType), (bySource.get(sourceLabel(r.sourceType)) ?? 0) + r[metric]);
    const ranked = [...bySource.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    // Keep the top sources; fold the rest into "Other" (not worth a slot for a single extra source).
    const top = ranked.length <= TOP_SOURCES + 1 ? ranked : ranked.slice(0, TOP_SOURCES);
    const topSet = new Set(top.map(([s]) => s));
    const values = new Map<string, number[]>([...top.map(([s]) => [s, dates.map(() => 0)] as const), ["\u0000other", dates.map(() => 0)]]);
    for (const r of data.rows) {
      const i = r.day ? index.get(bucket(r.day, interval)) : undefined;
      if (i === undefined) continue;
      const s = sourceLabel(r.sourceType);
      values.get(topSet.has(s) ? s : "\u0000other")![i] += r[metric];
    }
    const series = top.map(([s], i) => ({ key: s, label: s, color: PALETTE[i % PALETTE.length], values: values.get(s)! }));
    const other = values.get("\u0000other")!;
    if (other.some((v) => v)) series.push({ key: "\u0000other", label: "Other", color: OTHER_COLOR, values: other });
    return { dates, interval, series };
  }, [data, metric]);

  return (
    <Card className="mt-5">
      <CardHeader
        title={METRIC_LABEL[metric]}
        description={`Per ${chart?.interval ?? "day"}, by source type.`}
        action={
          <Segmented
            size="sm"
            label="Chart metric"
            value={metric}
            onChange={onMetric}
            options={[
              { value: "downloads", label: "Downloads" },
              { value: "pageViews", label: "Page views" },
              { value: "impressions", label: "Impressions" },
            ]}
          />
        }
      />
      <div className="px-3 pb-5 sm:px-5">
        {error ? (
          <ErrorState error={error} onRetry={onRetry} />
        ) : !data ? (
          <ChartSkeleton height={260} />
        ) : !chart || !chart.series.length ? (
          <p className="px-2 py-16 text-center text-sm text-zinc-500">No App Store activity in this range.</p>
        ) : (
          <>
            <Legend className="mb-3 px-2" items={chart.series.map((s) => ({ key: s.key, label: s.label, color: s.color }))} />
            <TimeChart
              dates={chart.dates}
              interval={chart.interval}
              series={chart.series}
              height={260}
              showTotal
              formatValue={(v) => fullNumber(v)}
              formatAxis={(v) => formatAxis(v, "count", data.currency)}
              label={`${METRIC_LABEL[metric]} per ${chart.interval}, stacked by App Store source type`}
            />
          </>
        )}
      </div>
    </Card>
  );
}

function rowLabel(r: AcquisitionRow, by: TableBy): string {
  if (by === "source") return sourceLabel(r.sourceType);
  return (by === "referrer" ? r.referrer : r.campaign) ?? "";
}

function SourceTable({ data, by }: { data: Acquisition; by: TableBy }) {
  const rows = useMemo(() => [...data.rows].sort((a, b) => b.downloads - a.downloads || b.pageViews - a.pageViews || b.impressions - a.impressions), [data]);
  const head = by === "source" ? "Source type" : by === "referrer" ? "Referrer" : "Campaign";
  if (!rows.length) return <p className="px-5 pb-8 text-center text-sm text-zinc-500">No rows in this range{by === "source" ? "" : " (Apple leaves out rows with fewer than 5 users)"}.</p>;
  return (
    <Table>
      <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
        <tr>
          <th className={th}>{head}</th>
          {by !== "source" && <th className={th}>Source type</th>}
          <th className={cn(th, "text-right")}>Impressions</th>
          <th className={cn(th, "text-right")}>Page views</th>
          <th className={cn(th, "text-right")}>Downloads</th>
          <th className={cn(th, "text-right")}>Redownloads</th>
          <th className={cn(th, "text-right")}>Conversion</th>
          <th className={cn(th, "text-right")}>Purchases</th>
          <th className={cn(th, "text-right")}>Proceeds</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {rows.map((r, i) => {
          const label = rowLabel(r, by);
          return (
            <tr key={`${label}:${r.sourceType ?? ""}:${i}`}>
              <td className={cn(td, "max-w-80 truncate")} title={label || undefined}>
                {label ? <span className={cn(by !== "source" && "font-mono text-[13px]")}>{label}</span> : <span className="text-zinc-500 italic dark:text-zinc-400">(none)</span>}
              </td>
              {by !== "source" && <td className={cn(td, "text-zinc-600 dark:text-zinc-300")}>{r.sourceType === undefined ? "—" : sourceLabel(r.sourceType)}</td>}
              <Cells m={r} currency={data.currency} />
            </tr>
          );
        })}
      </tbody>
      <tfoot className="border-t border-zinc-200 bg-zinc-50/60 font-semibold dark:border-zinc-700 dark:bg-zinc-800/30">
        <tr>
          <td className={td} colSpan={by === "source" ? 1 : 2}>
            Total
          </td>
          <Cells m={data.totals} currency={data.currency} />
        </tr>
      </tfoot>
    </Table>
  );
}

function Cells({ m, currency }: { m: AcquisitionMetrics; currency: string }) {
  const num = cn(td, "text-right tabular-nums");
  return (
    <>
      <td className={num}>{fullNumber(m.impressions)}</td>
      <td className={num}>{fullNumber(m.pageViews)}</td>
      <td className={cn(num, "font-medium")}>{fullNumber(m.downloads)}</td>
      <td className={num}>{fullNumber(m.redownloads)}</td>
      <td className={num}>{m.conversionRate === null ? "—" : percent(m.conversionRate)}</td>
      <td className={num}>{fullNumber(m.purchases)}</td>
      <td className={num}>{money(m.proceeds, currency)}</td>
    </>
  );
}

/** Per-app App Analytics report requests, with "Request reports" / "Import now" for managers. */
function RequestStatus({ apps, compact, className }: { apps: string[]; compact?: boolean; className?: string }) {
  const { can } = useSession();
  const manage = can("manage");
  const toast = useToast();
  const now = useNow(30_000);
  const { byId } = useApps();
  const r = useFetch(`acq:status:${apps.join()}`, () => api.acquisition.status({ apps }), { tags: ["metrics"] });
  const [busy, setBusy] = useState<"request" | "import" | null>(null);
  const items = r.data?.items ?? [];

  const request = async () => {
    setBusy("request");
    const created: string[] = [];
    const existing: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    try {
      for (let i = 0; i < 10; i++) {
        const res = await api.acquisition.request(apps.length ? { appIds: apps } : {});
        created.push(...res.created.map((x) => x.name));
        existing.push(...res.existing.map((x) => x.name));
        failed.push(...res.failed);
        if (res.remaining <= 0) break;
      }
      const parts = [created.length && plural(created.length, "new request"), existing.length && `${fullNumber(existing.length)} already requested`, failed.length && `${fullNumber(failed.length)} failed`].filter(Boolean);
      const summary = parts.join(" · ") || "No apps to request";
      if (failed.length) toast.error(created.length || existing.length ? "Some report requests failed" : "Report requests failed", `${summary}. ${failed[0].name}: ${failed[0].error}`);
      else toast.success(created.length ? "App Analytics reports requested" : "Reports already requested", `${summary}. Apple produces the first reports within 1–2 days.`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
      invalidate("metrics");
    }
  };

  const importNow = async () => {
    setBusy("import");
    try {
      const res = await api.imports.acquisition();
      toast.success(res.reused ? "Acquisition import is already running" : "Acquisition import started", "Follow it on the Imports page.");
      invalidate("jobs");
    } catch (err) {
      if (err instanceof ApiError && err.code === "budget") toast.error("Import not started", err.message);
      else toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  const counts = useMemo(() => {
    const c = new Map<AcquisitionState, number>();
    for (const s of items) c.set(s.state, (c.get(s.state) ?? 0) + 1);
    return [...c.entries()];
  }, [items]);

  const actions = manage && (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" icon={<Send className="size-4" />} loading={busy === "request"} disabled={!!busy} onClick={request}>
        Request reports
      </Button>
      <Button size="sm" icon={<DownloadCloud className="size-4" />} loading={busy === "import"} disabled={!!busy} onClick={importNow}>
        Import now
      </Button>
      <Link to="/imports" className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
        Imports →
      </Link>
    </div>
  );

  const list = (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {items.map((s) => (
        <StatusRow key={s.appId} s={s} app={byId.get(s.appId)} now={now} />
      ))}
    </ul>
  );

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader
        title="Report requests"
        description={
          compact ? (
            counts.length ? (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                {counts.map(([state, n]) => (
                  <span key={state} className="inline-flex items-center gap-1">
                    <AcquisitionStateBadge state={state} /> <span className="tabular-nums">{fullNumber(n)}</span>
                  </span>
                ))}
              </span>
            ) : undefined
          ) : (
            "Per app: Revflare asks Apple for ongoing App Analytics reports, then imports them every few hours."
          )
        }
        action={actions}
      />
      {r.error && <ErrorState error={r.error} onRetry={r.refetch} className="mx-5 mb-5" />}
      {!r.data ? (
        !r.error && (
          <div className="space-y-2 px-5 pb-5">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        )
      ) : items.length === 0 ? (
        <p className="px-5 pb-6 text-sm text-zinc-500">No apps with an App Store id yet. Import your apps from App Store Connect first.</p>
      ) : compact ? (
        <details className="group border-t border-zinc-100 dark:border-zinc-800">
          <summary className="cursor-pointer px-5 py-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/40">Show {plural(items.length, "app")}</summary>
          {list}
        </details>
      ) : (
        <div className="border-t border-zinc-100 dark:border-zinc-800">{list}</div>
      )}
    </Card>
  );
}

function StatusRow({ s, app, now }: { s: AcquisitionStatus; app?: { name: string; iconUrl: string | null }; now: number }) {
  return (
    <li className="flex flex-wrap items-start gap-3 px-5 py-3">
      <AppIcon name={app?.name ?? "?"} url={app?.iconUrl} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{app?.name ?? "Unknown app"}</span>
          <AcquisitionStateBadge state={s.state} />
        </div>
        <p className="mt-0.5 text-xs text-zinc-500">
          {s.lastDay ? `Data ${dayLabel(s.firstDay ?? s.lastDay)} → ${dayLabel(s.lastDay)}` : "No data imported yet"}
          {s.requestedAt && (
            <span title={dateTime(s.requestedAt)}>
              {" "}
              · requested {ago(s.requestedAt, now)}
            </span>
          )}
          {s.checkedAt && (
            <span title={dateTime(s.checkedAt)}>
              {" "}
              · checked {ago(s.checkedAt, now)}
            </span>
          )}
        </p>
        {s.error && <p className="mt-1 text-xs break-words text-red-600 dark:text-red-400">{s.error}</p>}
      </div>
    </li>
  );
}
