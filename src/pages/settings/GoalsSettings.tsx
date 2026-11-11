import { useMemo, useState } from "react";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Bell, ChevronDown, ChevronRight, Pencil, Plus, Target, Trash2 } from "lucide-react";
import { GOAL_METRICS, GOAL_PERIODS, type App, type GoalInput, type GoalMetric, type GoalPeriod, type GoalProgress, type GoalScope } from "@shared/types";
import { AppIcon } from "../../components/Logo";
import { StoreGlyph } from "../../components/Platform";
import { Button, IconButton } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/Confirm";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Field, Input, Select, Switch } from "../../components/ui/Form";
import { Badge, Card, ErrorState, Segmented, Skeleton } from "../../components/ui/Misc";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { useApps } from "../../lib/apps";
import { cn, percent } from "../../lib/format";
import {
  GOAL_METRIC_HELP,
  GOAL_METRIC_LABEL,
  GOAL_PERIOD_LABEL,
  MONEY_METRICS,
  PACE,
  STOCK_METRICS,
  currentPeriodText,
  daysLeftText,
  goalPeriodText,
  goalValue,
  scopeText,
  shortDate,
} from "../../lib/goals";
import { useSession } from "../../lib/session";
import { invalidate, useFetch } from "../../lib/useFetch";
import { Section } from "../SettingsPage";

