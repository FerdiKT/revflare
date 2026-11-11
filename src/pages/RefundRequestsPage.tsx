import { useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, ListChecks, RefreshCw, Save, TriangleAlert } from "lucide-react";
import type { RefundPolicy, RefundRequestLogItem, RefundRequestSettings, RefundRequestSettingsUpdate } from "@shared/types";
import { AppIcon } from "../components/Logo";
import { AppleOnlyNotice, isAndroid } from "../components/Platform";
import { Button } from "../components/ui/Button";
import { Checkbox, Field, Input, Select, Switch } from "../components/ui/Form";
import { Badge, Card, CardHeader, EmptyState, ErrorState, Skeleton, Stat, Table, td, th } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { ago, cn, dateTime, fullNumber } from "../lib/format";
import { useSession } from "../lib/session";
import { invalidate, useFetch, useNow } from "../lib/useFetch";

const POLICIES: { value: RefundPolicy; label: string; help: string }[] = [
  { value: "none", label: "No preference", help: "Only the consumption information is sent; Apple decides." },
  { value: "decline", label: "Decline", help: "Prefer DECLINE for every request: the content was delivered. Apple still decides." },
  { value: "decline_if_delivered_after_days", label: "Decline when older than N days", help: "Prefer DECLINE when the purchase (for a subscription: its first purchase) is at least N days old; no preference otherwise." },
  { value: "grant_prorated", label: "Grant a prorated refund", help: "Prefer GRANT_PRORATED. Apple computes the share for subscriptions; other products need a consumed percentage between 0 and 100 %." },
  { value: "grant_full", label: "Grant a full refund", help: "Prefer GRANT_FULL." },
];

const STATUS_TONE: Record<RefundRequestLogItem["status"], "green" | "zinc" | "red" | "amber"> = { sent: "green", skipped: "zinc", failed: "red", expired: "red", pending: "amber" };

