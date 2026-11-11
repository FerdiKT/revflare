import { useState } from "react";
import { Link } from "react-router";
import { ArrowUpRight, CheckCircle2, Clock, RefreshCw, TriangleAlert } from "lucide-react";
import type { UpdateStatus } from "@shared/types";
import { Button } from "../../components/ui/Button";
import { Badge, Card, CardHeader, ErrorState, PageHeader, Skeleton, Stat } from "../../components/ui/Misc";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { ago, compactNumber, dateTime, fullNumber, money } from "../../lib/format";
import { useFetch, useNow } from "../../lib/useFetch";
import { UsageCard } from "./UsageCard";

/** Admin → Overview: instance-wide counts, jobs, cron, database usage and the update check. */
export function AdminOverviewPage() {
  const r = useFetch("admin-overview", api.admin.overview, { tags: ["admin"], refreshMs: 60_000 });
  const now = useNow(30_000);
  const d = r.data;
  return (
    <>
      <PageHeader title="Admin" description="This Revflare server: users, workspaces, background work and database usage. Only instance admins see this." />
      {r.error && <ErrorState error={r.error} onRetry={r.refetch} className="mb-6" />}
      <Card className="mb-6 p-5">
        {!d ? (
          <Skeleton className="h-16" />
        ) : (
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Users" value={fullNumber(d.counts.users)} sub={`${d.counts.activeLast30d} active in 30 days${d.counts.disabledUsers ? ` · ${d.counts.disabledUsers} disabled` : ""}`} />
            <Stat label="Admins" value={fullNumber(d.counts.admins)} />
            <Stat label="Workspaces" value={fullNumber(d.counts.workspaces)} />
            <Stat label="Apps" value={fullNumber(d.counts.apps)} sub={d.counts.archivedApps ? `${d.counts.archivedApps} archived` : undefined} />
            <Stat label="Purchases (30 days)" value={compactNumber(d.sales.purchases30d)} sub={`${compactNumber(d.sales.purchases)} all time`} />
            <Stat label="Revenue (30 days)" value={money(d.sales.revenue30dUsd, "USD")} sub="All workspaces, USD" />
          </div>
        )}
      </Card>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <UpdateCard update={d?.update ?? null} version={d?.version ?? null} onChecked={r.refetch} />
        <Card>
          <CardHeader title="Background work" description="Imports and backfills across all workspaces, and the 5-minute cron." />
          <div className="space-y-3 px-5 pb-5 text-sm">
            {!d ? (
              <Skeleton className="h-20" />
            ) : (
              <>
                <Row label="Cron">
                  {d.cron.lastRunAt ? (
                    <span className="inline-flex items-center gap-2">
                      {ago(d.cron.lastRunAt, now)}
                      {d.cron.durationMs !== null && <span className="text-xs text-zinc-500">({(d.cron.durationMs / 1000).toFixed(1)} s)</span>}
                      {d.cron.stale && <Badge tone="amber">Stale</Badge>}
                    </span>
                  ) : (
                    <Badge tone="amber">Not run yet</Badge>
                  )}
                </Row>
                <Row label="Jobs">
                  <span className="inline-flex flex-wrap gap-1.5">
                    <Badge tone={d.jobs.running ? "blue" : "zinc"}>{d.jobs.running} running</Badge>
                    <Badge>{d.jobs.queued} queued</Badge>
                    <Badge tone={d.jobs.failed7d ? "red" : "zinc"}>{d.jobs.failed7d} failed (7 days)</Badge>
                  </span>
                </Row>
                <Row label="Open alerts">{fullNumber(d.alerts.open)}</Row>
                <Row label="API keys · iOS devices">
                  {fullNumber(d.counts.apiKeys)} · {fullNumber(d.counts.devices)}
                </Row>
                {d.jobs.recentFailed.length > 0 && (
                  <ul className="mt-2 divide-y divide-zinc-100 rounded-lg ring-1 ring-zinc-200 dark:divide-zinc-800 dark:ring-zinc-800">
                    {d.jobs.recentFailed.map((j) => (
                      <li key={j.id} className="px-3 py-2">
                        <p className="text-xs font-medium">
                          {j.kind} · {j.workspaceName ?? j.workspaceId} <span className="font-normal text-zinc-500">· {ago(j.at, now)}</span>
                        </p>
                        {j.error && <p className="truncate text-xs text-red-600 dark:text-red-400" title={j.error}>{j.error}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </Card>
      </div>

      <div className="mb-6">
        <UsageCard usage={d?.usage ?? null} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <PeopleCard
          title="Recent sign-ups"
          rows={d?.recentSignups.map((u) => ({ id: u.id, name: u.name, email: u.email, at: u.createdAt })) ?? null}
          now={now}
        />
        <PeopleCard
          title="Recent sign-ins"
          rows={d?.recentLogins.map((u) => ({ id: u.id, name: u.name, email: u.email, at: u.lastLoginAt })) ?? null}
          now={now}
        />
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

function PeopleCard({ title, rows, now }: { title: string; rows: Array<{ id: string; name: string; email: string; at: number }> | null; now: number }) {
  return (
    <Card>
      <CardHeader title={title} action={<Link to="/admin/users" className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400">All users</Link>} />
      {!rows ? (
        <Skeleton className="mx-5 mb-5 h-20" />
      ) : !rows.length ? (
        <p className="px-5 pb-5 text-sm text-zinc-500">Nobody yet.</p>
      ) : (
        <ul className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-zinc-800 dark:border-zinc-800">
          {rows.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{u.name}</p>
                <p className="truncate text-xs text-zinc-500">{u.email}</p>
              </div>
              <span className="shrink-0 text-xs text-zinc-500" title={dateTime(u.at)}>
                {ago(u.at, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function UpdateCard({ update, version, onChecked }: { update: UpdateStatus | null; version: { version: string; commit: string } | null; onChecked: () => void }) {
  const toast = useToast();
  const now = useNow(60_000);
  const [busy, setBusy] = useState(false);
  return (
    <Card>
      <CardHeader
        title="Version"
        description={update ? `Checks github.com/${update.repo} for new releases once a day.` : undefined}
        action={
          update?.enabled && (
            <Button
              size="sm"
              variant="outline"
              loading={busy}
              icon={<RefreshCw className="size-3.5" />}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.admin.checkUpdates();
                  onChecked();
                } catch (err) {
                  toast.error(err);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Check now
            </Button>
          )
        }
      />
      <div className="space-y-3 px-5 pb-5 text-sm">
        {!update || !version ? (
          <Skeleton className="h-16" />
        ) : (
          <>
            <Row label="Running">
              <span className="font-medium tabular-nums">v{version.version}</span> <span className="text-xs text-zinc-500">({version.commit})</span>
            </Row>
            <Row label="Latest release">
              {update.latest ? (
                update.url ? (
                  <a href={update.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline dark:text-brand-400">
                    v{update.latest} <ArrowUpRight className="size-3.5" />
                  </a>
                ) : (
                  `v${update.latest}`
                )
              ) : (
                <span className="text-zinc-500">—</span>
              )}
            </Row>
            <Row label="Status">
              {update.updateAvailable ? (
                <Badge tone="brand" icon={<ArrowUpRight />}>
                  Update available
                </Badge>
              ) : update.status === "ok" ? (
                <Badge tone="green" icon={<CheckCircle2 />}>
                  Up to date
                </Badge>
              ) : update.status === "never" ? (
                <Badge icon={<Clock />}>Not checked yet</Badge>
              ) : update.status === "disabled" ? (
                <Badge>Off</Badge>
              ) : (
                <Badge tone="amber" icon={<TriangleAlert />}>
                  {update.status === "not_found" ? "Repository not found" : "Check failed"}
                </Badge>
              )}
            </Row>
            {update.message && <p className="text-xs text-zinc-500 dark:text-zinc-400">{update.message}</p>}
            {update.checkedAt && <p className="text-xs text-zinc-500 dark:text-zinc-400">Checked {ago(update.checkedAt, now)}.</p>}
          </>
        )}
      </div>
    </Card>
  );
}
