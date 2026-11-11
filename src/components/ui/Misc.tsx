import { useState, type ReactNode } from "react";
import { AlertCircle, Check, Clock, Copy, Loader2, RotateCw } from "lucide-react";
import { isQuotaError } from "../../lib/api";
import { cn, copyText } from "../../lib/format";

export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("rounded-2xl bg-white shadow-xs ring-1 ring-zinc-200/80 dark:bg-zinc-900 dark:ring-zinc-800", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ title, description, action, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-4 pb-3", className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-zinc-500 dark:text-zinc-400">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export type Tone = "zinc" | "green" | "red" | "amber" | "blue" | "violet" | "brand";
const tones: Record<Tone, string> = {
  zinc: "bg-zinc-100 text-zinc-700 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-900",
  red: "bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/60 dark:text-red-300 dark:ring-red-900",
  amber: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:ring-amber-900",
  blue: "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/60 dark:text-sky-300 dark:ring-sky-900",
  violet: "bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950/60 dark:text-violet-300 dark:ring-violet-900",
  brand: "bg-brand-50 text-brand-700 ring-brand-200 dark:bg-brand-950/60 dark:text-brand-300 dark:ring-brand-900",
};

export function Badge({ tone = "zinc", children, className, dot, title, icon }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean; title?: string; icon?: ReactNode }) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset [&_svg]:size-3", tones[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current opacity-80" />}
      {icon}
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-zinc-200/70 dark:bg-zinc-800", className)} />;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-5 animate-spin text-zinc-400", className)} />;
}

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      {icon && (
        <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-50 to-amber-50 text-brand-600 ring-1 ring-brand-100 dark:from-brand-950/60 dark:to-amber-950/40 dark:text-brand-400 dark:ring-brand-900/60 [&_svg]:size-6">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
      {description && <div className="mt-1 max-w-md text-sm text-zinc-500 dark:text-zinc-400">{description}</div>}
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/** Inline error with the API's message and a retry. The daily database limit gets a quiet note: the app-wide banner explains it. */
export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const msg = error instanceof Error ? error.message : String(error);
  if (isQuotaError(error))
    return (
      <p className={cn("flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400", className)}>
        <Clock className="size-3.5 shrink-0" /> Paused until the daily database limit resets.
      </p>
    );
  return (
    <div role="alert" className={cn("flex items-start gap-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-200 dark:ring-red-900", className)}>
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 flex-1 break-words">{msg}</p>
      {onRetry && (
        <button onClick={onRetry} className="inline-flex shrink-0 items-center gap-1 font-medium underline-offset-2 hover:underline">
          <RotateCw className="size-3.5" /> Retry
        </button>
      )}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{title}</h1>
        {description && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Segmented control (single choice). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  label,
  size = "md",
}: {
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  value: T;
  onChange: (v: T) => void;
  className?: string;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex max-w-full overflow-x-auto rounded-lg bg-zinc-100 p-0.5 scrollbar-thin dark:bg-zinc-800/80", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-md font-medium whitespace-nowrap transition",
            size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm",
            value === o.value ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-50" : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await copyText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-white px-2.5 text-xs font-medium text-zinc-700 ring-1 ring-zinc-200 transition hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-200 dark:ring-zinc-700 dark:hover:bg-zinc-700",
        className,
      )}
    >
      {done ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
      {done ? "Copied" : label}
    </button>
  );
}

/** A value to copy (URL, token) in a monospace field with a copy button. */
export function CopyField({ value, className }: { value: string; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 rounded-lg bg-zinc-50 py-1 pr-1 pl-3 ring-1 ring-zinc-200 dark:bg-zinc-950 dark:ring-zinc-800", className)}>
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-800 dark:text-zinc-200" title={value}>
        {value}
      </code>
      <CopyButton text={value} />
    </div>
  );
}

/** Up/down change chip: arrow + signed percent; `invert` when a rise is bad (churn, refunds). */
export function Delta({ change, invert, className }: { change: number | null | undefined; invert?: boolean; className?: string }) {
  if (change === null || change === undefined || !Number.isFinite(change)) return <span className={cn("text-xs text-zinc-400", className)}>—</span>;
  const flat = Math.abs(change) < 0.0005;
  const good = flat ? null : (change > 0) !== !!invert;
  const v = Math.abs(change * 100);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums",
        good === null ? "text-zinc-500" : good ? "text-[var(--viz-delta-up)]" : "text-[var(--viz-delta-down)]",
        className,
      )}
      title="Change vs the previous period"
    >
      <span aria-hidden>{flat ? "→" : change > 0 ? "↑" : "↓"}</span>
      <span className="sr-only">{flat ? "unchanged" : change > 0 ? "up" : "down"}</span>
      {v >= 100 ? v.toFixed(0) : v.toFixed(1)}%
    </span>
  );
}

export function Stat({ label, value, sub, className }: { label: ReactNode; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-tight tabular-nums text-zinc-900 dark:text-zinc-50">{value}</p>
      {sub && <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{sub}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-zinc-300 bg-zinc-50 px-1.5 py-0.5 font-sans text-[10px] font-medium text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">{children}</kbd>;
}

/** Table shell with horizontal scroll on small screens. */
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-x-auto scrollbar-thin", className)}>
      <table className="w-full min-w-max text-left text-sm">{children}</table>
    </div>
  );
}
export const th = "px-4 py-2.5 text-xs font-medium text-zinc-500 dark:text-zinc-400 whitespace-nowrap";
export const td = "px-4 py-3 whitespace-nowrap";
