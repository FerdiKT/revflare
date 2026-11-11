import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Scale } from "lucide-react";
import { FilterBar } from "../components/FilterBar";
import { AppIcon } from "../components/Logo";
import { Card, EmptyState, ErrorState, PageHeader, Segmented, Skeleton, Stat, Table, td, th } from "../components/ui/Misc";
import { api } from "../lib/api";
import { useApps } from "../lib/apps";
import { useFilters } from "../lib/filters";
import { cn, dayLabel, fullNumber, money, percent } from "../lib/format";
import { useFetch } from "../lib/useFetch";

/** Off by more than 5% (or any unit difference): highlighted. */
const off = (a: number, b: number) => Math.abs(a - b) > Math.max(0.05 * Math.max(Math.abs(a), Math.abs(b)), 0.5);

export function ReconciliationPage() {
  const f = useFilters("28d");
  const { byId } = useApps();
  const [only, setOnly] = useState<"all" | "diff">("all");
  const r = useFetch(`recon:${JSON.stringify(f.scope)}`, () => api.reconciliation(f.scope), { tags: ["metrics"] });
  const d = r.data;
  const reported = useMemo(() => new Set(d?.reportedDays ?? []), [d]);
  const rows = useMemo(() => (d ? d.rows.filter((x) => reported.has(x.day)).sort((a, b) => b.day.localeCompare(a.day) || (a.appId ?? "").localeCompare(b.appId ?? "")) : []), [d, reported]);
  const diffRows = rows.filter((x) => off(x.apple?.units ?? 0, x.revflare?.units ?? 0) || off(x.apple?.proceeds ?? 0, x.revflare?.proceeds ?? 0));
  const list = only === "diff" ? diffRows : rows;
  const sum = (k: "apple" | "revflare", m: "units" | "proceeds") => rows.reduce((a, x) => a + (x[k]?.[m] ?? 0), 0);

  return (
    <>
      <PageHeader title="Reconciliation" description="Apple's Sales and Trends reports next to what Revflare recorded, per day and app." />
      <FilterBar range defaultRange="28d" />
      {r.error && <ErrorState error={r.error} onRetry={r.refetch} className="mb-5" />}
      {!d ? (
        <Skeleton className="h-72" />
      ) : d.reportedDays.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Scale />}
            title="No Apple sales reports for this range yet"
            description={
              <>
                <p>Reconciliation compares Apple&rsquo;s daily Sales and Trends reports with Revflare&rsquo;s transactions, so missing or extra sales stand out.</p>
                <p className="mt-2">
                  It needs an <strong>App Store Connect API key with the Sales role</strong> (or Admin/Finance) and your <strong>vendor number</strong> (App Store Connect → Payments and Financial Reports). Then
                  import the reports on the Imports page; Revflare also fetches them daily.
                </p>
              </>
            }
            action={
              <>
                <Link to="/settings/credentials" className="inline-flex h-9 items-center rounded-lg bg-brand-600 px-3.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700 dark:bg-brand-500">
                  Add a key
                </Link>
                <Link to="/imports" className="inline-flex h-9 items-center rounded-lg bg-white px-3.5 text-sm font-medium ring-1 ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-800 dark:ring-zinc-700">
                  Import sales reports
                </Link>
              </>
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Card className="p-5">
              <Stat label="Apple units" value={fullNumber(sum("apple", "units"))} sub={`Revflare: ${fullNumber(sum("revflare", "units"))}`} />
            </Card>
            <Card className="p-5">
              <Stat label="Apple proceeds" value={money(sum("apple", "proceeds"), d.currency)} sub={`Revflare: ${money(sum("revflare", "proceeds"), d.currency)}`} />
            </Card>
            <Card className="p-5">
              <Stat label="Reported days" value={fullNumber(d.reportedDays.length)} sub={`${d.from} → ${d.to}`} />
            </Card>
            <Card className="p-5">
              <Stat label="Rows with differences" value={fullNumber(diffRows.length)} sub={rows.length ? `${percent(diffRows.length / rows.length, 0)} of ${fullNumber(rows.length)}` : undefined} />
            </Card>
          </div>
          <Card className="mt-5 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
              <p className="text-xs text-zinc-500">Units = paid transactions. Differences over 5% are highlighted. Amounts converted to {d.currency}.</p>
              <Segmented
                size="sm"
                label="Rows"
                value={only}
                onChange={setOnly}
                options={[
                  { value: "all", label: "All rows" },
                  { value: "diff", label: "Differences only" },
                ]}
              />
            </div>
            <Table>
              <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
                <tr>
                  <th className={th}>Day</th>
                  <th className={th}>App</th>
                  <th className={cn(th, "text-right")}>Apple units</th>
                  <th className={cn(th, "text-right")}>Revflare units</th>
                  <th className={cn(th, "text-right")}>Apple proceeds</th>
                  <th className={cn(th, "text-right")}>Revflare proceeds</th>
                  <th className={cn(th, "text-right")}>Difference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {list.map((x) => {
                  const app = x.appId ? byId.get(x.appId) : undefined;
                  const au = x.apple?.units ?? 0;
                  const ru = x.revflare?.units ?? 0;
                  const ap = x.apple?.proceeds ?? 0;
                  const rp = x.revflare?.proceeds ?? 0;
                  const uOff = off(au, ru);
                  const pOff = off(ap, rp);
                  const hl = "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200";
                  return (
                    <tr key={`${x.day}:${x.appId}`}>
                      <td className={cn(td, "text-zinc-600 dark:text-zinc-300")}>{dayLabel(x.day)}</td>
                      <td className={td}>
                        <span className="flex items-center gap-2">
                          <AppIcon name={app?.name ?? "?"} url={app?.iconUrl} size={22} />
                          {app?.name ?? (x.appId ? "Unknown app" : "Not matched to an app")}
                        </span>
                      </td>
                      <td className={cn(td, "text-right tabular-nums", uOff && hl)}>{x.apple ? fullNumber(au) : "—"}</td>
                      <td className={cn(td, "text-right tabular-nums", uOff && hl)}>{x.revflare ? fullNumber(ru) : "—"}</td>
                      <td className={cn(td, "text-right tabular-nums", pOff && hl)}>{x.apple ? money(ap, d.currency) : "—"}</td>
                      <td className={cn(td, "text-right tabular-nums", pOff && hl)}>{x.revflare ? money(rp, d.currency) : "—"}</td>
                      <td className={cn(td, "text-right font-medium tabular-nums", pOff ? "text-amber-700 dark:text-amber-300" : "text-zinc-400")}>
                        {rp - ap > 0 ? "+" : rp - ap < 0 ? "−" : ""}
                        {money(Math.abs(rp - ap), d.currency)}
                      </td>
                    </tr>
                  );
                })}
                {list.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-5 py-10 text-center text-sm text-zinc-500">
                      Everything matches.
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </Card>
        </>
      )}
    </>
  );
}
