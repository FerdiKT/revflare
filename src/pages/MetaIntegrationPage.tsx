import { useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, FlaskConical, History, ListChecks, RefreshCw, Save } from "lucide-react";
import type { MetaDelivery, MetaEventType, MetaIntegration, MetaIntegrationUpdate } from "@shared/types";
import { AppIcon } from "../components/Logo";
import { Button } from "../components/ui/Button";
import { useConfirm } from "../components/ui/Confirm";
import { Field, Input, Switch } from "../components/ui/Form";
import { Badge, Card, CardHeader, EmptyState, ErrorState, Skeleton, Stat, Table, td, th } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { ago, cn, dateTime, fullNumber } from "../lib/format";
import { useSession } from "../lib/session";
import { invalidate, useFetch, useNow } from "../lib/useFetch";

const EVENTS: { type: MetaEventType; label: string; help: string }[] = [
  { type: "trial_started", label: "Trial started", help: "Free trial begins (value 0)" },
  { type: "initial_purchase", label: "Initial purchase", help: "First paid period without a trial" },
  { type: "trial_converted", label: "Trial converted", help: "First paid period after a trial" },
  { type: "renewal", label: "Renewal", help: "Every later paid period" },
  { type: "non_subscription_purchase", label: "Non-subscription purchase", help: "Consumables, non-consumables, non-renewing" },
];

const STATUS_TONE: Record<MetaDelivery["status"], "green" | "zinc" | "red"> = { sent: "green", skipped: "zinc", failed: "red" };

