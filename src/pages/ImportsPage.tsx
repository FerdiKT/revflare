import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Apple, Ban, CheckCircle2, CircleDashed, Coins, Compass, DownloadCloud, FileSpreadsheet, Loader2, XCircle } from "lucide-react";
import type { Job } from "@shared/types";
import { Button } from "../components/ui/Button";
import { Input, Select } from "../components/ui/Form";
import { AppIcon } from "../components/Logo";
import { Badge, Card, EmptyState, ErrorState, PageHeader, Skeleton } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { api, ApiError } from "../lib/api";
import { useApps } from "../lib/apps";
import { ago, cn, dateTime, fullNumber } from "../lib/format";
import { useSession } from "../lib/session";
import { invalidate, useFetch, useNow } from "../lib/useFetch";

const KIND_LABEL: Record<string, string> = {
  apple_backfill: "Apple backfill",
  revenuecat_discovery: "RevenueCat import",
  sales_reports: "Sales reports",
  fx_backfill: "Exchange rates",
  acquisition: "App Store acquisition",
};

const PHASES: Record<string, string> = {
  notification_history: "Reading notification history",
  transaction_history: "Reading customers' transaction history",
  discovery: "Finding App Store transactions in RevenueCat",
  requests: "Requesting App Analytics reports",
  reports: "Importing App Analytics reports",
  metrics: "Rebuilding metrics",
  done: "Done",
};

