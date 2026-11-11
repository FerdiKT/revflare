import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, Clock, Download, UserRound, Zap } from "lucide-react";
import { flag } from "@shared/countries";
import type { AdsAttribution, Customer, CustomerEvent, Transaction } from "@shared/types";
import { AppIcon } from "../components/Logo";
import { SubscriptionStatus } from "../components/SubscriptionStatus";
import { AdsBadge, adsName, isQuick, KindBadge, OfferBadge, offerText } from "../components/TransactionRow";
import { Button } from "../components/ui/Button";
import { useToast } from "../components/ui/Toast";
import { Badge, Card, CardHeader, CopyButton, EmptyState, ErrorState, Skeleton, Stat, Table, td, th } from "../components/ui/Misc";
import { api } from "../lib/api";
import { appleEventLabel } from "../lib/appleEvents";
import { useApps } from "../lib/apps";
import { SOURCE_LABELS, ago, cn, countryName, date, dateTime, duration, gap, money, periodLabel } from "../lib/format";
import { useSession } from "../lib/session";
import { useFetch, useNow } from "../lib/useFetch";

export function CustomerPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { currency } = useSession();
  const { byId } = useApps();
  const c = useFetch(`customer:${id}`, () => api.customer(id));
  const d = c.data;
  const app = d ? byId.get(d.appId) : undefined;
  const now = useNow(30_000);

  return (
    <>
      <button onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/transactions"))} className="mb-4 inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ArrowLeft className="size-4" /> Back
      </button>
      {c.error ? (
        c.error.message === "Not found" ? (
          <Card>
            <EmptyState icon={<UserRound />} title="Customer not found" description="This customer is not in this workspace, or the link is outdated." />
          </Card>
        ) : (
          <ErrorState error={c.error} onRetry={c.refetch} />
        )
      ) : !d ? (
        <div className="space-y-5">
          <Skeleton className="h-20" />
          <Skeleton className="h-28" />
          <Skeleton className="h-64" />
        </div>
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-center gap-4">
            <AppIcon name={d.appName} url={app?.iconUrl} size={56} />
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-semibold tracking-tight">Customer</h1>
              <p className="mt-0.5 text-sm text-zinc-500">
                <Link to={`/apps/${d.appId}`} className="hover:underline">
                  {d.appName}
                </Link>
                {d.country && (
                  <span>
                    {" "}
                    · {flag(d.country)} {countryName(d.country)}
                  </span>
                )}
              </p>
            </div>
            <QuickBadges d={d} />
          </div>

          <ActivityCard d={d} now={now} />

          <Card className="mt-5 grid grid-cols-2 gap-5 p-5 sm:grid-cols-4">
            <Stat label="Total spent" value={money(d.totalSpent, currency)} />
            <Stat label="Proceeds" value={money(d.totalProceeds, currency)} />
            <Stat label="First payment" value={d.firstPaidAt ? date(d.firstPaidAt) : "—"} />
            <Stat label="Last activity" value={date(d.lastSeenAt)} />
          </Card>

          <Card className="mt-5">
            <CardHeader title="Identifiers" />
            <dl className="grid gap-x-6 gap-y-3 px-5 pb-5 text-sm sm:grid-cols-2">
              <Ident label="Revflare id" value={d.id} />
              {d.appAccountToken && <Ident label="App account token" value={d.appAccountToken} />}
              {d.rcAppUserId && <Ident label="RevenueCat app user id" value={d.rcAppUserId} />}
              {d.subscriptions[0] && <Ident label="Original transaction id" value={d.subscriptions[0].originalTransactionId} />}
            </dl>
          </Card>

          <AcquisitionCard a={d.attribution} />

          <RefundConsentCard id={d.id} consent={d.refundDataConsent !== false} onChange={() => c.refetch()} />

          <Card className="mt-5">
            <CardHeader title="Subscriptions" description={`${d.subscriptions.length} in total`} />
            {d.subscriptions.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-zinc-500">No subscriptions (one-time purchases only).</p>
            ) : (
              <Table>
                <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
                  <tr>
                    <th className={th}>Product</th>
                    <th className={th}>Status</th>
                    <th className={th}>Started</th>
                    <th className={th}>Expires</th>
                    <th className={cn(th, "text-right")}>MRR</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {d.subscriptions.map((s) => (
                    <tr key={s.id}>
                      <td className={td}>
                        <p className="font-medium">{s.productName ?? s.productId}</p>
                        {periodLabel(s.period) !== s.productName && <p className="text-xs text-zinc-500">{periodLabel(s.period)}</p>}
                      </td>
                      <td className={td}>
                        <SubscriptionStatus s={s} />
                      </td>
                      <td className={cn(td, "whitespace-nowrap text-zinc-600 dark:text-zinc-300")}>{dateTime(s.startedAt)}</td>
                      <td className={cn(td, "whitespace-nowrap text-zinc-600 dark:text-zinc-300")}>{s.expiresAt ? dateTime(s.expiresAt) : "—"}</td>
                      <td className={cn(td, "text-right font-medium tabular-nums")}>{money(s.mrr, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Timeline d={d} currency={currency} />
        </>
      )}
    </>
  );
}

/** Apple notifications already shown as their transaction (the sale row says it). */
const SALE_EVENTS = new Set(["SUBSCRIBED", "DID_RENEW", "ONE_TIME_CHARGE"]);

type Entry = { at: number; tx: Transaction; ev?: undefined } | { at: number; ev: CustomerEvent; tx?: undefined };

/** Transactions and the Apple notification history, newest first. */
function Timeline({ d, currency }: { d: Customer; currency: string }) {
  const txIds = new Set(d.transactions.map((t) => t.transactionId));
  const trialIds = new Set(d.transactions.filter((t) => t.kind === "trial").map((t) => t.transactionId));
  const entries: Entry[] = [
    ...d.transactions.map((t) => ({ at: t.purchasedAt, tx: t })),
    ...(d.events ?? []).filter((e) => !(SALE_EVENTS.has(e.type) && e.transactionId && txIds.has(e.transactionId))).map((e) => ({ at: e.at, ev: e })),
  ].sort((a, b) => b.at - a.at);
  return (
    <Card className="mt-5">
      <CardHeader title="Timeline" description="Every transaction and store notification, newest first, with the time since the previous step" />
      <ol className="relative px-5 pb-5">
        {entries.length === 0 && <p className="text-sm text-zinc-500">No transactions.</p>}
        {entries.map((x, i, arr) => {
          const line = i < arr.length - 1 && <span className="absolute top-3 bottom-0 left-[5px] w-px bg-zinc-200 dark:bg-zinc-800" aria-hidden />;
          // Time since the previous (older) step: fast buyers / cancellers stand out.
          const since = i < arr.length - 1 ? x.at - arr[i + 1].at : null;
          const step = since !== null && gap(since) && (
            <span className={cn("ml-1 tabular-nums", isQuick(since) ? "font-medium text-amber-600 dark:text-amber-400" : "text-zinc-400")} title="Since the previous step">
              {gap(since)}
            </span>
          );
          if (x.ev) {
            const e = x.ev;
            const m = appleEventLabel(e, !!e.transactionId && trialIds.has(e.transactionId));
            return (
              <li key={`ev-${i}-${e.at}`} className="relative flex gap-4 pb-5 last:pb-0">
                {line}
                <span className={cn("relative mt-1.5 size-[11px] shrink-0 rounded-full ring-4 ring-white dark:ring-zinc-900", m.tone === "red" ? "bg-red-400" : m.tone === "amber" ? "bg-amber-400" : "bg-zinc-300 dark:bg-zinc-600")} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={m.tone}>{m.label}</Badge>
                    {e.productId && <span className="text-sm text-zinc-600 dark:text-zinc-300">{productName(d, e.productId)}</span>}
                    {e.environment !== "Production" && <Badge>{e.environment}</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-zinc-500" title={e.subtype ? `${e.type} · ${e.subtype}` : e.type}>
                    {dateTime(e.at)} · {e.type.startsWith("SUBSCRIPTION_") ? "Google Play notification" : "Apple notification"}
                    {step}
                  </p>
                </div>
              </li>
            );
          }
          const t = x.tx;
          return (
            <li key={t.id} className="relative flex gap-4 pb-5 last:pb-0">
              {line}
              <span className={cn("relative mt-1.5 size-[11px] shrink-0 rounded-full ring-4 ring-white dark:ring-zinc-900", t.refundedAt ? "bg-red-500" : t.price > 0 ? "bg-brand-500" : "bg-zinc-300 dark:bg-zinc-600")} aria-hidden />
              <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-x-4 gap-y-1">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{t.productName ?? t.productId}</span>
                    <KindBadge kind={t.kind} />
                    <OfferBadge t={t} />
                    <AdsBadge a={t.attribution} />
                    {t.refundedAt && (
                      <Badge tone="red">
                        {t.refundPercentage != null && t.refundPercentage < 100 ? `${Math.round(t.refundPercentage * 10) / 10} % refunded` : "Refunded"} {date(t.refundedAt)}
                      </Badge>
                    )}
                    {t.environment !== "Production" && <Badge>{t.environment}</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {dateTime(t.purchasedAt)}
                    {t.expiresAt && ` → ${date(t.expiresAt)}`} · <span className="font-mono">{t.transactionId}</span>
                    {offerText(t) && ` · ${offerText(t)}`}
                    {t.sinceInstallMs != null && (
                      <span className={cn(isQuick(t.sinceInstallMs) && "font-medium text-amber-600 dark:text-amber-400")}> · {duration(t.sinceInstallMs)} after install</span>
                    )}
                    {step}
                  </p>
                </div>
                <div className="text-right">
                  <p className={cn("text-sm font-semibold tabular-nums", t.refundedAt && (t.refundPercentage ?? 100) >= 100 && "text-zinc-400 line-through")}>{money(t.price, currency)}</p>
                  {t.price > 0 && <p className="text-xs text-zinc-500 tabular-nums">{money(t.proceeds, currency)} net</p>}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

/** "Bought 2 min 14 s after installing" / "Cancelled 3 min after buying": within 5 minutes. */
function QuickBadges({ d }: { d: Customer }) {
  const t = d.timing;
  if (!t?.quickPurchase && !t?.quickCancel) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {t.quickPurchase && t.installToPurchaseMs != null && (
        <Badge tone="amber" icon={<Zap />} title="First purchase / trial within 5 minutes of the install (RevflareKit)">
          {t.firstPurchaseKind === "trial" ? "Started a trial" : "Bought"} {duration(t.installToPurchaseMs)} after installing
        </Badge>
      )}
      {t.quickCancel && t.purchaseToCancelMs != null && (
        <Badge tone="red" icon={<Zap />} title={t.cancelledAt ? `Auto-renew turned off ${dateTime(t.cancelledAt)}` : undefined}>
          Cancelled {duration(t.purchaseToCancelMs)} after buying
        </Badge>
      )}
    </div>
  );
}

const FIRST_SOURCE = { install: "app install (RevflareKit)", purchase: "first purchase" } as const;
const LAST_SOURCE = { app: "in the app (RevflareKit)", purchase: "purchase", notification: "store notification" } as const;

/** First seen / last seen / installed with the time, and how fast they bought, cancelled or asked for a refund. */
function ActivityCard({ d, now }: { d: Customer; now: number }) {
  const t = d.timing;
  const items: { label: string; at: number; sub?: string; icon: React.ReactNode }[] = [
    { label: "First seen", at: d.firstSeenAt, sub: d.firstSeenSource ? FIRST_SOURCE[d.firstSeenSource] : undefined, icon: <UserRound /> },
    { label: "Last seen", at: d.lastSeenAt, sub: d.lastSeenSource ? LAST_SOURCE[d.lastSeenSource] : undefined, icon: <Clock /> },
  ];
  if (d.installedAt) items.push({ label: "Installed", at: d.installedAt, sub: d.installedAtSource === "first_report" ? "first report from the app" : "first launch (RevflareKit)", icon: <Download /> });
  const steps: [string, number | null | undefined][] = [
    [t?.firstPurchaseKind === "trial" ? "Install → trial" : "Install → first purchase", t?.installToPurchaseMs],
    ["Purchase → cancellation", t?.purchaseToCancelMs],
    ["Purchase → refund", t?.purchaseToRefundMs],
  ];
  const shown = steps.filter(([, ms]) => ms != null);
  return (
    <Card className="p-5">
      <div className="grid gap-5 sm:grid-cols-3">
        {items.map((x) => (
          <div key={x.label} className="flex min-w-0 gap-3">
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400 [&_svg]:size-4">{x.icon}</span>
            <div className="min-w-0">
              <p className="text-xs font-medium text-zinc-500">{x.label}</p>
              <p className="text-sm font-semibold tabular-nums">{dateTime(x.at)}</p>
              <p className="text-xs text-zinc-500">
                {ago(x.at, now)}
                {x.sub && ` · ${x.sub}`}
              </p>
            </div>
          </div>
        ))}
      </div>
      {shown.length > 0 && (
        <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-zinc-100 pt-4 text-sm dark:border-zinc-800">
          {shown.map(([label, ms]) => (
            <div key={label} className="flex items-baseline gap-2">
              <dt className="text-xs text-zinc-500">{label}</dt>
              <dd className={cn("font-semibold tabular-nums", isQuick(ms) && "text-amber-600 dark:text-amber-400")}>
                {isQuick(ms) && <Zap className="mr-0.5 inline size-3.5" />}
                {duration(ms!)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

function productName(d: Customer, productId: string): string {
  return d.subscriptions.find((s) => s.productId === productId)?.productName ?? d.transactions.find((t) => t.productId === productId)?.productName ?? productId;
}

/** Whether Revflare may answer Apple's refund requests for this customer (Integrations → Refund requests). */
function RefundConsentCard({ id, consent, onChange }: { id: string; consent: boolean; onChange: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      await api.setRefundConsent(id, !consent);
      toast.success(consent ? "Consent withdrawn: refund requests are no longer answered for this customer" : "Consent restored");
      onChange();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="mt-5">
      <CardHeader
        title="Refund requests"
        description={
          consent
            ? "Revflare may share this customer's consumption data with Apple when they ask for a refund (if the app answers refund requests)."
            : "This customer withdrew their consent: Revflare never answers Apple's refund requests for them."
        }
        action={
          can("manage") ? (
            <Button size="sm" variant={consent ? "ghost" : "secondary"} loading={busy} onClick={toggle}>
              {consent ? "Withdraw consent" : "Restore consent"}
            </Button>
          ) : (
            <Badge tone={consent ? "green" : "zinc"}>{consent ? "Consented" : "Withdrawn"}</Badge>
          )
        }
      />
    </Card>
  );
}

/** Where the customer came from: the RevflareKit install of their first linked purchase. */
function AcquisitionCard({ a }: { a: AdsAttribution | null | undefined }) {
  const source = a?.source ?? "unknown";
  return (
    <Card className="mt-5">
      <CardHeader
        title="Acquisition"
        description={
          source === "apple_ads"
            ? "Apple attributed the install of this customer's first purchase to Apple Ads."
            : source === "google_ads"
              ? "The Play Install Referrer of this customer's first purchase's install has a Google Ads click id (gclid)."
              : source === "referral"
                ? "The install of this customer's first purchase came from a referral link (Play Install Referrer utm_source)."
                : source === "organic"
                  ? "The install of this customer's first purchase did not come from an ad campaign."
                  : "No RevflareKit install is linked to this customer's purchases (or the attribution has not arrived yet)."
        }
        action={
          source === "apple_ads" ? (
            <span className="flex items-center gap-1.5">
              <AdsBadge a={a} />
            </span>
          ) : (
            <Badge tone={source === "organic" ? "green" : source === "unknown" ? "zinc" : "blue"}>{SOURCE_LABELS[source] ?? source}</Badge>
          )
        }
      />
      {a && source === "apple_ads" && (
        <dl className="grid gap-x-6 gap-y-3 px-5 pb-5 text-sm sm:grid-cols-3">
          {(
            [
              ["Campaign", a.campaignId, a.campaignName],
              ["Ad group", a.adGroupId, a.adGroupName],
              ["Keyword", a.keywordId, a.keywordName],
            ] as const
          ).map(([label, id, name]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-zinc-500">{label}</dt>
              <dd className="mt-0.5 truncate" title={id ? `Apple Ads id ${id}` : undefined}>
                {adsName(id, name) ?? <span className="text-zinc-400">—</span>}
              </dd>
            </div>
          ))}
          {a.test && <p className="text-xs text-zinc-500 sm:col-span-3">Test (sandbox) attribution: Apple&rsquo;s AdServices test payload, left out of attributed revenue, LTV and Meta.</p>}
        </dl>
      )}
    </Card>
  );
}

function Ident({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="mt-0.5 flex items-center gap-2">
        <code className="truncate font-mono text-xs">{value}</code>
        <CopyButton text={value} className="h-6 px-1.5" label="Copy" />
      </dd>
    </div>
  );
}