/** Apps → app → Integrations → Meta Ads: settings, test event, backfill, stats and the delivery log. */
export function MetaIntegrationPage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const manage = can("manage");
  const app = useFetch(`app:${id}`, () => api.apps.get(id), { tags: ["apps"] });
  const r = useFetch(`meta:${id}`, () => api.apps.meta.get(id), { tags: ["apps"], refreshMs: 60_000 });
  const log = useFetch(`meta-log:${id}`, () => api.apps.meta.log(id), { tags: ["apps"], refreshMs: 60_000 });
  const toast = useToast();
  const confirm = useConfirm();
  const now = useNow(30_000);
  const [busy, setBusy] = useState<string | null>(null);
  const m = r.data;

  const run = async <T,>(name: string, fn: () => Promise<T>, ok: string, desc?: (res: T) => string | undefined) => {
    setBusy(name);
    try {
      const res = await fn();
      toast.success(ok, desc?.(res));
      invalidate("apps");
      return res;
    } catch (err) {
      toast.error(err);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const back = (
    <Link to={`/apps/${id}`} className="mb-4 inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
      <ArrowLeft className="size-4" /> {app.data?.name ?? "App"}
    </Link>
  );
  if (r.error)
    return (
      <>
        {back}
        <ErrorState error={r.error} onRetry={r.refetch} />
      </>
    );
  if (!m)
    return (
      <>
        {back}
        <div className="space-y-5">
          <Skeleton className="h-16" />
          <Skeleton className="h-96" />
          <Skeleton className="h-64" />
        </div>
      </>
    );

  const backfill = async () => {
    const ok = await confirm({
      title: "Queue the last 7 days?",
      message: "Purchases of the last 7 days that were not sent yet (including failed and skipped ones) are queued again and go out with the next cron run. Events already sent are never sent twice.",
      confirmLabel: "Queue them",
    });
    if (ok) await run("backfill", () => api.apps.meta.backfill(id), "Backfill queued", (res) => `${fullNumber(res.queued)} purchases queued`);
  };

  return (
    <>
      {back}
      <div className="mb-6 flex flex-wrap items-center gap-4">
        {app.data && <AppIcon name={app.data.name} url={app.data.iconUrl} size={48} />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Meta Ads</h1>
            <Badge tone={m.enabled ? "green" : "zinc"} dot>
              {m.enabled ? "On" : "Off"}
            </Badge>
          </div>
          <p className="mt-0.5 text-sm text-zinc-500">
            Sends this app&rsquo;s trials, purchases and renewals to Meta&rsquo;s Conversions API as app events, so Meta optimizes campaigns on real revenue. Needs RevflareKit in the app
            (identifiers) — see{" "}
            <a href="https://github.com/FerdiKT/revflare/blob/main/docs/meta-ads.md" target="_blank" rel="noreferrer" className="text-brand-700 hover:underline dark:text-brand-400">
              the setup guide
            </a>
            .
          </p>
        </div>
      </div>

      <Card className="grid grid-cols-2 gap-5 p-5 sm:grid-cols-4">
        <Stat label="Sent" value={fullNumber(m.stats.sent)} sub={m.lastSentAt ? <span title={dateTime(m.lastSentAt)}>last {ago(m.lastSentAt, now)}</span> : "never"} />
        <Stat label="Pending" value={fullNumber(m.stats.pending)} sub="waiting for the install or a retry" />
        <Stat label="Skipped" value={fullNumber(m.stats.skipped)} sub="reason in the log" />
        <Stat label="Failed" value={fullNumber(m.stats.failed)} />
      </Card>
      {m.lastError && <p className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-200 dark:ring-red-900">Last error: {m.lastError}</p>}

      <div className="mt-5 grid gap-5 lg:grid-cols-3 [&>*]:min-w-0">
        <SettingsForm
          key={JSON.stringify(m.events) + m.datasetId + m.testEventCode + m.accessTokenSet + m.enabled + m.sendSandbox + m.sendWithoutAtt}
          m={m}
          manage={manage}
          busy={busy === "save"}
          save={async (b) => {
            const res = await run("save", () => api.apps.meta.update(id, b), "Meta Ads settings saved");
            if (res) r.setData(() => res);
          }}
        />
        <div className="space-y-5">
          <Card>
            <CardHeader title="Test" description="Sends one Subscribe-style test event with your test event code. It shows under Test events in Events Manager within a minute." />
            <div className="px-5 pb-5">
              <Button
                icon={<FlaskConical className="size-4" />}
                loading={busy === "test"}
                disabled={!manage || !m.datasetId || !m.accessTokenSet || !m.testEventCode}
                title={!m.testEventCode ? "Set a test event code first" : undefined}
                onClick={() => run("test", () => api.apps.meta.test(id), "Test event sent", (res) => JSON.stringify(res.response).slice(0, 160))}
              >
                Send test event
              </Button>
              {!m.testEventCode && <p className="mt-2 text-xs text-zinc-500">Copy a test event code from Events Manager → dataset → Test events.</p>}
            </div>
          </Card>
          <Card>
            <CardHeader title="Backfill" description="Queues the purchases of the last 7 days (Meta's limit) that were not sent yet. Runs once automatically when you first turn the integration on." />
            <div className="px-5 pb-5">
              <Button icon={<History className="size-4" />} loading={busy === "backfill"} disabled={!manage || !m.enabled} onClick={backfill}>
                Backfill last 7 days
              </Button>
              {m.backfilledAt && <p className="mt-2 text-xs text-zinc-500">Last backfill {ago(m.backfilledAt, now)}</p>}
            </div>
          </Card>
        </div>
      </div>

      <Card className="mt-5 overflow-hidden">
        <CardHeader
          title="Delivery log"
          description="The last 100 events sent, skipped or failed. Events wait up to 24 h for the install's identifiers before they are skipped."
          action={
            <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => (log.refetch(), r.refetch())}>
              Refresh
            </Button>
          }
        />
        {log.error ? (
          <ErrorState error={log.error} onRetry={log.refetch} className="m-5" />
        ) : !log.data ? (
          <div className="space-y-2 p-5">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : log.data.items.length === 0 ? (
          <EmptyState icon={<ListChecks />} title="Nothing sent yet" description="New purchases show up here a few minutes after they happen." />
        ) : (
          <Table>
            <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
              <tr>
                <th className={th}>Time</th>
                <th className={th}>Event</th>
                <th className={th}>Transaction</th>
                <th className={th}>Status</th>
                <th className={th}>HTTP</th>
                <th className={th}>Response / reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {log.data.items.map((d) => (
                <tr key={d.id}>
                  <td className={cn(td, "text-zinc-600 dark:text-zinc-300")} title={dateTime(d.at)}>
                    {ago(d.at, now)}
                  </td>
                  <td className={td}>
                    <p className="font-medium">{d.eventName ?? "—"}</p>
                    {d.eventType && <p className="text-xs text-zinc-500">{d.eventType}</p>}
                  </td>
                  <td className={cn(td, "font-mono text-xs")}>{d.transactionId}</td>
                  <td className={td}>
                    <Badge tone={STATUS_TONE[d.status]}>{d.status}</Badge>
                  </td>
                  <td className={cn(td, "tabular-nums")}>{d.httpStatus ?? "—"}</td>
                  <td className={cn(td, "max-w-md whitespace-normal break-all text-xs text-zinc-600 dark:text-zinc-400")}>{d.reason ?? d.response ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}

function SettingsForm({ m, manage, busy, save }: { m: MetaIntegration; manage: boolean; busy: boolean; save: (b: MetaIntegrationUpdate) => void }) {
  const [enabled, setEnabled] = useState(m.enabled);
  const [dataset, setDataset] = useState(m.datasetId ?? "");
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [code, setCode] = useState(m.testEventCode ?? "");
  const [sandbox, setSandbox] = useState(m.sendSandbox);
  const [withoutAtt, setWithoutAtt] = useState(m.sendWithoutAtt);
  const [events, setEvents] = useState(() => Object.fromEntries(EVENTS.map((e) => [e.type, { enabled: m.events[e.type].enabled, name: m.events[e.type].name === m.events[e.type].defaultName ? "" : m.events[e.type].name }])) as Record<MetaEventType, { enabled: boolean; name: string }>);
  const badName = (n: string) => n !== "" && !/^[A-Za-z0-9_\- ]{1,40}$/.test(n.trim());
  const invalid = EVENTS.some((e) => badName(events[e.type].name));

  return (
    <Card className="lg:col-span-2">
      <CardHeader title="Settings" description="From Meta Events Manager: the dataset (pixel) of the app and a Conversions API access token (dataset → Settings → Generate access token)." />
      <form
        className="space-y-5 px-5 pb-5"
        onSubmit={(e) => {
          e.preventDefault();
          save({
            enabled,
            datasetId: dataset.trim() || null,
            testEventCode: code.trim() || null,
            sendSandbox: sandbox,
            sendWithoutAtt: withoutAtt,
            ...(token.trim() ? { accessToken: token.trim() } : clearToken ? { accessToken: null } : {}),
            events: Object.fromEntries(EVENTS.map((x) => [x.type, { enabled: events[x.type].enabled, name: events[x.type].name.trim() || null }])),
          });
        }}
      >
        <label className="flex items-center justify-between gap-4 rounded-xl bg-zinc-50 px-4 py-3 ring-1 ring-zinc-200 dark:bg-zinc-800/40 dark:ring-zinc-700">
          <span>
            <span className="block text-sm font-medium">Send events to Meta</span>
            <span className="block text-xs text-zinc-500">New purchases are queued and sent every 5 minutes.</span>
          </span>
          <Switch checked={enabled} onChange={setEnabled} disabled={!manage} label="Send events to Meta" />
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Dataset ID">{(fid) => <Input id={fid} className="font-mono text-xs" inputMode="numeric" placeholder="123456789012345" value={dataset} disabled={!manage} onChange={(e) => setDataset(e.target.value)} />}</Field>
          <Field
            label="Access token"
            help={
              m.accessTokenSet && manage ? (
                <button type="button" className={cn("hover:underline", clearToken && "text-red-600")} onClick={() => (setClearToken(!clearToken), setToken(""))}>
                  {clearToken ? "Will be removed on save (undo)" : "Remove the saved token"}
                </button>
              ) : undefined
            }
          >
            {(fid) => (
              <Input
                id={fid}
                type="password"
                autoComplete="off"
                className="font-mono text-xs"
                placeholder={m.accessTokenSet ? "Saved · type to replace" : "EAA..."}
                value={token}
                disabled={!manage}
                onChange={(e) => (setToken(e.target.value), setClearToken(false))}
              />
            )}
          </Field>
          <Field label="Test event code" help="Optional. Events then show under Test events only.">
            {(fid) => <Input id={fid} className="font-mono text-xs" placeholder="TEST12345" value={code} disabled={!manage} onChange={(e) => setCode(e.target.value)} />}
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <ToggleRow label="Send Sandbox purchases" help="Off: only Production purchases go to Meta." checked={sandbox} onChange={setSandbox} disabled={!manage} />
          <ToggleRow label="Send without ATT consent" help="Off: installs that did not allow tracking (App Tracking Transparency) are skipped." checked={withoutAtt} onChange={setWithoutAtt} disabled={!manage} />
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">Events</p>
          <div className="divide-y divide-zinc-100 rounded-xl ring-1 ring-zinc-200 dark:divide-zinc-800 dark:ring-zinc-700">
            {EVENTS.map((e) => {
              const v = events[e.type];
              const set = (patch: Partial<typeof v>) => setEvents((s) => ({ ...s, [e.type]: { ...s[e.type], ...patch } }));
              return (
                <div key={e.type} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <Switch checked={v.enabled} onChange={(x) => set({ enabled: x })} disabled={!manage} label={e.label} />
                  <div className="min-w-40 flex-1">
                    <p className="text-sm font-medium">{e.label}</p>
                    <p className="text-xs text-zinc-500">{e.help}</p>
                  </div>
                  <div className="w-full sm:w-56">
                    <Input
                      aria-label={`${e.label} event name`}
                      className="text-xs"
                      placeholder={m.events[e.type].defaultName}
                      value={v.name}
                      invalid={badName(v.name)}
                      disabled={!manage || !v.enabled}
                      onChange={(x) => set({ name: x.target.value })}
                    />
                    <p className="mt-1 text-[11px] text-zinc-500">Default: {m.events[e.type].defaultName}</p>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-zinc-500">Refunds, cancellations and expirations are not sent. Values are in USD (what the customer paid, before Apple&rsquo;s commission).</p>
        </div>
        {manage && (
          <Button type="submit" variant="primary" icon={<Save className="size-4" />} loading={busy} disabled={invalid}>
            Save
          </Button>
        )}
      </form>
    </Card>
  );
}

function ToggleRow({ label, help, checked, onChange, disabled }: { label: string; help: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl px-4 py-3 ring-1 ring-zinc-200 dark:ring-zinc-700">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-zinc-500">{help}</p>
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} label={label} />
    </div>
  );
}
