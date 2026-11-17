import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ArrowDownToLine, DownloadCloud } from "lucide-react";
import type { DownloadApp, DownloadCounts, Downloads, DownloadWindow, Interval } from "@shared/types";
import { ChartSkeleton, InlineBar, Legend, PALETTE, TimeChart } from "../components/charts";
import { FilterBar } from "../components/FilterBar";
import { AppIcon } from "../components/Logo";
import { AppleOnlyNotice } from "../components/Platform";
import { Button } from "../components/ui/Button";
import { Card, CardHeader, EmptyState, ErrorState, PageHeader, Segmented, Skeleton, Stat, Table, td, th } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { useApps } from "../lib/apps";
import { addDays, useFilters } from "../lib/filters";
import { cn, countryLabel, dayLabel, formatAxis, fullNumber, money, percent, signedPercent } from "../lib/format";
import { useSession } from "../lib/session";
import { invalidate, useFetch } from "../lib/useFetch";

type ChartMode = "type" | "conversion";
type AppSort = "downloads" | "change" | "rpd";

const KIND_SERIES: Array<{ key: keyof DownloadCounts | "free"; label: string; color: string }> = [
  { key: "free", label: "First downloads (free)", color: PALETTE[0] },
  { key: "paidDownloads", label: "First downloads (paid)", color: PALETTE[1] },
  { key: "redownloads", label: "Redownloads", color: PALETTE[2] },
  { key: "updates", label: "Updates", color: PALETTE[3] },
];

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

const change = (cur: number, prev: number) => (prev > 0 ? cur / prev - 1 : null);

function Change({ value, className }: { value: number | null; className?: string }) {
  if (value === null) return <span className={cn("text-zinc-400", className)}>—</span>;
  return <span className={cn("tabular-nums", value > 0 ? "text-emerald-600 dark:text-emerald-400" : value < 0 ? "text-red-600 dark:text-red-400" : "text-zinc-500", className)}>{signedPercent(value)}</span>;
}

const pct = (v: number | null, digits = 1) => (v === null ? "—" : percent(v, digits));

export function DownloadsPage() {
  const f = useFilters();
  const key = JSON.stringify(f.scope);
  const r = useFetch(`downloads:${key}`, () => api.downloads.get(f.scope), { tags: ["metrics"] });
  const { byId } = useApps();
  const d = r.data;
  const androidOnly = f.apps.length > 0 && f.apps.every((id) => byId.get(id)?.platform !== "ios" && byId.get(id)?.platform !== undefined);

  const header = (
    <PageHeader
      title="Downloads"
      description="App Store downloads from Apple's Sales and Trends reports: first downloads (free and paid), redownloads and updates by app, country and device, and what they turned into. Report days are Pacific time and arrive about a day late."
    />
  );
  if (androidOnly)
    return (
      <>
        {header}
        <FilterBar range />
        <AppleOnlyNotice what="App Store downloads" />
      </>
    );

  return (
    <>
      {header}
      <FilterBar range />
      {r.error && <ErrorState error={r.error} onRetry={r.refetch} className="mb-5" />}
      {!d && !r.error ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-72" />
        </div>
      ) : d && d.firstDay === null ? (
        <Card>
          <EmptyState
            icon={<ArrowDownToLine />}
            title="No App Store downloads yet"
            description={
              <p>
                Revflare reads downloads from Apple's <strong>Sales and Trends</strong> daily reports with an App Store Connect API key that has the <strong>Sales</strong> (or Finance / Admin) role and your
                vendor number. Import the last 90 days to start; new days arrive every morning.
              </p>
            }
            action={<SyncButton />}
          />
        </Card>
      ) : d ? (
        <>
          <Tiles d={d} />
          <DailyChart d={d} />
          <AppsTable d={d} />
          <div className="mt-5 grid gap-5 lg:grid-cols-3">
            <CountriesCard d={d} className="lg:col-span-2" />
            <div className="space-y-5">
              <DevicesCard d={d} />
              <TypesCard d={d} />
            </div>
          </div>
          <p className="mt-5 text-xs text-zinc-500">
            Reports {dayLabel(d.firstDay ?? d.from)} → {dayLabel(d.lastDay ?? d.to)}. Conversions use Revflare's own sales on UTC days (iOS apps); Apple Ads counts RevflareKit's attributed first installs, as a
            share of the downloads of apps with RevflareKit installs. Where visitors come from: <Link to="/acquisition" className="font-medium text-brand-700 hover:underline dark:text-brand-400">Acquisition</Link>.{" "}
            <SyncButton inline />
          </p>
        </>
      ) : null}
    </>
  );
}

