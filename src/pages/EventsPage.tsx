import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { Activity, ArrowLeft, Filter, TriangleAlert } from "lucide-react";
import type { AnalyticsStatus } from "@shared/types";
import { ChartSkeleton, InlineBar, Legend, OTHER_COLOR, PALETTE, TimeChart } from "../components/charts";
import { Switch } from "../components/ui/Form";
import { Badge, Card, CardHeader, CopyField, EmptyState, ErrorState, PageHeader, Segmented, Skeleton, Stat, Table, td, th } from "../components/ui/Misc";
import { api, ApiError } from "../lib/api";
import { ago, compactNumber, dateTime, fullNumber } from "../lib/format";
import { useFetch, useNow } from "../lib/useFetch";

export const RANGES = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
] as const;
export type Range = (typeof RANGES)[number]["value"];

export const notConfigured = (err: unknown) => err instanceof ApiError && err.code === "analytics_not_configured";

/** Back link to the app page. */
export function BackToApp({ id, name }: { id: string; name?: string }) {
  return (
    <Link to={`/apps/${id}`} className="mb-4 inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
      <ArrowLeft className="size-4" /> {name ?? "App"}
    </Link>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs dark:bg-zinc-800">{children}</code>;
}

/** What to configure for events (binding) and their queries (account id, token). */
export function AnalyticsSetup({ status }: { status: AnalyticsStatus }) {
  if (status.ingest && status.query) return null;
  return (
    <Card className="mb-5 border-amber-200 dark:border-amber-900/60">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <TriangleAlert className="size-4 text-amber-600" /> Events are not fully set up
          </span>
        }
        description="Revflare stores app events in Cloudflare Workers Analytics Engine (not in the database) and reads them with the Analytics Engine SQL API."
      />
      <div className="space-y-3 border-t border-zinc-100 px-5 py-4 text-sm dark:border-zinc-800">
        <ul className="list-disc space-y-1 pl-5 text-zinc-700 dark:text-zinc-300">
          {status.missing.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
        {!status.ingest && (
          <div>
            <p className="mb-1.5 text-zinc-600 dark:text-zinc-400">
              In <Code>wrangler.local.jsonc</Code> (or <Code>wrangler.jsonc</Code>), then deploy. Until then apps get <Code>200</Code> and their events are dropped.
            </p>
            <CopyField value={`"analytics_engine_datasets": [{ "binding": "EVENTS", "dataset": "${status.dataset}" }]`} />
          </div>
        )}
        {!status.query && (
          <div className="space-y-1.5">
            <p className="text-zinc-600 dark:text-zinc-400">
              Add your account id to <Code>vars</Code> (<Code>"CF_ACCOUNT_ID": "…"</Code>, Cloudflare dashboard → Workers &amp; Pages, right column) and an API token with{" "}
              <strong>Account → Account Analytics → Read</strong> as a secret:
            </p>
            <CopyField value="npx wrangler secret put CF_ANALYTICS_TOKEN" />
          </div>
        )}
        <p className="text-xs text-zinc-500">Costs: Workers Paid includes 10 million data points (one per event) and 1 million queries a month; the Free plan allows 100,000 data points a day. Events are kept 3 months.</p>
      </div>
    </Card>
  );
}

/** "Include test data": sandbox / Xcode builds and the app's test devices are left out of event reads by default. */
export function IncludeTestToggle({ appId, value, onChange }: { appId: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400" title="By default, events from sandbox (TestFlight / development) and Xcode builds and from the app's test devices are left out.">
      <Switch label="Include test data" checked={value} onChange={onChange} />
      Include test data
      <Link to={`/apps/${appId}/test-devices`} className="text-xs text-brand-700 hover:underline dark:text-brand-400">
        Test devices
      </Link>
    </label>
  );
}

/** Apps → app → Events: top events, unique installs and a daily chart (Workers Analytics Engine). */
export function EventsPage() {
  const { id = "" } = useParams();
  const [range, setRange] = useState<Range>("7d");
  const [includeTest, setIncludeTest] = useState(false);
  const now = useNow(30_000);
  const app = useFetch(`app:${id}`, () => api.apps.get(id), { tags: ["apps"] });
  const status = useFetch(`analytics-status:${id}`, () => api.apps.analytics.status(id), { tags: ["apps"] });
  const queryable = status.data?.query ?? false;
  const r = useFetch(queryable ? `events:${id}:${range}:${includeTest}` : null, () => api.apps.analytics.summary(id, range, includeTest), { refreshMs: 5 * 60_000 });
  const s = r.data;

  const top = s?.events.slice(0, PALETTE.length - 1) ?? [];
  const colorOf = new Map(top.map((e, i) => [e.name, PALETTE[i]]));
  const keys = [...top.map((e) => e.name), ...(s?.daily.some((d) => d.byEvent["(other)"]) ? ["(other)"] : [])];
  const series = keys.map((k) => ({ key: k, label: k === "(other)" ? "Other events" : k, color: colorOf.get(k) ?? OTHER_COLOR, values: s?.daily.map((d) => d.byEvent[k] ?? 0) ?? [] }));
  const maxCount = Math.max(1, ...(s?.events.map((e) => e.count) ?? []));

  return (
    <>
      <BackToApp id={id} name={app.data?.name} />
      <PageHeader
        title="Events"
        description="App events sent by RevflareKit (Revflare.track), stored in Cloudflare Workers Analytics Engine. Days are UTC."
        actions={
          <>
            <Link to={`/apps/${id}/funnels`} className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
              <Filter className="size-4" /> Funnels
            </Link>
            <IncludeTestToggle appId={id} value={includeTest} onChange={setIncludeTest} />
            <Segmented label="Range" options={RANGES.map((x) => ({ ...x }))} value={range} onChange={setRange} />
          </>
        }
      />
      {status.error && <ErrorState error={status.error} onRetry={status.refetch} />}
      {!status.data && !status.error && <Skeleton className="h-40" />}
      {status.data && <AnalyticsSetup status={status.data} />}
      {status.data && (
        <p className="mb-4 text-xs text-zinc-500">
          Last events received: {status.data.lastEventAt ? <span title={dateTime(status.data.lastEventAt)}>{ago(status.data.lastEventAt, now)}</span> : "none yet"}
          {status.data.lastTestEventAt ? (
            <>
              {" · "}test builds: <span title={dateTime(status.data.lastTestEventAt)}>{ago(status.data.lastTestEventAt, now)}</span>
            </>
          ) : null}
          {" · "}
          {includeTest ? "Test data included (sandbox / Xcode builds, test devices)." : "Production data only: sandbox / Xcode builds and test devices are excluded."}
        </p>
      )}
      {queryable && r.error && !notConfigured(r.error) && <ErrorState error={r.error} onRetry={r.refetch} />}
      {queryable && !s && !r.error && (
        <div className="space-y-5">
          <Skeleton className="h-24" />
          <ChartSkeleton />
        </div>
      )}
      {s && (
        <>
          <Card className="mb-5 grid grid-cols-2 gap-5 p-5 sm:grid-cols-3">
            <Stat label="Events" value={fullNumber(s.totalEvents)} sub={s.approximate ? <Badge tone="amber">sampled</Badge> : `${s.from} → ${s.to}`} />
            <Stat label="Unique installs" value={fullNumber(s.uniqueInstalls)} sub={s.approximate ? "lower bound (sampled)" : undefined} />
            <Stat label="Event names" value={fullNumber(s.events.length)} />
          </Card>
          {!!s.notes?.length && (
            <div className="mb-5 space-y-1 text-sm text-zinc-500">
              {s.notes.map((n) => (
                <p key={n}>{n}</p>
              ))}
            </div>
          )}
          {!s.events.length ? (
            <Card>
              <EmptyState
                icon={<Activity />}
                title="No events in this period"
                description={
                  <>
                    Send them from the app with RevflareKit: <Code>Revflare.track("paywall_view", ["placement": "onboarding"])</Code>. They show up here within a minute or two.
                  </>
                }
              />
            </Card>
          ) : (
            <>
              <Card className="mb-5 p-4">
                <p className="mb-2 px-2 text-sm font-medium">Events per day</p>
                <Legend className="mb-3 px-2" items={series.map((x) => ({ key: x.key, label: x.label, color: x.color }))} />
                <TimeChart
                  dates={s.daily.map((d) => d.date)}
                  interval="day"
                  series={series}
                  height={240}
                  showTotal
                  formatValue={(v) => fullNumber(v)}
                  formatAxis={(v) => compactNumber(v)}
                  label="Events per day, stacked by event name"
                />
              </Card>
              <Card className="overflow-hidden">
                <CardHeader title="Top events" description="Count (weighted when sampled) and unique installs over the period; key events marked exact are counted from the database." />
                <Table>
                  <thead>
                    <tr className="border-y border-zinc-100 text-left dark:border-zinc-800">
                      <th className={th}>Event</th>
                      <th className={`${th} text-right`}>Count</th>
                      <th className={`${th} text-right`}>Installs</th>
                      <th className={`${th} w-1/3`} aria-label="Share" />
                      <th className={th}>Last received</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {s.events.map((e) => (
                      <tr key={e.name}>
                        <td className={`${td} font-mono text-xs`}>
                          {e.name}
                          {e.source === "exact" && (
                            <Badge tone="green" className="ml-2 font-sans" title="Key event stored exactly in the database: exact count and unique installs (UTC days of reception)">
                              exact
                            </Badge>
                          )}
                        </td>
                        <td className={`${td} text-right tabular-nums`}>{fullNumber(e.count)}</td>
                        <td className={`${td} text-right tabular-nums`}>{fullNumber(e.installs)}</td>
                        <td className={td}>
                          <InlineBar value={e.count} max={maxCount} />
                        </td>
                        <td className={`${td} text-xs text-zinc-500`}>{e.lastSeenAt ? ago(e.lastSeenAt, now) : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            </>
          )}
        </>
      )}
    </>
  );
}
