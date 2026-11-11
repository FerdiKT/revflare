import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Archive, CheckCircle2, FlaskConical, Pencil, Play, Plus, RefreshCw, Rocket, Square, Trash2, TriangleAlert } from "lucide-react";
import {
  EXPERIMENT_LIMITS,
  EXPERIMENT_METRICS,
  type Experiment,
  type ExperimentInput,
  type ExperimentMetric,
  type ExperimentResults,
  type ExperimentStatus,
  type RemoteConfig,
  type RemoteConfigValueType,
} from "@shared/types";
import { Legend, PALETTE, TimeChart } from "../components/charts";
import { Button, IconButton } from "../components/ui/Button";
import { useConfirm } from "../components/ui/Confirm";
import { Dialog } from "../components/ui/Dialog";
import { Checkbox, Field, Input, Select, Textarea } from "../components/ui/Form";
import { Badge, Card, CardHeader, EmptyState, ErrorState, PageHeader, Segmented, Skeleton, Table, td, th, type Tone } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { ago, cn, compactNumber, date, dateTime, fullNumber, money, percent, signedPercent } from "../lib/format";
import { useSession } from "../lib/session";
import { useFetch } from "../lib/useFetch";
import { BackToApp } from "./EventsPage";
import { fromDraft, showValue, toDraft, ValueInput } from "./RemoteConfigPage";

// A/B experiments on remote config parameters (docs/experiments.md): list, editor, lifecycle actions and results.

const STATUS: Record<ExperimentStatus, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "zinc" },
  running: { label: "Running", tone: "green" },
  stopped: { label: "Stopped", tone: "amber" },
  rolled_out: { label: "Rolled out", tone: "brand" },
  archived: { label: "Archived", tone: "zinc" },
};
const METRIC_LABEL: Record<ExperimentMetric, string> = { trial_started: "Trial started", paid: "Paid conversion", revenue_per_install: "Revenue per install" };
const VARIANT_IDS = ["a", "b", "c", "d", "e"];
const DAY = 86_400_000;

export function StatusBadge({ status }: { status: ExperimentStatus }) {
  const s = STATUS[status];
  return (
    <Badge tone={s.tone} dot={status === "running"}>
      {s.label}
    </Badge>
  );
}

const docsLink = (
  <a href="https://github.com/FerdiKT/revflare/blob/main/docs/experiments.md" target="_blank" rel="noreferrer" className="text-brand-700 hover:underline dark:text-brand-400">
    how it works
  </a>
);

// --- List -------------------------------------------------------------------------------------------------------------