function SyncButton({ inline }: { inline?: boolean }) {
  const { can } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!can("manage")) return null;
  const run = async () => {
    setBusy(true);
    try {
      const res = await api.downloads.sync(90);
      toast.success(res.reused ? "The import is already running" : "Import started", "Missing Sales and Trends days of the last 90 days. Follow it on the Imports page.");
      invalidate("jobs");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  if (inline)
    return (
      <button type="button" onClick={run} disabled={busy} className="font-medium text-brand-700 hover:underline disabled:opacity-50 dark:text-brand-400">
        {busy ? "Starting…" : "Import missing days"}
      </button>
    );
  return (
    <Button icon={<DownloadCloud className="size-4" />} loading={busy} onClick={run}>
      Import the last 90 days
    </Button>
  );
}

function WindowStat({ w }: { w: DownloadWindow }) {
  return (
    <Card className="p-5">
      <Stat
        label={`Last ${w.days} days`}
        value={fullNumber(w.downloads)}
        sub={
          <>
            <Change value={w.change} /> vs the {w.days} days before ({fullNumber(w.previous)})
          </>
        }
      />
    </Card>
  );
}

function Tiles({ d }: { d: Downloads }) {
  const t = d.totals;
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {d.windows.map((w) => (
          <WindowStat key={w.days} w={w} />
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
        <Card className="p-5">
          <Stat
            label="First downloads"
            value={fullNumber(t.downloads)}
            sub={
              <>
                <Change value={change(t.downloads, d.previous.downloads)} /> · {fullNumber(t.paidDownloads)} paid
              </>
            }
          />
        </Card>
        <Card className="p-5">
          <Stat label="Redownloads" value={fullNumber(t.redownloads)} sub={<Change value={change(t.redownloads, d.previous.redownloads)} />} />
        </Card>
        <Card className="p-5">
          <Stat label="Updates" value={fullNumber(t.updates)} sub={<Change value={change(t.updates, d.previous.updates)} />} />
        </Card>
        <Card className="p-5">
          <Stat label="Download → trial" value={pct(t.downloadToTrial)} sub={`${fullNumber(t.trialsStarted)} trials started`} />
        </Card>
        <Card className="p-5">
          <Stat label="Download → paid" value={pct(t.downloadToPaid, 2)} sub={`${fullNumber(t.newPayers)} new payers`} />
        </Card>
        <Card className="p-5">
          <Stat label="Revenue per download" value={t.revenuePerDownload === null ? "—" : money(t.revenuePerDownload, d.currency, { cents: true })} sub={`${money(t.revenue, d.currency)} revenue`} />
        </Card>
        <Card className="p-5">
          <Stat
            label="Apple Ads share"
            value={pct(t.appleAdsShare)}
            sub={t.appleAdsShare === null ? "No RevflareKit installs" : `${fullNumber(t.appleAdsDownloads)} installs · organic ${pct(1 - t.appleAdsShare)}`}
          />
        </Card>
      </div>
    </>
  );
}

function DailyChart({ d }: { d: Downloads }) {
  const [mode, setMode] = useState<ChartMode>("type");
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(["updates"]));
  const chart = useMemo(() => {
    const interval = chartInterval(d.from, d.to);
    const dates: string[] = [];
    const rows = new Map<string, { free: number; paidDownloads: number; redownloads: number; updates: number; downloads: number; trials: number; payers: number; revenue: number }>();
    for (const x of d.days) {
      const b = bucket(x.day, interval);
      if (dates[dates.length - 1] !== b) dates.push(b);
      const r = rows.get(b) ?? { free: 0, paidDownloads: 0, redownloads: 0, updates: 0, downloads: 0, trials: 0, payers: 0, revenue: 0 };
      r.free += x.downloads - x.paidDownloads;
      r.paidDownloads += x.paidDownloads;
      r.redownloads += x.redownloads;
      r.updates += x.updates;
      r.downloads += x.downloads;
      r.trials += x.trialsStarted;
      r.payers += x.newPayers;
      r.revenue += x.revenue;
      rows.set(b, r);
    }
    const values = (fn: (r: NonNullable<ReturnType<typeof rows.get>>) => number) => dates.map((b) => fn(rows.get(b)!));
    const types = KIND_SERIES.filter((s) => s.key !== "paidDownloads" || d.totals.paidDownloads > 0).map((s) => ({ ...s, values: values((r) => r[s.key as keyof typeof r]) }));
    const conv = [
      { key: "trial", label: "Download → trial", color: PALETTE[0], values: values((r) => (r.downloads ? r.trials / r.downloads : 0)) },
      { key: "paid", label: "Download → paid", color: PALETTE[1], values: values((r) => (r.downloads ? r.payers / r.downloads : 0)) },
    ];
    return { interval, dates, types, conv };
  }, [d]);
  const series = mode === "type" ? chart.types.filter((s) => !hidden.has(s.key)) : chart.conv;
  const toggle = (k: string) => setHidden((h) => (h.has(k) ? new Set([...h].filter((x) => x !== k)) : new Set([...h, k])));
  return (
    <Card className="mt-5">
      <CardHeader
        title={mode === "type" ? "Downloads" : "Conversion"}
        description={mode === "type" ? `Per ${chart.interval}, by kind (Apple report days).` : `Trials started and first payments per first download, per ${chart.interval}.`}
        action={
          <Segmented
            size="sm"
            label="Chart"
            value={mode}
            onChange={setMode}
            options={[
              { value: "type", label: "By kind" },
              { value: "conversion", label: "Conversion" },
            ]}
          />
        }
      />
      <div className="px-3 pb-5 sm:px-5">
        {!d.days.length ? (
          <ChartSkeleton height={260} />
        ) : (
          <>
            <Legend
              className="mb-3 px-2"
              items={(mode === "type" ? chart.types : chart.conv).map((s) => ({ key: s.key, label: s.label, color: s.color, line: mode === "conversion" }))}
              hidden={mode === "type" ? hidden : undefined}
              onToggle={mode === "type" ? toggle : undefined}
            />
            <TimeChart
              dates={chart.dates}
              interval={chart.interval}
              series={series}
              type={mode === "type" ? "bar" : "line"}
              height={260}
              showTotal={mode === "type"}
              formatValue={(v) => (mode === "type" ? fullNumber(v) : percent(v, 1))}
              formatAxis={(v) => (mode === "type" ? formatAxis(v, "count", d.currency) : percent(v, 0))}
              label={mode === "type" ? `Downloads per ${chart.interval} by kind` : `Download to trial and paid conversion per ${chart.interval}`}
            />
          </>
        )}
      </div>
    </Card>
  );
}

function AppsTable({ d }: { d: Downloads }) {
  const { byId } = useApps();
  const [sort, setSort] = useState<AppSort>("downloads");
  const rows = useMemo(() => {
    const list = [...d.apps];
    if (sort === "change") list.sort((a, b) => (change(b.downloads, b.previousDownloads) ?? -Infinity) - (change(a.downloads, a.previousDownloads) ?? -Infinity));
    else if (sort === "rpd") list.sort((a, b) => (b.revenuePerDownload ?? -1) - (a.revenuePerDownload ?? -1));
    return list;
  }, [d, sort]);
  const max = Math.max(1, ...d.apps.map((a) => a.downloads));
  const num = cn(td, "text-right tabular-nums");
  const win = (a: DownloadApp, n: number) => a.windows.find((w) => w.days === n);
  return (
    <Card className="mt-5 overflow-hidden">
      <CardHeader
        title="Apps"
        description="First downloads in the range with the change vs the previous period, rolling 7 / 28 / 90-day windows (vs the windows before) and conversions. Gray: apps not in Revflare."
        action={
          <Segmented
            size="sm"
            label="Sort"
            value={sort}
            onChange={setSort}
            options={[
              { value: "downloads", label: "Downloads" },
              { value: "change", label: "Change" },
              { value: "rpd", label: "RPD" },
            ]}
          />
        }
      />
      {!rows.length ? (
        <p className="px-5 pb-8 text-center text-sm text-zinc-500">No downloads in this range.</p>
      ) : (
        <Table>
          <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
            <tr>
              <th className={th}>App</th>
              <th className={cn(th, "text-right")}>First downloads</th>
              <th className={cn(th, "text-right")}>vs prev.</th>
              <th className={cn(th, "text-right")}>7d</th>
              <th className={cn(th, "text-right")}>28d</th>
              <th className={cn(th, "text-right")}>90d</th>
              <th className={cn(th, "text-right")}>Paid</th>
              <th className={cn(th, "text-right")}>Redownloads</th>
              <th className={cn(th, "text-right")}>Updates</th>
              <th className={cn(th, "text-right")}>→ Trial</th>
              <th className={cn(th, "text-right")}>→ Paid</th>
              <th className={cn(th, "text-right")}>RPD</th>
              <th className={cn(th, "text-right")}>Apple Ads</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.map((a) => {
              const app = a.appId ? byId.get(a.appId) : undefined;
              const own = !!a.appId;
              return (
                <tr key={a.appId ?? a.appleId} className={cn(!own && "text-zinc-500 dark:text-zinc-400")}>
                  <td className={cn(td, "max-w-72")}>
                    <div className="flex items-center gap-2.5">
                      <AppIcon name={a.name} url={app?.iconUrl} size={24} />
                      {own ? (
                        <Link to={`/apps/${a.appId}`} className="truncate font-medium hover:underline">
                          {a.name}
                        </Link>
                      ) : (
                        <span className="truncate" title={`Apple ID ${a.appleId}: not in Revflare`}>
                          {a.name}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={num}>
                    <div className="flex items-center justify-end gap-2">
                      <div className="hidden w-16 sm:block">
                        <InlineBar value={a.downloads} max={max} />
                      </div>
                      <span className="font-medium">{fullNumber(a.downloads)}</span>
                    </div>
                  </td>
                  <td className={num}>
                    <Change value={change(a.downloads, a.previousDownloads)} />
                  </td>
                  {[7, 28, 90].map((n) => {
                    const w = win(a, n);
                    return (
                      <td key={n} className={num} title={w ? `${fullNumber(w.downloads)} vs ${fullNumber(w.previous)} the ${n} days before` : undefined}>
                        {w ? fullNumber(w.downloads) : "—"} {w && <Change value={w.change} className="text-xs" />}
                      </td>
                    );
                  })}
                  <td className={num}>{fullNumber(a.paidDownloads)}</td>
                  <td className={num}>{fullNumber(a.redownloads)}</td>
                  <td className={num}>{fullNumber(a.updates)}</td>
                  <td className={num}>{own ? pct(a.downloadToTrial) : "—"}</td>
                  <td className={num}>{own ? pct(a.downloadToPaid, 2) : "—"}</td>
                  <td className={num}>{own && a.revenuePerDownload !== null ? money(a.revenuePerDownload, d.currency, { cents: true }) : "—"}</td>
                  <td className={num}>{a.appleAdsShare === null ? "—" : `${fullNumber(a.appleAdsDownloads)} · ${percent(a.appleAdsShare, 0)}`}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

const TOP_COUNTRIES = 12;

function CountriesCard({ d, className }: { d: Downloads; className?: string }) {
  const [all, setAll] = useState(false);
  const total = Math.max(1, d.totals.downloads);
  const top = d.countries.slice(0, TOP_COUNTRIES);
  const max = Math.max(1, ...top.map((c) => c.downloads));
  const rows = all ? d.countries : d.countries.slice(0, 25);
  const num = cn(td, "text-right tabular-nums");
  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader title="Countries" description={`${fullNumber(d.countries.length)} countries with downloads, redownloads or updates in the range.`} />
      <div className="space-y-2 px-5 pb-5">
        {top.map((c) => (
          <div key={c.country} className="grid grid-cols-[9rem_1fr_4.5rem] items-center gap-3 text-sm">
            <span className="truncate">{countryLabel(c.country)}</span>
            <InlineBar value={c.downloads} max={max} color={PALETTE[0]} />
            <span className="text-right tabular-nums">
              {fullNumber(c.downloads)} <span className="text-xs text-zinc-500">{percent(c.downloads / total, 0)}</span>
            </span>
          </div>
        ))}
      </div>
      <details className="border-t border-zinc-100 dark:border-zinc-800">
        <summary className="cursor-pointer px-5 py-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/40">Table of all countries</summary>
        <Table>
          <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
            <tr>
              <th className={th}>Country</th>
              <th className={cn(th, "text-right")}>First downloads</th>
              <th className={cn(th, "text-right")}>Share</th>
              <th className={cn(th, "text-right")}>Paid</th>
              <th className={cn(th, "text-right")}>Redownloads</th>
              <th className={cn(th, "text-right")}>Updates</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.map((c) => (
              <tr key={c.country}>
                <td className={td}>{countryLabel(c.country)}</td>
                <td className={cn(num, "font-medium")}>{fullNumber(c.downloads)}</td>
                <td className={num}>{percent(c.downloads / total, 1)}</td>
                <td className={num}>{fullNumber(c.paidDownloads)}</td>
                <td className={num}>{fullNumber(c.redownloads)}</td>
                <td className={num}>{fullNumber(c.updates)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        {!all && d.countries.length > rows.length && (
          <button type="button" onClick={() => setAll(true)} className="w-full px-5 py-3 text-sm font-medium text-brand-700 hover:bg-zinc-50 dark:text-brand-400 dark:hover:bg-zinc-800/40">
            Show all {fullNumber(d.countries.length)}
          </button>
        )}
      </details>
    </Card>
  );
}

function DevicesCard({ d }: { d: Downloads }) {
  const total = Math.max(1, d.devices.reduce((s, x) => s + x.downloads, 0));
  return (
    <Card>
      <CardHeader title="Devices" description="First downloads by device." />
      <div className="space-y-2.5 px-5 pb-5">
        {d.devices.length === 0 && <p className="text-sm text-zinc-500">No device data.</p>}
        {d.devices.map((x, i) => (
          <div key={x.device} className="grid grid-cols-[6.5rem_1fr_5rem] items-center gap-3 text-sm">
            <span className="truncate">{x.device}</span>
            <InlineBar value={x.downloads} max={total} color={PALETTE[i % PALETTE.length]} />
            <span className="text-right tabular-nums">
              {fullNumber(x.downloads)} <span className="text-xs text-zinc-500">{percent(x.downloads / total, 0)}</span>
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function TypesCard({ d }: { d: Downloads }) {
  const t = d.totals;
  const p = d.previous;
  const rows: Array<[string, number, number]> = [
    ["Free first downloads", t.downloads - t.paidDownloads, p.downloads - p.paidDownloads],
    ["Paid first downloads", t.paidDownloads, p.paidDownloads],
    ["Redownloads", t.redownloads, p.redownloads],
    ["Updates", t.updates, p.updates],
  ];
  return (
    <Card>
      <CardHeader title="By kind" description="Range vs the previous period of the same length." />
      <ul className="divide-y divide-zinc-100 border-t border-zinc-100 text-sm dark:divide-zinc-800 dark:border-zinc-800">
        {rows.map(([label, cur, prev]) => (
          <li key={label} className="flex items-center justify-between gap-3 px-5 py-2.5">
            <span>{label}</span>
            <span className="tabular-nums">
              <span className="font-medium">{fullNumber(cur)}</span> <Change value={change(cur, prev)} className="ml-1 text-xs" />
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
