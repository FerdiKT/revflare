import { useState } from "react";
import { useNavigate } from "react-router";
import { CreditCard, Hourglass, LifeBuoy, PowerOff } from "lucide-react";
import type { AtRisk, Subscription } from "@shared/types";
import { flag } from "@shared/countries";
import { Button } from "../components/ui/Button";
import { FilterBar } from "../components/FilterBar";
import { AppIcon } from "../components/Logo";
import { SubscriptionStatus } from "../components/SubscriptionStatus";
import { Card, EmptyState, ErrorState, PageHeader, Skeleton, Table, td, th } from "../components/ui/Misc";
import { api } from "../lib/api";
import { useApps } from "../lib/apps";
import { useFilters } from "../lib/filters";
import { cn, date, fullNumber, inFuture, money, periodLabel } from "../lib/format";
import { useFetch } from "../lib/useFetch";

type Reason = AtRisk["groups"][number]["reason"];
const REASONS: Array<{ reason: Reason; label: string; help: string; icon: typeof CreditCard }> = [
  { reason: "billing_retry", label: "Billing retry", help: "Payment failed; Apple keeps retrying for up to 60 days.", icon: CreditCard },
  { reason: "grace", label: "Grace period", help: "Payment failed but the customer keeps access while Apple retries.", icon: Hourglass },
  { reason: "cancelled", label: "Auto-renew off", help: "Will churn at the end of the period unless they turn it back on.", icon: PowerOff },
];

const matches = (s: Subscription, r: Reason) => (r === "billing_retry" ? s.status === "billing_retry" : r === "grace" ? s.status === "grace" : !s.autoRenew && s.status !== "billing_retry" && s.status !== "grace");

export function AtRiskPage() {
  const { scope, apps } = useFilters();
  const { byId } = useApps();
  const navigate = useNavigate();
  const [reason, setReason] = useState<Reason | null>(null);
  const [limit, setLimit] = useState(50);
  const r = useFetch(`at-risk:${apps.join()}`, () => api.atRisk(scope, 500), { tags: ["metrics"], refreshMs: 300_000 });
  const d = r.data;
  const items = d ? (reason ? d.items.filter((s) => matches(s, reason)) : d.items) : [];
  const now = Date.now();

  return (
    <>
      <PageHeader title="At risk" description="Subscriptions that will not renew unless something changes. Reach out or fix billing to save them." />
      <FilterBar />
      {r.error && <ErrorState error={r.error} onRetry={r.refetch} className="mb-5" />}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-5 sm:col-span-2 lg:col-span-1">
          <p className="text-xs font-medium text-zinc-500">MRR at risk</p>
          {d ? <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">{money(d.mrr, d.currency)}</p> : <Skeleton className="mt-2 h-9 w-32" />}
          {d && <p className="mt-1 text-xs text-zinc-500">{fullNumber(d.groups.reduce((a, g) => a + g.subscriptions, 0))} subscriptions</p>}
        </Card>
        {REASONS.map((x) => {
          const g = d?.groups.find((y) => y.reason === x.reason);
          const on = reason === x.reason;
          return (
            <button
              key={x.reason}
              type="button"
              aria-pressed={on}
              onClick={() => {
                setReason(on ? null : x.reason);
                setLimit(50);
              }}
              className={cn(
                "rounded-2xl bg-white p-5 text-left shadow-xs ring-1 transition dark:bg-zinc-900",
                on ? "ring-2 ring-brand-500" : "ring-zinc-200/80 hover:ring-zinc-300 dark:ring-zinc-800 dark:hover:ring-zinc-700",
              )}
            >
              <p className="flex items-center gap-2 text-xs font-medium text-zinc-500">
                <x.icon className="size-4 text-amber-500" /> {x.label}
              </p>
              {d ? (
                <>
                  <p className="mt-1 text-xl font-semibold tabular-nums">{money(g?.mrr ?? 0, d.currency)}</p>
                  <p className="text-xs text-zinc-500">{fullNumber(g?.subscriptions ?? 0)} subscriptions</p>
                </>
              ) : (
                <Skeleton className="mt-2 h-10" />
              )}
              <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">{x.help}</p>
            </button>
          );
        })}
      </div>

      <Card className="mt-5 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5">
          <h2 className="text-sm font-semibold">{reason ? REASONS.find((x) => x.reason === reason)!.label : "All subscriptions at risk"}</h2>
          {d && <p className="text-xs text-zinc-500">Sorted by expiry · {fullNumber(items.length)} subscriptions</p>}
        </div>
        {!d ? (
          <div className="space-y-2 px-5 pb-5">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<LifeBuoy />} title="Nothing at risk" description="No subscription is in billing retry, in a grace period or set to not renew." />
        ) : (
          <Table>
            <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
              <tr>
                <th className={th}>App · product</th>
                <th className={th}>Status</th>
                <th className={th}>Ends</th>
                <th className={th}>Country</th>
                <th className={cn(th, "text-right")}>MRR</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {[...items]
                .sort((a, b) => (a.expiresAt ?? 0) - (b.expiresAt ?? 0))
                .slice(0, limit)
                .map((s) => (
                  <tr
                    key={s.id}
                    tabIndex={s.customerId ? 0 : undefined}
                    onClick={() => s.customerId && navigate(`/customers/${s.customerId}`)}
                    onKeyDown={(e) => e.key === "Enter" && s.customerId && navigate(`/customers/${s.customerId}`)}
                    className={cn(s.customerId && "cursor-pointer hover:bg-zinc-50 focus-visible:bg-zinc-50 dark:hover:bg-zinc-800/40")}
                  >
                    <td className={td}>
                      <div className="flex items-center gap-3">
                        <AppIcon name={s.appName} url={byId.get(s.appId)?.iconUrl} size={28} />
                        <div>
                          <p className="font-medium">{s.appName}</p>
                          <p className="text-xs text-zinc-500">
                            {s.productName ?? s.productId}
                            {periodLabel(s.period) !== (s.productName ?? s.productId) && ` · ${periodLabel(s.period)}`}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className={td}>
                      <SubscriptionStatus s={s} />
                    </td>
                    <td className={cn(td, "text-zinc-600 dark:text-zinc-300")}>
                      {s.expiresAt ? (
                        <>
                          {date(s.expiresAt)}
                          <span className="block text-xs text-zinc-400">{s.expiresAt > now ? inFuture(s.expiresAt, now) : "ended"}</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className={td}>{s.country ? `${flag(s.country)} ${s.country}` : "—"}</td>
                    <td className={cn(td, "text-right font-medium tabular-nums")}>{money(s.mrr, d.currency)}</td>
                  </tr>
                ))}
            </tbody>
          </Table>
        )}
        {d && items.length > limit && (
          <div className="border-t border-zinc-100 p-3 text-center dark:border-zinc-800">
            <Button size="sm" variant="ghost" onClick={() => setLimit((l) => l + 100)}>
              Show more ({fullNumber(items.length - limit)} left)
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