/** Apps → app → Experiments: every experiment of the app, newest first. */
export function ExperimentsPage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const navigate = useNavigate();
  const app = useFetch(`app:${id}`, () => api.apps.get(id), { tags: ["apps"] });
  const list = useFetch(`experiments:${id}`, () => api.apps.experiments.list(id), { tags: ["apps"] });
  const config = useFetch(`remote-config:${id}`, () => api.apps.remoteConfig.get(id), { tags: ["apps"] });
  const [creating, setCreating] = useState(false);
  const items = list.data?.items;
  const noParams = config.data && config.data.parameters.length === 0;

  return (
    <>
      <BackToApp id={id} name={app.data?.name} />
      <PageHeader
        title="Experiments"
        description={
          <>
            A/B tests on remote config parameters: each variant gets its own values, devices are assigned in a stable way, and Revflare compares trials, paid conversions and revenue per install of the exposed installs ({docsLink}).
          </>
        }
        actions={
          <>
            <Link to={`/apps/${id}/config`} className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
              Remote config
            </Link>
            {can("manage") && (
              <Button variant="primary" icon={<Plus className="size-4" />} disabled={!config.data || !!noParams} onClick={() => setCreating(true)}>
                New experiment
              </Button>
            )}
          </>
        }
      />
      {list.error && <ErrorState error={list.error} onRetry={list.refetch} />}
      {!items && !list.error && <Skeleton className="h-48" />}
      {items && (
        <Card className="overflow-hidden">
          {items.length === 0 ? (
            <EmptyState
              icon={<FlaskConical />}
              title="No experiments yet"
              description={
                noParams ? (
                  <>
                    Add a <Link to={`/apps/${id}/config`} className="text-brand-700 hover:underline dark:text-brand-400">remote config parameter</Link> first (e.g. paywall_variant), then test its values here.
                  </>
                ) : (
                  "Pick one or more remote config parameters (e.g. paywall_variant) and give each variant its own values. RevflareKit 1.7 reports which installs saw them."
                )
              }
            />
          ) : (
            <Table>
              <thead className="border-b border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
                <tr>
                  <th className={th}>Experiment</th>
                  <th className={th}>Status</th>
                  <th className={th}>Parameters</th>
                  <th className={th}>Variants</th>
                  <th className={th}>Primary metric</th>
                  <th className={th}>Started</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {items.map((x) => (
                  <tr key={x.id} className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/40" onClick={() => navigate(`/apps/${id}/experiments/${x.id}`)}>
                    <td className={td}>
                      <Link to={`/apps/${id}/experiments/${x.id}`} className="text-sm font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                        {x.name}
                      </Link>
                      {x.hypothesis && <p className="mt-0.5 max-w-80 truncate text-xs text-zinc-500" title={x.hypothesis}>{x.hypothesis}</p>}
                    </td>
                    <td className={td}>
                      <StatusBadge status={x.status} />
                      {x.status === "rolled_out" && x.rolledOutVariant && <span className="ml-1.5 text-xs text-zinc-500">({x.rolledOutVariant})</span>}
                    </td>
                    <td className={cn(td, "max-w-56 truncate font-mono text-xs")} title={x.keys.join(", ")}>
                      {x.keys.join(", ")}
                    </td>
                    <td className={cn(td, "text-xs text-zinc-600 dark:text-zinc-400")}>{x.variants.map((v) => `${v.id.toUpperCase()} ${Math.round(v.weight * 10) / 10}%`).join(" · ")}</td>
                    <td className={cn(td, "text-xs")}>{METRIC_LABEL[x.primaryMetric]}</td>
                    <td className={cn(td, "text-xs text-zinc-500")}>
                      {x.startedAt ? (
                        <span title={dateTime(x.startedAt)}>
                          {date(x.startedAt)}
                          {x.status === "running" && x.endsAt ? ` · auto-stops ${date(x.endsAt)}` : ""}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
      {creating && config.data && (
        <ExperimentEditor
          appId={id}
          config={config.data}
          others={items ?? []}
          onClose={() => setCreating(false)}
          onSaved={(x) => {
            setCreating(false);
            navigate(`/apps/${id}/experiments/${x.id}`);
          }}
        />
      )}
    </>
  );
}

// --- Detail -----------------------------------------------------------------------------------------------------------

/** One experiment: definition, lifecycle actions and results. */
export function ExperimentPage() {
  const { id = "", eid = "" } = useParams();
  const { can } = useSession();
  const manage = can("manage");
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const app = useFetch(`app:${id}`, () => api.apps.get(id), { tags: ["apps"] });
  const x = useFetch(`experiment:${id}:${eid}`, () => api.apps.experiments.get(id, eid), { tags: ["apps"] });
  const config = useFetch(`remote-config:${id}`, () => api.apps.remoteConfig.get(id), { tags: ["apps"] });
  const list = useFetch(manage ? `experiments:${id}` : null, () => api.apps.experiments.list(id), { tags: ["apps"] });
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [rollingOut, setRollingOut] = useState(false);
  const [resultsKey, setResultsKey] = useState(0);
  const e = x.data;

  const act = async (name: string, fn: () => Promise<Experiment | { ok: true }>, ok: string) => {
    setBusy(name);
    try {
      const r = await fn();
      if ("id" in r) x.setData(() => r);
      setResultsKey((k) => k + 1);
      toast.success(ok);
      return true;
    } catch (err) {
      toast.error(err);
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (x.error)
    return (
      <>
        <BackToApp id={id} name={app.data?.name} />
        <ErrorState error={x.error} onRetry={x.refetch} />
      </>
    );
  if (!e)
    return (
      <>
        <BackToApp id={id} name={app.data?.name} />
        <Skeleton className="mb-5 h-16" />
        <Skeleton className="h-72" />
      </>
    );

  const start = async () => {
    const ok = await confirm({
      title: `Start "${e.name}"?`,
      message: (
        <>
          <p>
            {e.traffic}% of {e.targeting ? `devices matching ${e.targeting}` : "devices"} enroll and get their variant's values for {e.keys.join(", ")} at their next config fetch. Weights, values and targeting cannot change once it runs.
          </p>
          <p>It stops automatically after {EXPERIMENT_LIMITS.maxDays} days.</p>
        </>
      ),
      confirmLabel: "Start experiment",
    });
    if (ok) await act("start", () => api.apps.experiments.start(id, e.id), "Experiment started");
  };
  const stop = async () => {
    const ok = await confirm({
      title: `Stop "${e.name}"?`,
      message: (
        <>
          <p>The results are computed once more up to now and then frozen.</p>
          <p>Devices keep their variant (no flip back) until you roll out a variant or archive the experiment.</p>
        </>
      ),
      confirmLabel: "Stop experiment",
    });
    if (ok) await act("stop", () => api.apps.experiments.stop(id, e.id), "Experiment stopped");
  };
  const archive = async () => {
    const active = e.status === "running" || e.status === "stopped";
    const ok = await confirm({
      title: `Archive "${e.name}"?`,
      message: active ? "The experiment leaves the config: every device gets the normal values of its parameters again (the config itself does not change)." : "The draft is kept read-only.",
      confirmLabel: "Archive",
      danger: active,
    });
    if (ok) await act("archive", () => api.apps.experiments.archive(id, e.id), "Experiment archived");
  };
  const remove = async () => {
    if (!(await confirm({ title: `Delete "${e.name}"?`, message: "The experiment and its results are deleted for good.", confirmLabel: "Delete", danger: true }))) return;
    if (await act("delete", () => api.apps.experiments.remove(id, e.id), "Experiment deleted")) navigate(`/apps/${id}/experiments`);
  };

  const active = e.status === "running" || e.status === "stopped";
  return (
    <>
      <BackToApp id={id} name={app.data?.name} />
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-2.5">
            {e.name} <StatusBadge status={e.status} />
          </span>
        }
        description={e.hypothesis ?? undefined}
        actions={
          <>
            <Link to={`/apps/${id}/experiments`} className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
              All experiments
            </Link>
            {manage && e.status === "draft" && (
              <>
                <Button icon={<Pencil className="size-4" />} disabled={!config.data} onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button variant="primary" icon={<Play className="size-4" />} loading={busy === "start"} disabled={!!busy} onClick={start}>
                  Start
                </Button>
              </>
            )}
            {manage && e.status === "running" && (
              <Button icon={<Square className="size-4" />} loading={busy === "stop"} disabled={!!busy} onClick={stop}>
                Stop
              </Button>
            )}
            {manage && active && (
              <Button variant="primary" icon={<Rocket className="size-4" />} disabled={!!busy} onClick={() => setRollingOut(true)}>
                Roll out
              </Button>
            )}
            {manage && (e.status === "draft" || active) && (
              <Button icon={<Archive className="size-4" />} loading={busy === "archive"} disabled={!!busy} onClick={archive}>
                Archive
              </Button>
            )}
            {manage && !active && (
              <IconButton label="Delete" variant="danger" disabled={!!busy} onClick={remove}>
                <Trash2 className="size-4" />
              </IconButton>
            )}
          </>
        }
      />
      <Definition e={e} />
      {e.startedAt !== null ? (
        <Results key={`${e.status}:${resultsKey}`} appId={id} e={e} />
      ) : (
        <Card className="mt-5">
          <EmptyState icon={<FlaskConical />} title="Not started" description="Results appear once the experiment runs and RevflareKit reports exposures (Revflare.remoteConfig reads of its parameters)." />
        </Card>
      )}
      {editing && config.data && (
        <ExperimentEditor
          appId={id}
          config={config.data}
          initial={e}
          others={list.data?.items ?? []}
          onClose={() => setEditing(false)}
          onSaved={(n) => {
            x.setData(() => n);
            setEditing(false);
          }}
        />
      )}
      {rollingOut && (
        <RolloutDialog
          e={e}
          onClose={() => setRollingOut(false)}
          onConfirm={async (variant) => {
            if (await act("rollout", () => api.apps.experiments.rollout(id, e.id, variant), `Variant ${variant.toUpperCase()} rolled out`)) setRollingOut(false);
          }}
          busy={busy === "rollout"}
        />
      )}
    </>
  );
}

function Definition({ e }: { e: Experiment }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Variants"
        description={
          <>
            {e.traffic}% of {e.targeting ? <>devices matching condition <strong className="font-medium">{e.targeting}</strong></> : "devices with an install id"} enroll · primary metric {METRIC_LABEL[e.primaryMetric].toLowerCase()}
            {e.startedAt ? ` · started ${dateTime(e.startedAt)}` : ""}
            {e.stoppedAt ? ` · stopped ${dateTime(e.stoppedAt)}` : e.status === "running" && e.endsAt ? ` · auto-stops ${date(e.endsAt)}` : ""}
            {e.rolledOutVariant ? ` · variant ${e.rolledOutVariant.toUpperCase()} rolled out` : ""}
          </>
        }
      />
      <Table>
        <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
          <tr>
            <th className={th}>Variant</th>
            <th className={cn(th, "text-right")}>Weight</th>
            {e.keys.map((k) => (
              <th key={k} className={cn(th, "font-mono")}>
                {k}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {e.variants.map((v) => (
            <tr key={v.id}>
              <td className={td}>
                <span className="font-mono text-xs text-zinc-400">{v.id}</span> <span className="text-sm font-medium">{v.name}</span>
                {v.id === "a" && <span className="ml-1.5 text-xs text-zinc-500">control</span>}
                {e.rolledOutVariant === v.id && <CheckCircle2 className="ml-1.5 inline size-4 text-emerald-600" />}
              </td>
              <td className={cn(td, "text-right tabular-nums")}>{Math.round(v.weight * 100) / 100}%</td>
              {e.keys.map((k) => (
                <td key={k} className={cn(td, "max-w-56 truncate font-mono text-xs")} title={k in v.values ? JSON.stringify(v.values[k]) : undefined}>
                  {k in v.values ? showValue(v.values[k], 40) : <span className="font-sans text-zinc-500">current value</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

// --- Results ----------------------------------------------------------------------------------------------------------

type RateMetric = "trial_started" | "paid";

function Results({ appId, e }: { appId: string; e: Experiment }) {
  const r = useFetch(`experiment-results:${appId}:${e.id}`, () => api.apps.experiments.results(appId, e.id));
  const [metric, setMetric] = useState<RateMetric>(e.primaryMetric === "trial_started" ? "trial_started" : "paid");
  const [refreshing, setRefreshing] = useState(false);
  const toast = useToast();
  const data = r.data;
  // Recompute now (the server allows it once an hour per experiment, within the daily background budget).
  const refresh = async () => {
    setRefreshing(true);
    try {
      const next = await api.apps.experiments.refreshResults(appId, e.id);
      r.setData(() => next);
    } catch (err) {
      toast.error(err);
    } finally {
      setRefreshing(false);
    }
  };
  if (r.error) return <ErrorState className="mt-5" error={r.error} onRetry={r.refetch} />;
  if (!data)
    return (
      <div className="mt-5 space-y-5">
        <Skeleton className="h-56" />
        <Skeleton className="h-64" />
      </div>
    );
  const control = data.variants[0];
  const measured = data.exposureSource === "events";
  const leader = data.variants.reduce((a, b) => ((b.probabilityBest[metric] ?? -1) > (a.probabilityBest[metric] ?? -1) ? b : a), control);

  return (
    <>
      {!data.enoughData && (
        <div className="mt-5 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
          <p className="flex items-center gap-2 font-medium">
            <TriangleAlert className="size-4 shrink-0" /> Not enough data yet
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-10 text-xs">
            {data.reasons.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <p className="mt-1.5 pl-6 text-xs">
            Guardrails: {EXPERIMENT_LIMITS.minDays} days, {EXPERIMENT_LIMITS.minExposed} exposed installs per variant, {EXPERIMENT_LIMITS.minConversions} conversions on the primary metric. Probabilities below describe the data so far: do not call a winner before.
          </p>
        </div>
      )}
      {data.confident && (
        <div className="mt-5 flex items-start gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-900 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          <p>
            <strong className="font-medium">{data.variants.find((v) => v.variant === data.confident!.variant)?.name}</strong> has a {percent(data.confident.probability)} probability to have the best {METRIC_LABEL[data.primaryMetric].toLowerCase()} rate.
            {data.status === "running" ? " Stop the experiment and roll it out when you are ready." : ""}
          </p>
        </div>
      )}
      <Card className="mt-5 overflow-hidden">
        <CardHeader
          title={
            <span className="inline-flex flex-wrap items-center gap-2">
              Results
              {data.frozen && <Badge tone="blue">Final</Badge>}
              {data.approximate && (
                <Badge tone="amber" title={data.notes.join(" ")}>
                  Approximate
                </Badge>
              )}
            </span>
          }
          description={
            <>
              {data.from ? `${date(data.from)} – ${data.to ? date(data.to) : "now"}` : ""} · {data.daysRunning} days · conversions after each install&rsquo;s first exposure · {data.frozen ? "computed" : "updated"} {ago(data.generatedAt)}
              {!data.frozen && " (every few hours)"}
            </>
          }
          action={
            <div className="flex items-center gap-2">
              {!data.frozen && (
                <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={refreshing} onClick={refresh} title="Recompute now (at most once an hour)">
                  Refresh
                </Button>
              )}
              <Segmented size="sm" label="Probability metric" options={[{ value: "trial_started" as const, label: "Trial started" }, { value: "paid" as const, label: "Paid" }]} value={metric} onChange={setMetric} />
            </div>
          }
        />
        <Table>
          <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
            <tr>
              <th className={th}>Variant</th>
              <th className={cn(th, "text-right")}>Exposed</th>
              <th className={cn(th, "text-right")}>Trial %</th>
              <th className={cn(th, "text-right")}>Paid %</th>
              <th className={cn(th, "text-right")}>Revenue / install</th>
              <th className={cn(th, "text-right")}>P(best) {metric === "paid" ? "paid" : "trial"}</th>
              <th className={th}>Lift vs control (95% interval)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {data.variants.map((v) => {
              const p = v.probabilityBest[metric];
              const lift = v.lift[metric];
              return (
                <tr key={v.variant} className={cn(!data.enoughData && "[&_.prob]:text-zinc-400")}>
                  <td className={td}>
                    <span className="font-mono text-xs text-zinc-400">{v.variant}</span> <span className="text-sm font-medium">{v.name}</span>
                    <span className="ml-1.5 text-xs text-zinc-500">{Math.round(v.weight * 10) / 10}%</span>
                  </td>
                  <td className={cn(td, "text-right tabular-nums")}>{fullNumber(v.exposed)}</td>
                  <td className={cn(td, "text-right tabular-nums")}>
                    {v.trialRate === null ? "—" : percent(v.trialRate)}
                    {measured && <span className="block text-xs text-zinc-500">{fullNumber(v.trials)}</span>}
                  </td>
                  <td className={cn(td, "text-right tabular-nums")}>
                    {v.paidRate === null ? "—" : percent(v.paidRate)}
                    {measured && <span className="block text-xs text-zinc-500">{fullNumber(v.paid)}</span>}
                  </td>
                  <td className={cn(td, "text-right tabular-nums")}>
                    {v.revenuePerInstall === null ? "—" : money(v.revenuePerInstall, data.currency, { cents: true })}
                    {measured && <span className="block text-xs text-zinc-500">{money(v.revenue, data.currency)}</span>}
                  </td>
                  <td className={cn(td, "prob text-right font-medium tabular-nums", data.enoughData && v === leader && (p ?? 0) >= 0.95 && "text-emerald-700 dark:text-emerald-400")}>{p === null ? "—" : percent(p)}</td>
                  <td className={cn(td, "prob")}>{v.variant === control.variant ? <span className="text-xs text-zinc-500">control</span> : <LiftCell lift={lift} />}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        <div className="space-y-1 border-t border-zinc-100 px-5 py-3 text-xs text-zinc-500 dark:border-zinc-800">
          <p>
            Rates have Beta posteriors (uniform prior); P(best) and the lift come from 20,000 seeded Monte Carlo draws. Revenue per install (refunds subtracted, {data.currency}) is a point estimate. Primary metric: {METRIC_LABEL[data.primaryMetric].toLowerCase()}.
          </p>
          {data.notes.map((n) => (
            <p key={n} className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {n}
            </p>
          ))}
          {data.exposureSource === "none" && <p>No exposures yet: RevflareKit 1.7+ sends experiment_exposure when the app reads one of the experiment&rsquo;s parameters.</p>}
        </div>
      </Card>
      <DailyExposure results={data} />
    </>
  );
}

function LiftCell({ lift }: { lift: { expected: number; low: number; high: number } | null }) {
  if (!lift) return <span className="text-zinc-400">—</span>;
  const tone = lift.low > 0 ? "text-emerald-700 dark:text-emerald-400" : lift.high < 0 ? "text-red-700 dark:text-red-400" : "";
  // The interval drawn on a symmetric scale around 0 (clamped to ±100%).
  const max = Math.min(1, Math.max(0.05, Math.abs(lift.low), Math.abs(lift.high)));
  const pos = (x: number) => `${((Math.max(-max, Math.min(max, x)) + max) / (2 * max)) * 100}%`;
  return (
    <div className="flex items-center gap-3">
      <span className={cn("w-16 text-right tabular-nums font-medium", tone)}>{signedPercent(lift.expected)}</span>
      <div className="relative h-4 w-28" aria-hidden>
        <div className="absolute top-1/2 h-px w-full bg-zinc-200 dark:bg-zinc-700" />
        <div className="absolute top-0.5 h-3 w-px bg-zinc-400" style={{ left: "50%" }} />
        <div className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-[var(--viz-1)] opacity-60" style={{ left: pos(lift.low), width: `calc(${pos(lift.high)} - ${pos(lift.low)})` }} />
        <div className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--viz-1)]" style={{ left: pos(lift.expected) }} />
      </div>
      <span className="text-xs tabular-nums text-zinc-500">
        {signedPercent(lift.low)} to {signedPercent(lift.high)}
      </span>
    </div>
  );
}

function DailyExposure({ results }: { results: ExperimentResults }) {
  const { dates, series } = useMemo(() => {
    if (!results.daily.length) return { dates: [] as string[], series: [] };
    const days = results.daily.map((d) => d.day).sort();
    const dates: string[] = [];
    for (let t = Date.parse(`${days[0]}T00:00:00Z`), end = Date.parse(`${days[days.length - 1]}T00:00:00Z`); t <= end; t += DAY) dates.push(new Date(t).toISOString().slice(0, 10));
    const series = results.variants.map((v, i) => {
      const by = new Map(results.daily.filter((d) => d.variant === v.variant).map((d) => [d.day, d.exposed]));
      return { key: v.variant, label: `${v.variant.toUpperCase()} · ${v.name}`, color: PALETTE[i % PALETTE.length], values: dates.map((d) => by.get(d) ?? 0) };
    });
    return { dates, series };
  }, [results]);
  return (
    <Card className="mt-5">
      <CardHeader title="Daily exposed installs" description="Distinct installs per variant and UTC day that sent experiment_exposure (daily snapshot, from 02:00 UTC)." />
      {dates.length === 0 ? (
        <p className="border-t border-zinc-100 px-5 py-4 text-sm text-zinc-500 dark:border-zinc-800">No snapshot yet: the first one is taken the day after the start.</p>
      ) : (
        <div className="px-3 pb-4">
          <Legend className="mb-3 px-2" items={series.map((s) => ({ key: s.key, label: s.label, color: s.color, line: true }))} />
          <TimeChart dates={dates} interval="day" type="line" series={series} height={220} formatValue={(v) => fullNumber(v)} formatAxis={(v) => compactNumber(v)} label="Daily exposed installs per variant" />
        </div>
      )}
    </Card>
  );
}

// --- Rollout -----------------------------------------------------------------------------------------------------------

function RolloutDialog({ e, onClose, onConfirm, busy }: { e: Experiment; onClose: () => void; onConfirm: (variant: string) => void; busy: boolean }) {
  const [variant, setVariant] = useState(e.variants.length > 1 ? e.variants[1].id : "a");
  const v = e.variants.find((x) => x.id === variant)!;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Roll out a variant of "${e.name}"`}
      description="The variant's values become the parameters' defaults (conditional values stay), the experiment ends and every device gets the new defaults at its next fetch."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Rocket className="size-4" />} loading={busy} onClick={() => onConfirm(variant)}>
            Roll out {v.name}
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-5">
        <Field label="Variant">
          {(fid) => (
            <Select id={fid} data-autofocus value={variant} onChange={(ev) => setVariant(ev.target.value)}>
              {e.variants.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.id.toUpperCase()} · {x.name}
                  {x.id === "a" ? " (control)" : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="rounded-xl ring-1 ring-zinc-200 dark:ring-zinc-700">
          <p className="border-b border-zinc-100 px-4 py-2 text-xs font-medium text-zinc-500 dark:border-zinc-800">New defaults</p>
          <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
            {e.keys.map((k) => (
              <li key={k} className="flex items-center gap-3 px-4 py-2">
                <span className="font-mono text-xs">{k}</span>
                <span className="min-w-0 flex-1 truncate text-right font-mono text-xs text-zinc-600 dark:text-zinc-400">{k in v.values ? showValue(v.values[k]) : <span className="font-sans text-zinc-500">unchanged (current default)</span>}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Dialog>
  );
}

// --- Editor -----------------------------------------------------------------------------------------------------------

interface VariantDraft {
  name: string;
  weight: string;
  /** key → draft text; missing on the control = keep the current value. */
  values: Record<string, string>;
}

function ExperimentEditor({
  appId,
  config,
  initial,
  others,
  onClose,
  onSaved,
}: {
  appId: string;
  config: RemoteConfig;
  initial?: Experiment;
  others: Experiment[];
  onClose: () => void;
  onSaved: (x: Experiment) => void;
}) {
  const toast = useToast();
  const types = useMemo(() => new Map(config.parameters.map((p) => [p.key, p.type])), [config]);
  // Parameters of running / stopped experiments cannot be started in another one.
  const taken = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of others) if ((o.status === "running" || o.status === "stopped") && o.id !== initial?.id) for (const k of o.keys) m.set(k, o.name);
    return m;
  }, [others, initial]);
  const [name, setName] = useState(initial?.name ?? "");
  const [hypothesis, setHypothesis] = useState(initial?.hypothesis ?? "");
  const [keys, setKeys] = useState<string[]>(initial?.keys.filter((k) => types.has(k)) ?? []);
  const [variants, setVariants] = useState<VariantDraft[]>(() =>
    initial
      ? initial.variants.map((v) => ({
          name: v.name,
          weight: String(v.weight),
          values: Object.fromEntries(Object.entries(v.values).filter(([k]) => types.has(k)).map(([k, val]) => [k, toDraft(types.get(k)!, val)])),
        }))
      : [
          { name: "Control", weight: "50", values: {} },
          { name: "Variant B", weight: "50", values: {} },
        ],
  );
  const [targeting, setTargeting] = useState(initial?.targeting ?? "");
  const [traffic, setTraffic] = useState(String(initial?.traffic ?? 100));
  const [metric, setMetric] = useState<ExperimentMetric>(initial?.primaryMetric ?? "paid");
  const [busy, setBusy] = useState(false);

  const typeOf = (k: string): RemoteConfigValueType => types.get(k) ?? "string";
  const defaultDraft = (k: string) => {
    const p = config.parameters.find((x) => x.key === k);
    return toDraft(typeOf(k), p && !p.useInAppDefault ? p.defaultValue : undefined);
  };
  const toggleKey = (k: string) => {
    if (keys.includes(k)) {
      setKeys(keys.filter((x) => x !== k));
      setVariants((vs) => vs.map((v) => ({ ...v, values: Object.fromEntries(Object.entries(v.values).filter(([x]) => x !== k)) })));
    } else {
      setKeys([...keys, k]);
      // Non-control variants start from the current default.
      setVariants((vs) => vs.map((v, i) => (i === 0 ? v : { ...v, values: { ...v.values, [k]: defaultDraft(k) } })));
    }
  };
  const setVariant = (i: number, patch: Partial<VariantDraft>) => setVariants((vs) => vs.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const evenSplit = (vs: VariantDraft[]) => {
    const w = Math.floor((100 / vs.length) * 100) / 100;
    return vs.map((v, i) => ({ ...v, weight: String(i === vs.length - 1 ? Math.round((100 - w * (vs.length - 1)) * 100) / 100 : w) }));
  };
  const addVariant = () =>
    setVariants((vs) => evenSplit([...vs, { name: `Variant ${VARIANT_IDS[vs.length].toUpperCase()}`, weight: "0", values: Object.fromEntries(keys.map((k) => [k, defaultDraft(k)])) }]));
  const removeVariant = (i: number) => setVariants((vs) => evenSplit(vs.filter((_, j) => j !== i)));

  // Validation (the server validates again).
  const parsed = variants.map((v, i) =>
    Object.fromEntries(keys.filter((k) => i > 0 || k in v.values).map((k) => [k, fromDraft(typeOf(k), v.values[k] ?? "")] as const)),
  );
  const weights = variants.map((v) => Number(v.weight));
  const sum = Math.round(weights.reduce((s, w) => s + (Number.isFinite(w) ? w : 0), 0) * 1000) / 1000;
  const weightError = weights.some((w) => !Number.isFinite(w) || w <= 0) ? "Every weight must be above 0" : Math.abs(sum - 100) > 1e-3 ? `Weights sum to ${sum}, not 100` : null;
  const trafficN = Number(traffic);
  const trafficError = !Number.isFinite(trafficN) || trafficN <= 0 || trafficN > 100 ? "Above 0 and at most 100" : null;
  const nameError = !name.trim() ? "Required" : null;
  const keysError = keys.length === 0 ? "Pick at least one parameter" : keys.length > EXPERIMENT_LIMITS.maxKeys ? `At most ${EXPERIMENT_LIMITS.maxKeys}` : null;
  const valueErrors = parsed.some((p) => Object.values(p).some((x) => "error" in x));
  const invalid = !!nameError || !!keysError || !!weightError || !!trafficError || valueErrors;

  const submit = async () => {
    const body: ExperimentInput = {
      name: name.trim(),
      hypothesis: hypothesis.trim() || null,
      keys,
      variants: variants.map((v, i) => ({
        id: VARIANT_IDS[i],
        name: v.name.trim() || undefined,
        weight: Number(v.weight),
        values: Object.fromEntries(Object.entries(parsed[i]).map(([k, x]) => [k, (x as { value: unknown }).value])),
      })),
      targeting: targeting || null,
      traffic: trafficN,
      primaryMetric: metric,
    };
    setBusy(true);
    try {
      const x = initial ? await api.apps.experiments.update(appId, initial.id, body) : await api.apps.experiments.create(appId, body);
      toast.success(initial ? "Experiment saved" : "Draft created");
      onSaved(x);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const conditions = config.conditions.filter((c) => !c.unsupported);
  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={initial ? `Edit ${initial.name}` : "New experiment"}
      description="Saved as a draft: start it from its page. Variant A is the control."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={invalid} onClick={submit}>
            {initial ? "Save" : "Create draft"}
          </Button>
        </>
      }
    >
      <div className="space-y-5 p-5">
        <Field label="Name" required error={name && nameError}>
          {(fid) => <Input id={fid} data-autofocus maxLength={100} placeholder="Paywall headline" value={name} onChange={(ev) => setName(ev.target.value)} />}
        </Field>
        <Field label="Hypothesis" help="Optional: what you expect and why.">
          {(fid) => <Textarea id={fid} rows={2} maxLength={1000} placeholder="A bolder headline raises paid conversion." value={hypothesis} onChange={(ev) => setHypothesis(ev.target.value)} />}
        </Field>

        <div>
          <p className="mb-1.5 text-sm font-medium">Parameters</p>
          <div className="max-h-44 overflow-auto rounded-xl ring-1 ring-zinc-200 dark:ring-zinc-700">
            {config.parameters.map((p) => {
              const other = taken.get(p.key);
              return (
                <label key={p.key} className={cn("flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60", other ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
                  <Checkbox checked={keys.includes(p.key)} disabled={!!other && !keys.includes(p.key)} onChange={() => toggleKey(p.key)} />
                  <span className="font-mono text-xs">{p.key}</span>
                  <Badge>{p.type}</Badge>
                  {other && <span className="text-xs text-zinc-500">in experiment &ldquo;{other}&rdquo;</span>}
                </label>
              );
            })}
          </div>
          {keysError && keys.length === 0 ? <p className="mt-1.5 text-xs text-zinc-500">{keysError}.</p> : keysError && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{keysError}</p>}
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Variants</p>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setVariants((vs) => evenSplit(vs))}>
                Even split
              </Button>
              <Button size="sm" icon={<Plus className="size-3.5" />} disabled={variants.length >= EXPERIMENT_LIMITS.maxVariants} onClick={addVariant}>
                Add variant
              </Button>
            </div>
          </div>
          <div className="divide-y divide-zinc-100 rounded-xl ring-1 ring-zinc-200 dark:divide-zinc-800 dark:ring-zinc-700">
            {variants.map((v, i) => (
              <div key={i} className="space-y-3 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-5 font-mono text-xs text-zinc-400">{VARIANT_IDS[i]}</span>
                  <Input aria-label={`Variant ${VARIANT_IDS[i]} name`} className="w-52" maxLength={60} value={v.name} onChange={(ev) => setVariant(i, { name: ev.target.value })} />
                  {i === 0 && <span className="text-xs text-zinc-500">control</span>}
                  <div className="flex-1" />
                  <Input aria-label={`Variant ${VARIANT_IDS[i]} weight`} className="w-20 text-right" inputMode="decimal" value={v.weight} invalid={!(Number(v.weight) > 0)} onChange={(ev) => setVariant(i, { weight: ev.target.value })} />
                  <span className="text-sm text-zinc-500">%</span>
                  {i >= EXPERIMENT_LIMITS.minVariants && (
                    <IconButton label="Remove variant" size="sm" variant="danger" onClick={() => removeVariant(i)}>
                      <Trash2 className="size-4" />
                    </IconButton>
                  )}
                </div>
                {keys.map((k) => {
                  const keep = i === 0 && !(k in v.values);
                  const err = parsed[i][k] && "error" in parsed[i][k] ? (parsed[i][k] as { error: string }).error : null;
                  return (
                    <div key={k} className="grid gap-1.5 pl-7 sm:grid-cols-[10rem_1fr] sm:items-start">
                      <div className="pt-2">
                        <p className="truncate font-mono text-xs" title={k}>
                          {k}
                        </p>
                        {i === 0 && (
                          <label className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
                            <Checkbox
                              checked={keep}
                              onChange={(ev) =>
                                setVariant(0, {
                                  values: ev.target.checked ? Object.fromEntries(Object.entries(v.values).filter(([x]) => x !== k)) : { ...v.values, [k]: defaultDraft(k) },
                                })
                              }
                            />
                            Current value
                          </label>
                        )}
                      </div>
                      <div>
                        {keep ? (
                          <p className="rounded-lg px-3 py-2 text-xs text-zinc-500 ring-1 ring-zinc-200 dark:ring-zinc-700">Devices keep the value they get anyway (default or condition).</p>
                        ) : (
                          <ValueInput type={typeOf(k)} value={v.values[k] ?? ""} onChange={(t) => setVariant(i, { values: { ...v.values, [k]: t } })} label={`${k} for variant ${VARIANT_IDS[i]}`} invalid={!!err} />
                        )}
                        {err && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{err}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <p className={cn("mt-1.5 text-xs", weightError ? "text-red-600 dark:text-red-400" : "text-zinc-500")}>{weightError ?? `Weights sum to 100.`}</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Targeting" help="Only devices matching this condition enroll.">
            {(fid) => (
              <Select id={fid} value={targeting} onChange={(ev) => setTargeting(ev.target.value)}>
                <option value="">Every device</option>
                {conditions.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Traffic %" error={trafficError} help="Of the matching devices.">
            {(fid) => <Input id={fid} inputMode="decimal" value={traffic} invalid={!!trafficError} onChange={(ev) => setTraffic(ev.target.value)} />}
          </Field>
          <Field label="Primary metric" help="Decides the guardrail and the alert.">
            {(fid) => (
              <Select id={fid} value={metric} onChange={(ev) => setMetric(ev.target.value as ExperimentMetric)}>
                {EXPERIMENT_METRICS.map((m) => (
                  <option key={m} value={m}>
                    {METRIC_LABEL[m]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
