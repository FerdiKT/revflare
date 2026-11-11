import { Info } from "lucide-react";
import { Card, CardHeader, ErrorState, Skeleton, Stat } from "../../components/ui/Misc";
import { type AdminUsage } from "../../lib/api";
import { ago, cn, compactNumber, fullNumber } from "../../lib/format";
import { countdown, nextUtcMidnight } from "../../lib/quota";
import { useNow } from "../../lib/useFetch";

export function bytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** Used / budget as a meter; amber from 80%, red when spent. */
function Meter({ label, used, budget }: { label: string; used: number; budget: number }) {
  const share = budget > 0 ? Math.min(1, used / budget) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-zinc-500 tabular-nums dark:text-zinc-400" title={`${fullNumber(used)} of ${fullNumber(budget)} rows`}>
          {compactNumber(used)} / {compactNumber(budget)}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={budget}
        aria-valuenow={used}
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
      >
        <div className={cn("h-full rounded-full transition-[width]", share >= 1 ? "bg-red-500" : share >= 0.8 ? "bg-amber-500" : "bg-[var(--viz-1)]")} style={{ width: `${Math.max(share * 100, used > 0 ? 1 : 0)}%` }} />
      </div>
    </div>
  );
}

/** Instance admins: database size and today's share of the Workers Free plan's daily row limits (Admin → Overview). */
export function UsageCard({ usage: d, error, onRetry }: { usage: AdminUsage | null; error?: unknown; onRetry?: () => void }) {
  const now = useNow(30_000);
  return (
    <Card>
      <CardHeader title="Database usage" description="This Revflare server's database on Cloudflare and today's Free plan budget." />
      <div className="px-5 pb-5">
        {error ? <ErrorState error={error} onRetry={onRetry} className="mb-4" /> : null}
        {!d ? (
          <Skeleton className="h-32" />
        ) : (
          <>
            <div className="grid gap-5 sm:grid-cols-[minmax(0,10rem)_1fr]">
              <Stat
                label="Database size"
                value={d.database ? bytes(d.database.size) : "—"}
                sub={
                  d.database ? (
                    <span title={`Rows read / written since the database object started ${ago(d.database.since, now)}`}>
                      {compactNumber(d.database.rowsRead)} read · {compactNumber(d.database.rowsWritten)} written since {ago(d.database.since, now)}
                    </span>
                  ) : (
                    "D1 database"
                  )
                }
              />
              <div className="space-y-3">
                <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Background work today (imports, backfills, history syncs)</p>
                <Meter label="Rows read" used={d.background.rowsRead} budget={d.background.readBudget} />
                <Meter label="Rows written" used={d.background.rowsWritten} budget={d.background.writeBudget} />
              </div>
            </div>
            <p className="mt-5 flex gap-2.5 rounded-lg bg-zinc-50 px-3.5 py-3 text-xs leading-relaxed text-zinc-600 ring-1 ring-zinc-200/80 dark:bg-zinc-950 dark:text-zinc-400 dark:ring-zinc-800">
              <Info className="mt-0.5 size-3.5 shrink-0 text-zinc-400" />
              <span>
                The Cloudflare Workers Free plan allows {compactNumber(d.freePlan.rowsReadPerDay)} rows read and {compactNumber(d.freePlan.rowsWrittenPerDay)} rows written per day; it resets at{" "}
                {d.freePlan.resetsAt} (in {countdown(nextUtcMidnight(now), now)}). Background work stops at its budget so dashboards and new sales keep working. Upgrading to Workers Paid removes
                the limit.
              </span>
            </p>
          </>
        )}
      </div>
    </Card>
  );
}