/** Apps → app → Integrations → Refund requests: answers to Apple's CONSUMPTION_REQUEST notifications. */
export function RefundRequestsPage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const manage = can("manage");
  const app = useFetch(`app:${id}`, () => api.apps.get(id), { tags: ["apps"] });
  const r = useFetch(`refunds:${id}`, () => api.apps.refunds.get(id), { tags: ["apps"], refreshMs: 60_000 });
  const log = useFetch(`refunds-log:${id}`, () => api.apps.refunds.log(id), { tags: ["apps"], refreshMs: 60_000 });
  const toast = useToast();
  const now = useNow(30_000);
  const [busy, setBusy] = useState(false);
  const s = r.data;

  const back = (
    <Link to={`/apps/${id}`} className="mb-4 inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
      <ArrowLeft className="size-4" /> {app.data?.name ?? "App"}
    </Link>
  );
  if (isAndroid(app.data))
    return (
      <>
        {back}
        <AppleOnlyNotice what="Refund requests (Apple CONSUMPTION_REQUEST)" />
      </>
    );
  if (r.error)
    return (
      <>
        {back}
        <ErrorState error={r.error} onRetry={r.refetch} />
      </>
    );
  if (!s)
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

  const save = async (b: RefundRequestSettingsUpdate) => {
    setBusy(true);
    try {
      const res = await api.apps.refunds.update(id, b);
      r.setData(() => res);
      toast.success("Refund request settings saved");
      invalidate("apps");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const elsewhere = s.notifications.status !== "revflare" || s.notifications.forwarded;

  return (
    <>
      {back}
      <div className="mb-6 flex flex-wrap items-center gap-4">
        {app.data && <AppIcon name={app.data.name} url={app.data.iconUrl} size={48} />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Refund requests</h1>
            <Badge tone={s.enabled ? "green" : "zinc"} dot>
              {s.enabled ? "On" : "Off"}
            </Badge>
          </div>
          <p className="mt-0.5 text-sm text-zinc-500">
            When a customer asks Apple for a refund, the App Store sends a CONSUMPTION_REQUEST and accepts information about the purchase for 12 hours. Revflare answers it (Send Consumption
            Information) so Apple has more than the customer&rsquo;s side when it decides — see{" "}
            <a href="https://github.com/FerdiKT/revflare/blob/main/docs/refund-requests.md" target="_blank" rel="noreferrer" className="text-brand-700 hover:underline dark:text-brand-400">
              the guide
            </a>
            .
          </p>
        </div>
      </div>

      {elsewhere && (
        <p className="mb-5 flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-100 dark:ring-amber-900">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          {s.notifications.forwarded
            ? "This app's notifications are forwarded to another server: Revflare answers refund requests too (the other server only answers when it is set up to)."
            : "This app's notifications go to another server: Revflare answers the refund requests it polls from Notification History while Apple's 12 hours last; pointing the notification URL to Revflare answers them at once."}
        </p>
      )}

      <Card className="grid grid-cols-2 gap-5 p-5 sm:grid-cols-5">
        <Stat label="Answered" value={fullNumber(s.stats.sent)} sub={s.lastSentAt ? <span title={dateTime(s.lastSentAt)}>last {ago(s.lastSentAt, now)}</span> : "never"} />
        <Stat label="Pending" value={fullNumber(s.stats.pending)} sub="sending or retrying" />
        <Stat label="Skipped" value={fullNumber(s.stats.skipped)} sub="reason in the log" />
        <Stat label="Failed" value={fullNumber(s.stats.failed)} />
        <Stat label="Expired" value={fullNumber(s.stats.expired)} sub="after Apple's 12 hours" />
      </Card>
      {s.lastError && <p className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-200 dark:ring-red-900">Last error: {s.lastError}</p>}

      <SettingsForm
        key={JSON.stringify([s.enabled, s.consentAttested, s.refundPolicy, s.declineAfterDays, s.sampleContentProvided, s.consumptionPercent])}
        s={s}
        manage={manage}
        busy={busy}
        save={save}
      />

      <Card className="mt-5 overflow-hidden">
        <CardHeader
          title="Requests"
          description="The last 100 refund requests Apple sent to this app's Revflare notification URL, with what Revflare answered."
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
          <EmptyState icon={<ListChecks />} title="No refund requests yet" description="They show up here when a customer asks Apple for a refund." />
        ) : (
          <Table>
            <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
              <tr>
                <th className={th}>Received</th>
                <th className={th}>Transaction</th>
                <th className={th}>Product</th>
                <th className={th}>Status</th>
                <th className={th}>Apple</th>
                <th className={th}>Sent / reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {log.data.items.map((d) => (
                <tr key={d.id}>
                  <td className={cn(td, "text-zinc-600 dark:text-zinc-300")} title={`${dateTime(d.receivedAt)} · answer by ${dateTime(d.dueAt)}`}>
                    {ago(d.receivedAt, now)}
                    {d.requestReason && <p className="text-xs text-zinc-500">{d.requestReason.toLowerCase().replace(/_/g, " ")}</p>}
                  </td>
                  <td className={cn(td, "font-mono text-xs")}>
                    {d.transactionId}
                    {d.environment !== "Production" && <p className="font-sans text-zinc-500">{d.environment}</p>}
                  </td>
                  <td className={td}>{d.productName ?? d.productId ?? "—"}</td>
                  <td className={td}>
                    <Badge tone={STATUS_TONE[d.status]}>{d.status}</Badge>
                    {d.attempts > 1 && <p className="mt-0.5 text-xs text-zinc-500">{d.attempts} tries</p>}
                  </td>
                  <td className={cn(td, "max-w-xs whitespace-normal break-all text-xs")}>
                    <span className="tabular-nums">{d.httpStatus ?? "—"}</span>
                    {d.response && <p className="text-zinc-500">{d.response}</p>}
                  </td>
                  <td className={cn(td, "max-w-md whitespace-normal break-all text-xs text-zinc-600 dark:text-zinc-400")}>
                    {d.reason ?? (d.request ? <code>{JSON.stringify(d.request)}</code> : "—")}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}

function SettingsForm({ s, manage, busy, save }: { s: RefundRequestSettings; manage: boolean; busy: boolean; save: (b: RefundRequestSettingsUpdate) => void }) {
  const [enabled, setEnabled] = useState(s.enabled);
  const [attested, setAttested] = useState(s.consentAttested);
  const [policy, setPolicy] = useState<RefundPolicy>(s.refundPolicy);
  const [days, setDays] = useState(s.declineAfterDays ? String(s.declineAfterDays) : "30");
  const [sample, setSample] = useState(s.sampleContentProvided);
  const [percent, setPercent] = useState(s.consumptionPercent === null ? "" : String(s.consumptionPercent));
  const daysN = Number(days);
  const badDays = policy === "decline_if_delivered_after_days" && (!Number.isInteger(daysN) || daysN < 1 || daysN > 3650);
  const percentN = percent.trim() === "" ? null : Number(percent);
  const badPercent = percentN !== null && (!Number.isFinite(percentN) || percentN < 0 || percentN > 100);

  return (
    <Card className="mt-5">
      <CardHeader title="Settings" description="Revflare always answers with deliveryStatus DELIVERED (it cannot know about delivery problems) and customerConsented true." />
      <form
        className="space-y-5 px-5 pb-5"
        onSubmit={(e) => {
          e.preventDefault();
          save({
            consentAttested: attested,
            enabled: attested && enabled,
            refundPolicy: policy,
            ...(policy === "decline_if_delivered_after_days" ? { declineAfterDays: daysN } : {}),
            sampleContentProvided: sample,
            consumptionPercent: percentN,
          });
        }}
      >
        <label className="flex items-start gap-3 rounded-xl bg-amber-50/60 px-4 py-3 ring-1 ring-amber-200 dark:bg-amber-950/20 dark:ring-amber-900">
          <Checkbox className="mt-0.5" checked={attested} disabled={!manage} onChange={(e) => (setAttested(e.target.checked), !e.target.checked && setEnabled(false))} />
          <span className="text-sm">
            <span className="block font-medium">I obtained my customers&rsquo; consent to share consumption data with Apple, as Apple requires.</span>
            <span className="mt-0.5 block text-xs text-zinc-600 dark:text-zinc-400">
              Apple only accepts this information with the customer&rsquo;s valid consent (freely given, specific, informed; ATT does not count) and asks you to disclose it in your app privacy
              labels. Customers can withdraw it at any time: mark them on their customer page and Revflare stops answering for them.
              {s.consentAttestedAt && (
                <>
                  {" "}
                  Confirmed by {s.consentAttestedBy ?? "someone"} on {dateTime(s.consentAttestedAt)}.
                </>
              )}
            </span>
          </span>
        </label>
        <label className="flex items-center justify-between gap-4 rounded-xl bg-zinc-50 px-4 py-3 ring-1 ring-zinc-200 dark:bg-zinc-800/40 dark:ring-zinc-700">
          <span>
            <span className="block text-sm font-medium">Answer refund requests</span>
            <span className="block text-xs text-zinc-500">Requests are answered right away (retried for up to 12 hours).</span>
          </span>
          <Switch checked={attested && enabled} onChange={setEnabled} disabled={!manage || !attested} label="Answer refund requests" />
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Refund preference" help={POLICIES.find((p) => p.value === policy)?.help}>
            {(fid) => (
              <Select id={fid} value={policy} disabled={!manage} onChange={(e) => setPolicy(e.target.value as RefundPolicy)}>
                {POLICIES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {policy === "decline_if_delivered_after_days" && (
            <Field label="Days" help="Decline when the purchase is at least this old.">
              {(fid) => <Input id={fid} inputMode="numeric" value={days} invalid={badDays} disabled={!manage} onChange={(e) => setDays(e.target.value)} />}
            </Field>
          )}
          <Field label="Consumed (%)" help="Optional, for consumables, non-consumables and non-renewing subscriptions. Never sent for auto-renewable subscriptions.">
            {(fid) => <Input id={fid} inputMode="decimal" placeholder="not sent" value={percent} invalid={badPercent} disabled={!manage} onChange={(e) => setPercent(e.target.value)} />}
          </Field>
        </div>
        <div className="flex items-start justify-between gap-3 rounded-xl px-4 py-3 ring-1 ring-zinc-200 dark:ring-zinc-700">
          <div>
            <p className="text-sm font-medium">Sample content provided</p>
            <p className="text-xs text-zinc-500">You offered a free trial, a sample or a description of the content before purchase.</p>
          </div>
          <Switch checked={sample} onChange={setSample} disabled={!manage} label="Sample content provided" />
        </div>
        {manage && (
          <Button type="submit" variant="primary" icon={<Save className="size-4" />} loading={busy} disabled={badDays || badPercent}>
            Save
          </Button>
        )}
      </form>
    </Card>
  );
}