export function ImportsPage() {
  const { can } = useSession();
  const manage = can("manage");
  const [running, setRunning] = useState(false);
  const jobs = useFetch("jobs", api.jobs.list, { tags: ["jobs"], refreshMs: running ? 3000 : 20_000 });
  const nowRunning = !!jobs.data?.items.some((j) => j.status === "queued" || j.status === "running");
  if (nowRunning !== running) setRunning(nowRunning);

  return (
    <>
      <PageHeader title="Imports" description="Bring in history from Apple and RevenueCat. Jobs run in the background; you can leave this page." />
      {manage ? (
        <div className="grid gap-5 md:grid-cols-2">
          <AppleBackfill />
          <RevenueCatImport />
          <SalesReports />
          <AcquisitionImport />
          <FxImport />
        </div>
      ) : (
        <p className="mb-5 text-sm text-zinc-500">You can follow jobs here; starting imports needs the admin or owner role.</p>
      )}
      <h2 className="mt-10 mb-3 text-sm font-semibold">Jobs</h2>
      {jobs.error && <ErrorState error={jobs.error} onRetry={jobs.refetch} className="mb-4" />}
      <Card className="overflow-hidden">
        {!jobs.data ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : jobs.data.items.length === 0 ? (
          <EmptyState icon={<DownloadCloud />} title="No imports yet" description="Start the Apple backfill first: it reads 180 days of notifications and every customer's transaction history." />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {jobs.data.items.map((j) => (
              <JobRow key={j.id} job={j} manage={manage} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function ImportCard({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action: ReactNode }) {
  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-xl bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 [&_svg]:size-[18px]">{icon}</span>
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="mt-3 flex-1 text-[13px] text-zinc-500 dark:text-zinc-400">{children}</div>
      <div className="mt-4 flex flex-wrap items-center gap-2">{action}</div>
    </Card>
  );
}

function useStart() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const start = async (fn: () => Promise<{ reused?: boolean } | { jobs: unknown[] }>, label: string) => {
    setBusy(true);
    try {
      const r = await fn();
      if ("jobs" in r) toast.success(`${label} started`, `${r.jobs.length} job${r.jobs.length === 1 ? "" : "s"}, one per app.`);
      else toast.success(r.reused ? `${label} is already running` : `${label} started`);
      invalidate("jobs");
    } catch (err) {
      // 429 { code: "budget" }: today's background database budget is used up; the API says when to continue.
      if (err instanceof ApiError && err.code === "budget") toast.error(`${label} not started`, err.message);
      else toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, start };
}

function AppleBackfill() {
  const { apps } = useApps();
  const [appId, setAppId] = useState("");
  const { busy, start } = useStart();
  return (
    <ImportCard
      icon={<Apple />}
      title="Apple backfill"
      action={
        <>
          <Select value={appId} onChange={(e) => setAppId(e.target.value)} aria-label="App" className="min-w-44 flex-1 sm:flex-none">
            <option value="">All active apps</option>
            {apps
              .filter((a) => !a.archived && a.platform !== "android")
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </Select>
          <Button variant="primary" loading={busy} onClick={() => start(() => api.imports.apple(appId ? [appId] : undefined), "Apple backfill")}>
            Start
          </Button>
        </>
      }
    >
      180 days of App Store Server Notification history, then every customer&rsquo;s full transaction history from the App Store Server API. Needs an In-App Purchase key.
    </ImportCard>
  );
}

function RevenueCatImport() {
  const creds = useFetch("credentials", api.credentials.list, { tags: ["credentials"] });
  const rc = creds.data?.items.filter((c) => c.kind === "revenuecat") ?? [];
  const [id, setId] = useState("");
  const { busy, start } = useStart();
  const chosen = id || rc[0]?.id || "";
  return (
    <ImportCard
      icon={<DownloadCloud />}
      title="RevenueCat"
      action={
        rc.length === 0 ? (
          <Link to="/settings/credentials" className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
            Add a RevenueCat secret key first →
          </Link>
        ) : (
          <>
            <Select value={chosen} onChange={(e) => setId(e.target.value)} aria-label="RevenueCat credential" className="min-w-44 flex-1 sm:flex-none">
              {rc.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {typeof c.config.projectId === "string" ? ` · ${c.config.projectId}` : ""}
                </option>
              ))}
            </Select>
            <Button variant="primary" loading={busy} disabled={!chosen} onClick={() => start(() => api.imports.revenuecat(chosen), "RevenueCat import")}>
              Start
            </Button>
          </>
        )
      }
    >
      Finds the App Store transaction ids of every RevenueCat customer; Apple fills in the details, so the data stays Apple&rsquo;s. For the charts history, use <code className="font-mono text-xs">revflare import revenuecat-charts</code> in the CLI.
    </ImportCard>
  );
}

function SalesReports() {
  const [days, setDays] = useState("30");
  const { busy, start } = useStart();
  return (
    <ImportCard
      icon={<FileSpreadsheet />}
      title="Sales and Trends reports"
      action={
        <>
          <label className="flex items-center gap-2 text-sm">
            Last
            <Input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} className="w-20" aria-label="Days" />
            days
          </label>
          <Button variant="primary" loading={busy} onClick={() => start(() => api.imports.salesReports(Math.min(365, Math.max(1, Number(days) || 30))), "Sales reports import")}>
            Start
          </Button>
        </>
      }
    >
      Apple&rsquo;s daily sales summaries, for <Link to="/reconciliation" className="text-brand-700 hover:underline dark:text-brand-400">reconciliation</Link> and actual proceeds. Needs an App Store Connect key with the Sales role and the vendor number.
    </ImportCard>
  );
}

function AcquisitionImport() {
  const { busy, start } = useStart();
  return (
    <ImportCard
      icon={<Compass />}
      title="App Store acquisition (App Analytics)"
      action={
        <Button variant="primary" loading={busy} onClick={() => start(() => api.imports.acquisition(), "Acquisition import")}>
          Start
        </Button>
      }
    >
      Requests Apple&rsquo;s App Analytics reports for every app, then imports every report Apple has: impressions, page views and downloads by source, for{" "}
      <Link to="/acquisition" className="text-brand-700 hover:underline dark:text-brand-400">
        acquisition
      </Link>
      . Requesting needs an App Store Connect key with the Admin role; Apple produces the first reports 1–2 days later. Revflare also imports new ones every few hours.
    </ImportCard>
  );
}

function FxImport() {
  const [from, setFrom] = useState("2019-01-01");
  const { busy, start } = useStart();
  return (
    <ImportCard
      icon={<Coins />}
      title="Exchange rates"
      action={
        <>
          <label className="flex items-center gap-2 text-sm">
            From
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" aria-label="From" />
          </label>
          <Button variant="primary" loading={busy} onClick={() => start(() => api.imports.fx(from), "Exchange rates import")}>
            Start
          </Button>
        </>
      }
    >
      Daily rates, so past sales convert at their day&rsquo;s rate into your reporting currency. Revflare keeps them current on its own; run this after switching to an older history.
    </ImportCard>
  );
}

function JobRow({ job, manage }: { job: Job; manage: boolean }) {
  const toast = useToast();
  const { byId } = useApps();
  const now = useNow(10_000);
  const app = typeof job.params.appId === "string" ? byId.get(job.params.appId) : undefined;
  const p = job.progress;
  const phase = typeof p.phase === "string" && job.status !== "failed" ? (PHASES[p.phase] ?? p.phase) : null;
  const counters = Object.entries(p).filter(([k, v]) => k !== "phase" && typeof v === "number" && (v > 0 || job.status !== "failed")) as Array<[string, number]>;
  const active = job.status === "queued" || job.status === "running";
  const status = {
    queued: { icon: <CircleDashed className="size-4 text-zinc-400" />, badge: <Badge>Queued</Badge> },
    running: { icon: <Loader2 className="size-4 animate-spin text-brand-500" />, badge: <Badge tone="brand">Running</Badge> },
    done: { icon: <CheckCircle2 className="size-4 text-emerald-500" />, badge: <Badge tone="green">Done</Badge> },
    failed: { icon: <XCircle className="size-4 text-red-500" />, badge: <Badge tone="red">Failed</Badge> },
    cancelled: { icon: <Ban className="size-4 text-zinc-400" />, badge: <Badge>Cancelled</Badge> },
  }[job.status];
  return (
    <li className="flex flex-wrap items-start gap-3 px-5 py-4">
      <span className="mt-0.5">{status.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{KIND_LABEL[job.kind] ?? job.kind}</span>
          {app && (
            <span className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-300">
              <AppIcon name={app.name} url={app.iconUrl} size={18} /> {app.name}
            </span>
          )}
          {status.badge}
          {p.unavailable === true && <Badge tone="zinc">Not released</Badge>}
        </div>
        {(phase || counters.length > 0) && (
          <p className="mt-1 text-xs text-zinc-500">
            {phase}
            {phase && counters.length > 0 && " · "}
            {counters.map(([k, v]) => `${fullNumber(v)} ${k.replace(/_/g, " ")}`).join(" · ")}
          </p>
        )}
        {job.error && <p className="mt-1 text-xs break-words text-red-600 dark:text-red-400">{job.error}</p>}
        {active && (
          <div className="mt-2 h-1 w-full max-w-sm overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800" aria-hidden>
            <div className={cn("h-full w-1/3 rounded-full bg-gradient-to-r from-brand-500 to-amber-400", "animate-[slide-in_1.2s_ease-in-out_infinite_alternate]")} />
          </div>
        )}
      </div>
      <div className="text-right text-xs text-zinc-500">
        <p title={dateTime(job.createdAt)}>Started {ago(job.createdAt, now)}</p>
        {job.finishedAt ? <p>Finished {ago(job.finishedAt, now)}</p> : <p>Updated {ago(job.updatedAt, now)}</p>}
        {manage && active && (
          <button
            className="mt-1 font-medium text-red-600 hover:underline dark:text-red-400"
            onClick={async () => {
              try {
                await api.jobs.cancel(job.id);
                invalidate("jobs");
              } catch (err) {
                toast.error(err);
              }
            }}
          >
            Cancel
          </button>
        )}
      </div>
    </li>
  );
}