export function GoalsSettings() {
  const { can, currency } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const r = useFetch("goals", api.goals.list, { tags: ["goals"] });
  const manage = can("manage");
  const cur = r.data?.currency ?? currency;
  const [editing, setEditing] = useState<GoalProgress | "new" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);

  const items = r.data?.items ?? [];
  const active = items.filter((g) => !g.archived);
  const archived = items.filter((g) => g.archived);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      invalidate("goals");
      if (done) toast.success(done);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const move = (i: number, dir: -1 | 1) => {
    const ids = active.map((g) => g.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void run(() => api.goals.reorder([...ids, ...archived.map((g) => g.id)]));
  };

  const remove = async (g: GoalProgress) => {
    if (!(await confirm({ title: `Delete “${g.label}”?`, danger: true, confirmLabel: "Delete", message: "The goal and its progress history go away. Archive it instead to keep it." }))) return;
    void run(() => api.goals.remove(g.id), "Goal deleted");
  };

  const rowProps = { currency: cur, manage, busy, onEdit: setEditing, onDelete: remove };

  return (
    <Section
      title="Goals"
      description="Targets for revenue, MRR, subscriptions, trials or sales over a week, month, quarter, year or custom dates. Shown on the Overview and in the iOS app."
      action={
        manage && (
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
            New goal
          </Button>
        )
      }
    >
      {r.error && <ErrorState error={r.error} onRetry={r.refetch} className="mb-4" />}
      <Card className="overflow-hidden">
        {!r.data ? (
          <Skeleton className="m-5 h-16" />
        ) : active.length === 0 ? (
          <div className="flex items-center gap-3 px-5 py-6 text-sm text-zinc-500">
            <Target className="size-5 text-zinc-300 dark:text-zinc-600" /> {archived.length ? "No active goals." : "No goals yet."}
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {active.map((g, i) => (
              <GoalRow
                key={g.id}
                g={g}
                {...rowProps}
                onArchive={() => run(() => api.goals.update(g.id, { archived: true }), "Goal archived")}
                onUp={i > 0 ? () => move(i, -1) : undefined}
                onDown={i < active.length - 1 ? () => move(i, 1) : undefined}
              />
            ))}
          </ul>
        )}
      </Card>

      {archived.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((v) => !v)}
            className="inline-flex items-center gap-1 text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            {showArchived ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            Archived ({archived.length})
          </button>
          {showArchived && (
            <Card className="mt-2 overflow-hidden">
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {archived.map((g) => (
                  <GoalRow key={g.id} g={g} {...rowProps} onArchive={() => run(() => api.goals.update(g.id, { archived: false }), "Goal restored")} />
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      {editing && <GoalDialog goal={editing === "new" ? null : editing} currency={cur} onClose={() => setEditing(null)} />}
    </Section>
  );
}

const BAR: Record<GoalProgress["pace"], string> = {
  upcoming: "bg-zinc-300 dark:bg-zinc-600",
  on_track: "bg-gradient-to-r from-brand-500 to-amber-500",
  reached: "bg-gradient-to-r from-brand-500 to-amber-500",
  behind: "bg-amber-500",
  missed: "bg-red-500",
};

function GoalRow({
  g,
  currency,
  manage,
  busy,
  onEdit,
  onDelete,
  onArchive,
  onUp,
  onDown,
}: {
  g: GoalProgress;
  currency: string;
  manage: boolean;
  busy: boolean;
  onEdit: (g: GoalProgress) => void;
  onDelete: (g: GoalProgress) => void;
  onArchive: () => void;
  onUp?: () => void;
  onDown?: () => void;
}) {
  const { byId } = useApps();
  const [open, setOpen] = useState(false);
  const v = (x: number) => goalValue(g, x, currency);
  const app = g.scope === "include" && g.appIds.length === 1 ? byId.get(g.appIds[0]) : undefined;
  const pace = PACE[g.pace];
  const showExpected = g.status === "active" && g.target > 0 && g.pace !== "reached";
  const detailsId = `goal-details-${g.id}`;

  return (
    <li className={cn("px-5 py-4", g.archived && "opacity-80")}>
      <div className="flex items-start gap-3">
        {manage && !g.archived && (
          <div className="-ml-2 flex flex-col">
            <IconButton label={`Move “${g.label}” up`} size="sm" disabled={!onUp || busy} onClick={onUp}>
              <ArrowUp className="size-3.5" />
            </IconButton>
            <IconButton label={`Move “${g.label}” down`} size="sm" disabled={!onDown || busy} onClick={onDown}>
              <ArrowDown className="size-3.5" />
            </IconButton>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="truncate text-sm font-semibold">{g.label}</p>
            {!g.archived && <Badge tone={pace.tone}>{pace.label}</Badge>}
            {g.notify && (
              <span title="Push notification when reached" className="text-zinc-400">
                <Bell className="size-3.5" aria-label="Notifies when reached" />
              </span>
            )}
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-zinc-500">
            <span>{GOAL_METRIC_LABEL[g.metric]}</span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              {app && <AppIcon name={app.name} url={app.iconUrl} size={14} />}
              {scopeText(g, byId)}
            </span>
            <span aria-hidden>·</span>
            <span>{goalPeriodText(g)}</span>
          </p>

          <div className="mt-3">
            <div className="flex items-baseline justify-between gap-3 text-sm tabular-nums">
              <span>
                <span className="font-semibold">{v(g.current)}</span>
                <span className="text-zinc-500"> / {v(g.target)}</span>
                <span className="ml-2 text-xs text-zinc-500">{percent(g.progress, 0)}</span>
              </span>
              <span className="text-xs text-zinc-500">
                {currentPeriodText(g)} · {daysLeftText(g)}
              </span>
            </div>
            <div
              className="relative mt-1.5 h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
              role="progressbar"
              aria-label={`${g.label} progress`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(Math.min(1, Math.max(0, g.progress)) * 100)}
            >
              <div className={cn("h-full rounded-full", BAR[g.pace])} style={{ width: `${Math.min(1, Math.max(0, g.progress)) * 100}%` }} />
              {showExpected && (
                <div
                  className="absolute inset-y-0 w-0.5 bg-zinc-900/40 dark:bg-white/50"
                  style={{ left: `${Math.min(1, Math.max(0, g.expected / g.target)) * 100}%` }}
                  title={`Expected by now: ${v(g.expected)}`}
                />
              )}
            </div>
          </div>

          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((o) => !o)}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} Details
          </button>
          {open && <GoalDetails id={detailsId} g={g} currency={currency} />}
        </div>

        {manage && (
          <div className="flex shrink-0 items-center">
            {!g.archived && (
              <IconButton label="Edit goal" disabled={busy} onClick={() => onEdit(g)}>
                <Pencil className="size-4" />
              </IconButton>
            )}
            <IconButton label={g.archived ? "Restore goal" : "Archive goal"} disabled={busy} onClick={onArchive}>
              {g.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
            </IconButton>
            <IconButton label="Delete goal" variant="danger" disabled={busy} onClick={() => onDelete(g)}>
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        )}
      </div>
    </li>
  );
}

function GoalDetails({ id, g, currency }: { id: string; g: GoalProgress; currency: string }) {
  const v = (x: number) => goalValue(g, x, currency);
  const signed = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${v(Math.abs(x))}`;
  const rows: Array<[string, React.ReactNode]> = [
    ["Period", `${currentPeriodText(g)} (${shortDate(g.periodStart)} – ${shortDate(g.periodEnd)})`],
    ["Days", g.status === "upcoming" ? `Starts ${shortDate(g.periodStart)}` : `${Math.min(g.daysElapsed, g.daysTotal)} of ${g.daysTotal} · ${daysLeftText(g)}`],
  ];
  if (g.kind === "stock" && g.startValue != null) {
    rows.push(["Start of period", v(g.startValue)]);
    rows.push(["Change in period", signed(g.current - g.startValue)]);
  }
  if (g.status === "active" && g.pace !== "reached") {
    rows.push(["Expected by now", v(g.expected)]);
    rows.push([g.delta >= 0 ? "Ahead by" : "Behind by", <span className={g.delta >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>{v(Math.abs(g.delta))}</span>]);
  }
  if (g.requiredPerDay != null && g.requiredPerDay > 0) rows.push([g.kind === "stock" ? "Growth needed per day" : "Needed per day", v(g.requiredPerDay)]);
  if (g.kind === "flow" && g.status !== "upcoming") rows.push([g.status === "ended" ? "Final" : "Projected", v(g.status === "ended" ? g.current : g.projected)]);
  if (g.reachedAt) rows.push(["Reached on", shortDate(g.reachedAt)]);
  if (g.previous) {
    const prevText = currentPeriodText({ period: g.period, periodStart: g.previous.periodStart, periodEnd: g.previous.periodEnd });
    rows.push([
      `Previous (${prevText})`,
      <span className="inline-flex items-center gap-1.5">
        {v(g.previous.value)}
        <Badge tone={g.previous.reached ? "green" : "zinc"}>{g.previous.reached ? "Hit" : "Missed"}</Badge>
      </span>,
    ]);
  }
  return (
    <dl id={id} className="mt-2 grid gap-x-6 gap-y-1.5 rounded-lg bg-zinc-50 px-3 py-2.5 text-xs sm:grid-cols-2 dark:bg-zinc-800/50">
      {rows.map(([k, val]) => (
        <div key={k} className="flex justify-between gap-3">
          <dt className="text-zinc-500">{k}</dt>
          <dd className="text-right font-medium tabular-nums">{val}</dd>
        </div>
      ))}
    </dl>
  );
}

function currencySymbol(currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).formatToParts(0).find((p) => p.type === "currency")?.value ?? currency;
  } catch {
    return currency;
  }
}

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function GoalDialog({ goal, currency, onClose }: { goal: GoalProgress | null; currency: string; onClose: () => void }) {
  const { apps } = useApps();
  const toast = useToast();
  const [name, setName] = useState(goal?.name ?? "");
  const [metric, setMetric] = useState<GoalMetric>(goal?.metric ?? "revenue");
  const [target, setTarget] = useState(goal ? String(goal.target) : "");
  const [period, setPeriod] = useState<GoalPeriod>(goal?.period ?? "month");
  const [startDate, setStartDate] = useState(goal?.startDate ?? today());
  const [endDate, setEndDate] = useState(goal?.endDate ?? addDays(today(), 29));
  const [scope, setScope] = useState<GoalScope>(goal?.scope ?? "all");
  const [appIds, setAppIds] = useState<Set<string>>(new Set(goal?.appIds ?? []));
  const [notify, setNotify] = useState(goal?.notify ?? true);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [tried, setTried] = useState(false);

  const isMoney = MONEY_METRICS.has(metric);
  const pickable = useMemo(() => apps.filter((a) => !a.archived || appIds.has(a.id)), [apps, appIds]);
  const shown = filter ? pickable.filter((a) => a.name.toLowerCase().includes(filter.toLowerCase())) : pickable;

  const targetNum = Number(target);
  const errors = {
    target: !(target.trim() && Number.isFinite(targetNum) && targetNum > 0) ? "Enter a target above 0." : null,
    dates:
      period !== "custom"
        ? null
        : !startDate || !endDate
          ? "Pick both dates."
          : endDate < startDate
            ? "The end date must be on or after the start date."
            : (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 + 1 > 731
              ? "A custom period is at most 731 days."
              : null,
    apps: scope !== "all" && appIds.size === 0 ? "Select at least one app." : null,
  };
  const invalid = Object.values(errors).some(Boolean);

  const input = (): GoalInput => {
    const b: GoalInput = {
      name: name.trim() || null,
      metric,
      target: targetNum,
      period,
      startDate: period === "custom" ? startDate : null,
      endDate: period === "custom" ? endDate : null,
      scope,
      appIds: scope === "all" ? [] : [...appIds],
      notify,
    };
    if (!goal) return b;
    // PATCH only what changed (changing what is measured lets the goal notify again this period).
    const changed: GoalInput = {};
    if (b.name !== goal.name) changed.name = b.name;
    if (b.metric !== goal.metric) changed.metric = b.metric;
    if (b.target !== goal.target) changed.target = b.target;
    if (b.period !== goal.period) changed.period = b.period;
    if (b.startDate !== goal.startDate || b.endDate !== goal.endDate) Object.assign(changed, { startDate: b.startDate, endDate: b.endDate });
    if (b.scope !== goal.scope) changed.scope = b.scope;
    if ([...b.appIds!].sort().join() !== [...goal.appIds].sort().join()) changed.appIds = b.appIds;
    if (b.notify !== goal.notify) changed.notify = b.notify;
    return changed;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (invalid) return;
    const body = input();
    if (goal && Object.keys(body).length === 0) return onClose();
    setBusy(true);
    try {
      if (goal) await api.goals.update(goal.id, body);
      else await api.goals.create(body);
      invalidate("goals");
      toast.success(goal ? "Goal saved" : "Goal added");
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const toggleApp = (id: string) =>
    setAppIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={goal ? "Edit goal" : "New goal"}
      description="Targets in the workspace currency for money metrics."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="goal-form" variant="primary" loading={busy}>
            {goal ? "Save" : "Add goal"}
          </Button>
        </>
      }
    >
      <form id="goal-form" onSubmit={submit} className="grid gap-4 p-5 sm:grid-cols-2" noValidate>
        <Field label="Name" help="Optional. Without a name, a label like “Revenue · 3 apps” is used." className="sm:col-span-2">
          {(id) => <Input id={id} data-autofocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q4 revenue push" />}
        </Field>
        <Field label="Metric" help={GOAL_METRIC_HELP[metric]}>
          {(id) => (
            <Select id={id} value={metric} onChange={(e) => setMetric(e.target.value as GoalMetric)}>
              <optgroup label="Money">
                {GOAL_METRICS.filter((m) => MONEY_METRICS.has(m)).map((m) => (
                  <option key={m} value={m}>
                    {GOAL_METRIC_LABEL[m]}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Counts">
                {GOAL_METRICS.filter((m) => !MONEY_METRICS.has(m)).map((m) => (
                  <option key={m} value={m}>
                    {GOAL_METRIC_LABEL[m]}
                  </option>
                ))}
              </optgroup>
            </Select>
          )}
        </Field>
        <Field label={STOCK_METRICS.has(metric) ? "Target level" : "Target for the period"} required error={tried ? errors.target : null}>
          {(id) => (
            <div className="relative">
              {isMoney && (
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-zinc-500">{currencySymbol(currency)}</span>
              )}
              <Input
                id={id}
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder={isMoney ? "10000" : "500"}
                invalid={tried && !!errors.target}
                style={isMoney ? { paddingLeft: `${0.75 + currencySymbol(currency).length * 0.55}rem` } : undefined}
              />
            </div>
          )}
        </Field>
        <Field label="Period" help={period === "custom" ? "Runs once between the two dates (UTC days, inclusive)." : "Starts over every period (UTC days)."}>
          {(id) => (
            <Select id={id} value={period} onChange={(e) => setPeriod(e.target.value as GoalPeriod)}>
              {GOAL_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {GOAL_PERIOD_LABEL[p]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {period === "custom" ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start" error={tried ? errors.dates : null}>
              {(id) => <Input id={id} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} invalid={tried && !!errors.dates} />}
            </Field>
            <Field label="End">
              {(id) => <Input id={id} type="date" value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} invalid={tried && !!errors.dates} />}
            </Field>
          </div>
        ) : (
          <div className="hidden sm:block" />
        )}

        <div className="sm:col-span-2">
          <p className="mb-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-200">Apps</p>
          <Segmented
            label="App scope"
            value={scope}
            onChange={setScope}
            options={[
              { value: "all", label: "All apps" },
              { value: "include", label: "Only selected apps" },
              { value: "exclude", label: "All except" },
            ]}
          />
          {scope !== "all" && (
            <div className="mt-2 rounded-lg ring-1 ring-zinc-200 dark:ring-zinc-800">
              {pickable.length > 8 && (
                <div className="border-b border-zinc-200 p-2 dark:border-zinc-800">
                  <Input aria-label="Filter apps" placeholder="Filter apps" value={filter} onChange={(e) => setFilter(e.target.value)} />
                </div>
              )}
              <ul className="max-h-60 overflow-y-auto py-1" aria-label={scope === "include" ? "Apps to include" : "Apps to exclude"}>
                {shown.length === 0 && <li className="px-3 py-2 text-sm text-zinc-500">No apps.</li>}
                {shown.map((a: App) => (
                  <li key={a.id}>
                    <label className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                      <Checkbox checked={appIds.has(a.id)} onChange={() => toggleApp(a.id)} />
                      <AppIcon name={a.name} url={a.iconUrl} size={20} />
                      <span className="min-w-0 flex-1 truncate">{a.name}</span>
                      {a.archived && <Badge>Archived</Badge>}
                      <StoreGlyph platform={a.platform} className="size-3.5 text-zinc-400" />
                    </label>
                  </li>
                ))}
              </ul>
              <p className="border-t border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 dark:border-zinc-800">
                {appIds.size} selected
                {scope === "exclude" && " · apps added later count toward the goal"}
              </p>
            </div>
          )}
          {tried && errors.apps && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{errors.apps}</p>}
        </div>

        <div className="flex items-start justify-between gap-4 sm:col-span-2">
          <div>
            <label htmlFor="goal-notify" className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
              Notify when reached
            </label>
            <p className="text-xs text-zinc-500">Push to the iOS app when reached, once per period.</p>
          </div>
          <Switch id="goal-notify" checked={notify} onChange={setNotify} label="Notify when reached" />
        </div>
      </form>
    </Dialog>
  );
}
