import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowDown, ArrowUp, ChevronRight, Filter, Pencil, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { FUNNEL_BREAKDOWNS, type Funnel, type FunnelAlertSensitivity, type FunnelAlertSettings, type FunnelReportStep, type FunnelStep, type RevenueStepKind } from "@shared/types";
import { Button, IconButton } from "../components/ui/Button";
import { useConfirm } from "../components/ui/Confirm";
import { Dialog } from "../components/ui/Dialog";
import { Field, Input, Select, Switch } from "../components/ui/Form";
import { Badge, Card, CardHeader, EmptyState, ErrorState, PageHeader, Segmented, Skeleton, Table, td, th } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { cn, fullNumber, percent } from "../lib/format";
import { useSession } from "../lib/session";
import { useFetch } from "../lib/useFetch";
import { AnalyticsSetup, BackToApp, IncludeTestToggle, notConfigured, RANGES, type Range } from "./EventsPage";

const REVENUE_LABEL: Record<RevenueStepKind, string> = { trial_started: "Trial started", paid: "Paid purchase", any_purchase: "Any purchase" };
const WINDOWS = [
  { value: 3600, label: "1 hour" },
  { value: 86_400, label: "1 day" },
  { value: 7 * 86_400, label: "7 days" },
  { value: 14 * 86_400, label: "14 days" },
  { value: 30 * 86_400, label: "30 days" },
];
const BREAKDOWN_LABEL: Record<string, string> = { app_version: "App version", os_version: "OS version", country: "Country", locale: "Locale" };

