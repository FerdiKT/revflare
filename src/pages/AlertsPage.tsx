import { useState } from "react";
import { Link } from "react-router";
import { Bell, Check } from "lucide-react";
import { AppIcon } from "../components/Logo";
import { Button } from "../components/ui/Button";
import { Badge, Card, EmptyState, ErrorState, PageHeader, Segmented, Skeleton } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { useApps } from "../lib/apps";
import { ago, cn, dateTime } from "../lib/format";
import { invalidate, useFetch, useNow } from "../lib/useFetch";
import { SEVERITY } from "./OverviewPage";

export function AlertsPage() {
  const r = useFetch("alerts", api.alerts.list, { tags: ["alerts"], refreshMs: 60_000 });
  const { byId } = useApps();
  const toast = useToast();
  const now = useNow(30_000);
  const [show, setShow] = useState<"open" | "resolved">("open");
  const [busy, setBusy] = useState<string | null>(null);
  const items = r.data?.items.filter((a) => (show === "open" ? !a.resolvedAt : !!a.resolvedAt)) ?? [];
  const openCount = r.data?.items.filter((a) => !a.resolvedAt).length ?? 0;

  const resolve = async (id: string) => {
    setBusy(id);
    try {
      await api.alerts.resolve(id);
      r.setData((d) => d && { items: d.items.map((a) => (a.id === id ? { ...a, resolvedAt: Date.now() } : a)) });
      invalidate("alerts");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader title="Alerts" description="Silent notifications, failing syncs, revenue drops, refund spikes, app events gone quiet, funnel drops and release regressions. Also sent to your iPhone." />
      <Segmented
        label="Show"
        className="mb-4"
        value={show}
        onChange={setShow}
        options={[
          { value: "open", label: `Open${openCount ? ` (${openCount})` : ""}` },
          { value: "resolved", label: "Resolved" },
        ]}
      />
      {r.error && <ErrorState error={r.error} onRetry={r.refetch} className="mb-4" />}
      <Card className="overflow-hidden">
        {!r.data ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Bell />}
            title={show === "open" ? "All clear" : "Nothing resolved yet"}
            description={show === "open" ? "Revflare checks every few minutes and raises an alert when something needs your attention." : undefined}
          />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {items.map((a) => {
              const s = SEVERITY[a.severity] ?? SEVERITY.info;
              const app = a.appId ? byId.get(a.appId) : undefined;
              return (
                <li key={a.id} className="flex flex-wrap items-start gap-3 px-5 py-4">
                  <s.icon className={cn("mt-0.5 size-5 shrink-0", s.className)} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{a.title}</p>
                      <Badge tone={a.severity === "critical" ? "red" : a.severity === "warning" ? "amber" : "blue"}>{s.label}</Badge>
                      {app && (
                        <span className="flex items-center gap-1.5 text-xs text-zinc-500">
                          <AppIcon name={app.name} url={app.iconUrl} size={16} /> {app.name}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm whitespace-pre-line text-zinc-600 dark:text-zinc-400">{a.body}</p>
                    {a.appId && a.funnelId && (
                      <Link to={`/apps/${a.appId}/funnels/${a.funnelId}`} className="mt-1 inline-block text-xs font-medium text-brand-700 hover:underline dark:text-brand-400">
                        Open the funnel report
                      </Link>
                    )}
                    {a.appId && a.experimentId && (
                      <Link to={`/apps/${a.appId}/experiments/${a.experimentId}`} className="mt-1 inline-block text-xs font-medium text-brand-700 hover:underline dark:text-brand-400">
                        Open the experiment
                      </Link>
                    )}
                    {a.appId && a.kind === "events_silent" && (
                      <Link to={`/apps/${a.appId}/events`} className="mt-1 inline-block text-xs font-medium text-brand-700 hover:underline dark:text-brand-400">
                        Open the app's events
                      </Link>
                    )}
                    {a.appId && a.kind === "google_play_test" && (
                      <Link to={`/apps/${a.appId}/google-play`} className="mt-1 inline-block text-xs font-medium text-brand-700 hover:underline dark:text-brand-400">
                        Open the Google Play settings
                      </Link>
                    )}
                    <p className="mt-1 text-xs text-zinc-400" title={dateTime(a.createdAt)}>
                      {ago(a.createdAt, now)}
                      {a.resolvedAt && ` · resolved ${ago(a.resolvedAt, now)}`}
                    </p>
                  </div>
                  {!a.resolvedAt && (
                    <Button size="sm" icon={<Check className="size-3.5" />} loading={busy === a.id} onClick={() => resolve(a.id)}>
                      Resolve
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
