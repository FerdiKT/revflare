import { useEffect } from "react";
import { DatabaseZap, RotateCw } from "lucide-react";
import { cn } from "../lib/format";
import { clearQuota, countdown, useQuota } from "../lib/quota";
import { invalidate, useNow, type Tag } from "../lib/useFetch";

const ALL_TAGS: Tag[] = ["apps", "credentials", "goals", "alerts", "jobs", "members", "apiKeys", "devices", "me", "metrics"];

/** App-wide notice while the Workers Free plan's daily database limit is hit (API `503 { code: "quota" }`). */
export function QuotaBanner({ className, onRetry }: { className?: string; onRetry?: () => void }) {
  const until = useQuota();
  const now = useNow(30_000);
  // Skeletons stop pulsing: nothing is loading until the reset.
  useEffect(() => {
    document.documentElement.toggleAttribute("data-quota", !!until);
    return () => document.documentElement.removeAttribute("data-quota");
  }, [until]);
  if (!until) return null;
  return (
    <div role="alert" className={cn("flex items-start gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-100 dark:ring-amber-900", className)}>
      <DatabaseZap className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          Revflare reached today's Cloudflare free plan database limit. It resets at 00:00 UTC — in {countdown(until, now)}.
        </p>
        <p className="mt-0.5 text-amber-800/80 dark:text-amber-200/70">Numbers and new sales show up again after the reset; Apple keeps retrying its notifications. Upgrading to Workers Paid removes the limit.</p>
      </div>
      <button
        onClick={() => {
          clearQuota();
          if (onRetry) onRetry();
          else invalidate(...ALL_TAGS);
        }}
        className="inline-flex shrink-0 items-center gap-1 font-medium underline-offset-2 hover:underline"
      >
        <RotateCw className="size-3.5" /> Try again
      </button>
    </div>
  );
}