export function duration(s: number | null | undefined): string {
  if (s === null || s === undefined) return "-";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${+(s / 3600).toFixed(1)}h`;
  return `${+(s / 86_400).toFixed(1)}d`;
}

function stepText(s: FunnelStep): string {
  if (s.label) return s.label;
  if (s.type === "revenue") return REVENUE_LABEL[s.kind];
  return s.filters?.length ? `${s.name} (${s.filters.map((f) => `${f.key}=${f.value}`).join(", ")})` : s.name;
}

// --- Editor -----------------------------------------------------------------------------------------------------------

interface DraftStep {
  type: "event" | "revenue";
  name: string;
  filters: string;
  kind: RevenueStepKind;
}

const toDraft = (s: FunnelStep): DraftStep =>
  s.type === "revenue" ? { type: "revenue", name: "", filters: "", kind: s.kind } : { type: "event", name: s.name, filters: (s.filters ?? []).map((f) => `${f.key}=${f.value}`).join(", "), kind: "trial_started" };

function fromDraft(d: DraftStep): FunnelStep {
  if (d.type === "revenue") return { type: "revenue", kind: d.kind };
  const filters = d.filters
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf("=");
      return { key: (i < 0 ? p : p.slice(0, i)).trim(), value: i < 0 ? "" : p.slice(i + 1).trim() };
    });
  return { type: "event", name: d.name.trim(), ...(filters.length ? { filters } : {}) };
}

function FunnelEditor({ appId, funnel, open, onClose, onSaved }: { appId: string; funnel: Funnel | null; open: boolean; onClose: () => void; onSaved: (f: Funnel) => void }) {
  const toast = useToast();
  const [name, setName] = useState(funnel?.name ?? "");
  const [steps, setSteps] = useState<DraftStep[]>(
    funnel?.steps.map(toDraft) ?? [
      { type: "event", name: "", filters: "", kind: "trial_started" },
      { type: "event", name: "", filters: "", kind: "trial_started" },
    ],
  );
  const [windowSeconds, setWindow] = useState(funnel?.windowSeconds ?? 7 * 86_400);
  const [ordered, setOrdered] = useState(funnel?.ordered ?? true);
  const [busy, setBusy] = useState(false);
  const names = useFetch(open ? `events:${appId}:30d` : null, () => api.apps.analytics.summary(appId, "30d"));
  const listId = `event-names-${appId}`;

  const update = (i: number, patch: Partial<DraftStep>) => setSteps((s) => s.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const move = (i: number, d: -1 | 1) =>
    setSteps((s) => {
      const n = [...s];
      [n[i], n[i + d]] = [n[i + d], n[i]];
      return n;
    });
  const save = async () => {
    setBusy(true);
    try {
      const body = { name, steps: steps.map(fromDraft), windowSeconds, ordered };
      const f = funnel ? await api.apps.funnels.update(appId, funnel.id, body) : await api.apps.funnels.create(appId, body);
      toast.success(funnel ? "Funnel saved" : "Funnel created");
      onSaved(f);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const windowOptions = WINDOWS.some((w) => w.value === windowSeconds) ? WINDOWS : [...WINDOWS, { value: windowSeconds, label: duration(windowSeconds) }];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={funnel ? "Edit funnel" : "New funnel"}
      description="Steps in order. The first step is an event; revenue steps come from Revflare's own sales of the install (purchases made with appAccountToken = Revflare.installId)."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={save} disabled={!name.trim() || steps.length < 2}>
            {funnel ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          {(id) => <Input id={id} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="Onboarding to trial" />}
        </Field>
        <datalist id={listId}>
          {names.data?.events.map((e) => (
            <option key={e.name} value={e.name} />
          ))}
        </datalist>
        <ol className="space-y-2">
          {steps.map((s, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800">
              <span className="w-5 text-center text-xs font-semibold text-zinc-500 tabular-nums">{i + 1}</span>
              <Select aria-label="Step type" className="w-28" value={s.type} disabled={i === 0} onChange={(e) => update(i, { type: e.target.value as DraftStep["type"] })}>
                <option value="event">Event</option>
                <option value="revenue">Revenue</option>
              </Select>
              {s.type === "event" ? (
                <>
                  <Input aria-label="Event name" list={listId} className="min-w-0 flex-1 font-mono text-xs" placeholder="paywall_view" value={s.name} onChange={(e) => update(i, { name: e.target.value })} />
                  <Input aria-label="Property filters" className="min-w-0 flex-1 font-mono text-xs" placeholder="filters: step=1, placement=onboarding" value={s.filters} onChange={(e) => update(i, { filters: e.target.value })} />
                </>
              ) : (
                <Select aria-label="Revenue step" className="min-w-0 flex-1" value={s.kind} onChange={(e) => update(i, { kind: e.target.value as RevenueStepKind })}>
                  {Object.entries(REVENUE_LABEL).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </Select>
              )}
              <IconButton label="Move up" disabled={i === 0 || (i === 1 && steps[1].type === "revenue")} onClick={() => move(i, -1)}>
                <ArrowUp className="size-4" />
              </IconButton>
              <IconButton label="Move down" disabled={i === steps.length - 1 || (i === 0 && steps[1].type === "revenue")} onClick={() => move(i, 1)}>
                <ArrowDown className="size-4" />
              </IconButton>
              <IconButton label="Remove step" disabled={steps.length <= 2} onClick={() => setSteps((x) => x.filter((_, k) => k !== i))}>
                <X className="size-4" />
              </IconButton>
            </li>
          ))}
        </ol>
        <Button size="sm" icon={<Plus className="size-4" />} disabled={steps.length >= 10} onClick={() => setSteps((x) => [...x, { type: "event", name: "", filters: "", kind: "trial_started" }])}>
          Add step
        </Button>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Conversion window" help="Each step must happen within this time after the first step.">
            {(id) => (
              <Select id={id} value={windowSeconds} onChange={(e) => setWindow(Number(e.target.value))}>
                {windowOptions.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Strict order" help={ordered ? "Each step after the previous one." : "Steps after the first in any order."}>
            {(id) => <Switch id={id} checked={ordered} onChange={setOrdered} label="Strict order" />}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

// --- List -------------------------------------------------------------------------------------------------------------

/** Apps → app → Funnels: the app's funnels and a new-funnel dialog. */
export function FunnelsPage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const navigate = useNavigate();
  const app = useFetch(`app:${id}`, () => api.apps.get(id), { tags: ["apps"] });
  const status = useFetch(`analytics-status:${id}`, () => api.apps.analytics.status(id), { tags: ["apps"] });
  const list = useFetch(`funnels:${id}`, () => api.apps.funnels.list(id));
  const [creating, setCreating] = useState(false);

  return (
    <>
      <BackToApp id={id} name={app.data?.name} />
      <PageHeader
        title="Funnels"
        description="Where users drop off: onboarding, paywall, trial and purchase steps from RevflareKit events and Revflare's sales."
        actions={
          <>
            <Link to={`/apps/${id}/events`} className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
              Events
            </Link>
            {can("manage") && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                New funnel
              </Button>
            )}
          </>
        }
      />
      {status.data && <AnalyticsSetup status={status.data} />}
      {list.error && <ErrorState error={list.error} onRetry={list.refetch} />}
      {!list.data && !list.error && <Skeleton className="h-40" />}
      {list.data && (
        <Card className="overflow-hidden">
          {!list.data.items.length ? (
            <EmptyState
              icon={<Filter />}
              title="No funnels yet"
              description="A funnel is a sequence of steps, e.g. onboarding_step (step=1) → paywall_view → trial started."
              action={
                can("manage") ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    Create a funnel
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {list.data.items.map((f) => (
                <li key={f.id}>
                  <Link to={`/apps/${id}/funnels/${f.id}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                    <Filter className="size-4 text-brand-600 dark:text-brand-400" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{f.name}</p>
                      <p className="truncate text-xs text-zinc-500">{f.steps.map(stepText).join(" → ")}</p>
                    </div>
                    <Badge>{duration(f.windowSeconds)}</Badge>
                    {!f.ordered && <Badge tone="blue">any order</Badge>}
                    <ChevronRight className="size-4 text-zinc-400" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {creating && (
        <FunnelEditor
          appId={id}
          funnel={null}
          open
          onClose={() => setCreating(false)}
          onSaved={(f) => {
            setCreating(false);
            list.refetch();
            navigate(`/apps/${id}/funnels/${f.id}`);
          }}
        />
      )}
    </>
  );
}

// --- Report -----------------------------------------------------------------------------------------------------------

/** Horizontal funnel: one bar per step (share of the first step), with drop-off and median time between steps. */
function FunnelBars({ steps }: { steps: FunnelReportStep[] }) {
  return (
    <ol className="space-y-1" aria-label="Funnel steps">
      {steps.map((s) => (
        <li key={s.index}>
          {s.index > 0 && (
            <p className="py-1 pl-8 text-xs text-zinc-500">
              <span className="tabular-nums">{percent(s.conversionFromPrevious)}</span> converted · <span className="tabular-nums">{fullNumber(s.dropOff)}</span> dropped off
              {s.medianSecondsFromPrevious !== null && <> · median {duration(s.medianSecondsFromPrevious)}</>}
            </p>
          )}
          <div className="flex items-center gap-3" title={`${s.label}: ${fullNumber(s.users)} users, ${percent(s.conversionFromFirst)} of step 1`}>
            <span className="w-5 text-right text-xs font-semibold text-zinc-500 tabular-nums">{s.index + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate font-medium">{s.label}</span>
                <span className="shrink-0 tabular-nums">
                  <strong>{fullNumber(s.users)}</strong> <span className="text-zinc-500">· {percent(s.conversionFromFirst)}</span>
                </span>
              </div>
              <div className="h-6 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
                <div className="h-full rounded" style={{ width: `${Math.max(s.users ? 0.5 : 0, s.conversionFromFirst * 100)}%`, background: "var(--viz-1)" }} />
              </div>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Apps → app → Funnels → one funnel: report with range and breakdown, edit, delete. */
export function FunnelReportPage() {
  const { id = "", fid = "" } = useParams();
  const { can } = useSession();
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const [range, setRange] = useState<Range>("30d");
  const [breakdown, setBreakdown] = useState<string>("");
  const [includeTest, setIncludeTest] = useState(false);
  const [editing, setEditing] = useState(false);
  const app = useFetch(`app:${id}`, () => api.apps.get(id), { tags: ["apps"] });
  const funnel = useFetch(`funnel:${id}:${fid}`, () => api.apps.funnels.get(id, fid));
  const status = useFetch(`analytics-status:${id}`, () => api.apps.analytics.status(id), { tags: ["apps"] });
  const f = funnel.data;
  const report = useFetch(f && status.data?.query ? `funnel-report:${fid}:${f.updatedAt}:${range}:${breakdown}:${includeTest}` : null, () =>
    api.apps.funnels.report(id, fid, { range, breakdown: breakdown || null, includeTest: includeTest ? "true" : undefined }),
  );
  const r = report.data;

  const remove = async () => {
    if (!f) return;
    const ok = await confirm({ title: `Delete "${f.name}"?`, message: "The funnel definition is deleted; the events stay.", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      await api.apps.funnels.remove(id, f.id);
      toast.success("Funnel deleted");
      navigate(`/apps/${id}/funnels`);
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <>
      <BackToApp id={id} name={app.data?.name} />
      {funnel.error && <ErrorState error={funnel.error} onRetry={funnel.refetch} />}
      {!f && !funnel.error && <Skeleton className="h-64" />}
      {f && (
        <>
          <PageHeader
            title={f.name}
            description={`${f.ordered ? "Steps in order" : "Steps after the first in any order"}, within ${duration(f.windowSeconds)} of the first step. Entry days are UTC.`}
            actions={
              <>
                <Link to={`/apps/${id}/funnels`} className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
                  All funnels
                </Link>
                {can("manage") && (
                  <>
                    <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
                      Edit
                    </Button>
                    <Button variant="outline" icon={<Trash2 className="size-4" />} onClick={remove}>
                      Delete
                    </Button>
                  </>
                )}
              </>
            }
          />
          {status.data && <AnalyticsSetup status={status.data} />}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Segmented label="Entry range" options={RANGES.map((x) => ({ ...x }))} value={range} onChange={setRange} />
            <Select aria-label="Breakdown" className="w-48" value={breakdown} onChange={(e) => setBreakdown(e.target.value)}>
              <option value="">No breakdown</option>
              {FUNNEL_BREAKDOWNS.map((b) => (
                <option key={b} value={b}>
                  By {BREAKDOWN_LABEL[b] ?? b}
                </option>
              ))}
            </Select>
            <IncludeTestToggle appId={id} value={includeTest} onChange={setIncludeTest} />
            {r?.source === "exact" && (
              <Badge tone="green" title="Every event step comes from key events stored exactly in the database (not sampled).">
                Exact
              </Badge>
            )}
            {r?.approximate && (
              <Badge tone="amber" icon={<TriangleAlert className="size-3.5" />} title={r.notes.join("\n")}>
                Approximate
              </Badge>
            )}
          </div>
          <p className="-mt-2 mb-4 text-xs text-zinc-500">
            {includeTest ? "Test data included (sandbox / Xcode builds, test devices)." : "Production data only: sandbox / Xcode builds and test devices are excluded."}
          </p>
          {report.error && !notConfigured(report.error) && <ErrorState error={report.error} onRetry={report.refetch} />}
          {status.data?.query && !r && !report.error && <Skeleton className="h-72" />}
          {r && (
            <>
              <Card className="mb-5 p-5">
                {r.steps[0]?.users ? (
                  <FunnelBars steps={r.steps} />
                ) : (
                  <EmptyState icon={<Filter />} title="Nobody entered this funnel" description={`No install did "${r.steps[0]?.label}" between ${r.from} and ${r.to}.`} />
                )}
                {r.notes.length > 0 && (
                  <ul className="mt-4 space-y-1 border-t border-zinc-100 pt-3 text-xs text-amber-700 dark:border-zinc-800 dark:text-amber-400">
                    {r.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                )}
              </Card>
              {r.breakdown && r.groups.length > 0 && (
                <Card className="overflow-hidden">
                  <CardHeader title={`By ${BREAKDOWN_LABEL[r.breakdown] ?? r.breakdown}`} description="Value at the first step. Users per step and share of the first step." />
                  <Table>
                    <thead>
                      <tr className="border-y border-zinc-100 text-left dark:border-zinc-800">
                        <th className={th}>{BREAKDOWN_LABEL[r.breakdown] ?? r.breakdown}</th>
                        {r.steps.map((s) => (
                          <th key={s.index} className={`${th} text-right`} title={s.label}>
                            {s.index + 1}. {s.label.length > 18 ? `${s.label.slice(0, 17)}…` : s.label}
                          </th>
                        ))}
                        <th className={`${th} text-right`}>Overall</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {r.groups.map((g) => (
                        <tr key={g.value}>
                          <td className={cn(td, "font-medium")}>{g.value}</td>
                          {g.steps.map((s) => (
                            <td key={s.index} className={`${td} text-right tabular-nums`}>
                              {fullNumber(s.users)}
                              {s.index > 0 && <span className="ml-1 text-xs text-zinc-500">{percent(s.conversionFromFirst)}</span>}
                            </td>
                          ))}
                          <td className={`${td} text-right font-medium tabular-nums`}>{percent(g.steps.at(-1)?.conversionFromFirst ?? 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </Card>
              )}
            </>
          )}
          <FunnelAlertsCard appId={id} funnel={f} canManage={can("manage")} onSaved={(next) => funnel.setData(() => next)} />
          {editing && (
            <FunnelEditor
              appId={id}
              funnel={f}
              open
              onClose={() => setEditing(false)}
              onSaved={() => {
                setEditing(false);
                funnel.refetch();
              }}
            />
          )}
        </>
      )}
    </>
  );
}

const SENSITIVITY_LABEL: Record<FunnelAlertSensitivity, string> = {
  high: "High: drops of 15% or more",
  normal: "Normal: drops of 20% or more",
  low: "Low: drops of 30% or more",
};

/** Funnel anomaly / release regression alerts: on or off, and how sensitive (docs/funnels.md#alerts). */
function FunnelAlertsCard({ appId, funnel, canManage, onSaved }: { appId: string; funnel: Funnel; canManage: boolean; onSaved: (f: Funnel) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const alerts = funnel.alerts ?? { enabled: true, sensitivity: "normal" };
  const save = async (next: Partial<FunnelAlertSettings>) => {
    setBusy(true);
    try {
      onSaved(await api.apps.funnels.update(appId, funnel.id, { alerts: next }));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="mt-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-xl">
          <p className="text-sm font-medium">Alerts</p>
          <p className="mt-1 text-xs text-zinc-500">
            Once a day Revflare compares yesterday&apos;s step-to-step conversions with the 14 days before and the same weekday, and the newest app version with the previous
            one. A significant drop raises an alert in <Link to="/alerts" className="text-brand-700 hover:underline dark:text-brand-400">Alerts</Link> and a
            push (Funnel alerts on your iPhone). Needs at least 100 installs a day at the first step (200 per version).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Select
            aria-label="Alert sensitivity"
            className="w-64"
            value={alerts.sensitivity}
            disabled={!canManage || busy || !alerts.enabled}
            onChange={(e) => void save({ sensitivity: e.target.value as FunnelAlertSensitivity })}
          >
            {(Object.keys(SENSITIVITY_LABEL) as FunnelAlertSensitivity[]).map((k) => (
              <option key={k} value={k}>
                {SENSITIVITY_LABEL[k]}
              </option>
            ))}
          </Select>
          <Switch label="Funnel alerts" checked={alerts.enabled} disabled={!canManage || busy} onChange={(v) => void save({ enabled: v })} />
        </div>
      </div>
    </Card>
  );
}
