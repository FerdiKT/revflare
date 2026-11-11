import { useMemo, useState, type ReactNode } from "react";
import { CalendarRange, Check, ChevronDown, LayoutGrid, Search, X } from "lucide-react";
import { useApps } from "../lib/apps";
import { RANGE_PRESETS, addDays, todayUtc, useFilters } from "../lib/filters";
import { cn } from "../lib/format";
import { AppIcon } from "./Logo";
import { StoreGlyph } from "./Platform";
import { Button } from "./ui/Button";
import { Input } from "./ui/Form";
import { Popover } from "./ui/Popover";

const triggerClass =
  "inline-flex h-9 max-w-full items-center gap-2 rounded-lg bg-white px-3 text-sm font-medium text-zinc-800 shadow-xs ring-1 ring-zinc-200 transition hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:ring-zinc-800 dark:hover:bg-zinc-800";

/** Global filters in one row above the content: apps (always) and the date range (pages with a range). */
export function FilterBar({ range = false, children, defaultRange }: { range?: boolean; children?: ReactNode; defaultRange?: string }) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-2">
      <AppPicker />
      {range && <RangePicker defaultRange={defaultRange} />}
      {children}
    </div>
  );
}

export function AppPicker() {
  const { apps } = useApps();
  const { apps: selected, setApps } = useFilters();
  const [q, setQ] = useState("");
  const visible = apps.filter((a) => !a.archived || selected.includes(a.id));
  const list = useMemo(() => visible.filter((a) => a.name.toLowerCase().includes(q.trim().toLowerCase())), [visible, q]);
  const chosen = apps.filter((a) => selected.includes(a.id));
  const mixed = apps.some((a) => a.platform === "android" || a.platform === "web");
  const toggle = (id: string) => setApps(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <Popover
      label="Filter by app"
      panelClassName="w-72"
      trigger={(p) => (
        <button ref={p.ref} type="button" onClick={p.toggle} aria-expanded={p["aria-expanded"]} aria-haspopup="dialog" className={triggerClass}>
          {chosen.length === 0 ? (
            <LayoutGrid className="size-4 text-zinc-400" />
          ) : (
            <span className="flex -space-x-1.5">
              {chosen.slice(0, 3).map((a) => (
                <AppIcon key={a.id} name={a.name} url={a.iconUrl} size={20} className="ring-2 ring-white dark:ring-zinc-900" />
              ))}
            </span>
          )}
          <span className="truncate">{chosen.length === 0 ? "All apps" : chosen.length === 1 ? chosen[0].name : `${chosen.length} apps`}</span>
          <ChevronDown className="size-4 shrink-0 text-zinc-400" />
        </button>
      )}
    >
      {(close) => (
        <div>
          {apps.length > 6 && (
            <div className="relative mb-1.5">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-zinc-400" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps" className="pl-8" aria-label="Search apps" autoFocus />
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              setApps([]);
              close();
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <span className="flex size-6 items-center justify-center rounded-md bg-zinc-100 text-zinc-500 dark:bg-zinc-800">
              <LayoutGrid className="size-3.5" />
            </span>
            <span className="flex-1 font-medium">All apps</span>
            {selected.length === 0 && <Check className="size-4 text-brand-600 dark:text-brand-400" />}
          </button>
          <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
          <div className="max-h-72 overflow-y-auto scrollbar-thin" role="group" aria-label="Apps">
            {list.map((a) => {
              const on = selected.includes(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggle(a.id)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <AppIcon name={a.name} url={a.iconUrl} size={24} />
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  {mixed && <StoreGlyph platform={a.platform} className="size-3" />}
                  <span className={cn("flex size-4 items-center justify-center rounded border", on ? "border-brand-600 bg-brand-600 text-white dark:border-brand-500 dark:bg-brand-500" : "border-zinc-300 dark:border-zinc-600")}>
                    {on && <Check className="size-3" strokeWidth={3} />}
                  </span>
                </button>
              );
            })}
            {list.length === 0 && <p className="px-2 py-3 text-center text-sm text-zinc-500">{apps.length ? "No app matches." : "No apps yet."}</p>}
          </div>
        </div>
      )}
    </Popover>
  );
}

export function RangePicker({ defaultRange }: { defaultRange?: string }) {
  const f = useFilters(defaultRange);
  const today = todayUtc();
  const [from, setFrom] = useState(f.from ?? addDays(today, -27));
  const [to, setTo] = useState(f.to ?? today);
  const label = f.range === "custom" ? `${f.from} → ${f.to}` : (RANGE_PRESETS.find((p) => p.value === f.range)?.label ?? f.range);

  return (
    <Popover
      label="Date range"
      panelClassName="w-72"
      trigger={(p) => (
        <button ref={p.ref} type="button" onClick={p.toggle} aria-expanded={p["aria-expanded"]} aria-haspopup="dialog" className={triggerClass}>
          <CalendarRange className="size-4 text-zinc-400" />
          <span className="truncate tabular-nums">{label}</span>
          <ChevronDown className="size-4 shrink-0 text-zinc-400" />
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="grid grid-cols-2 gap-1" role="radiogroup" aria-label="Presets">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                role="radio"
                aria-checked={f.range === p.value}
                onClick={() => {
                  f.setRange({ range: p.value });
                  close();
                }}
                className={cn(
                  "rounded-lg px-2.5 py-1.5 text-left text-sm transition",
                  f.range === p.value ? "bg-brand-50 font-medium text-brand-700 dark:bg-brand-950/50 dark:text-brand-300" : "hover:bg-zinc-100 dark:hover:bg-zinc-800",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <form
            className="mt-2 border-t border-zinc-100 px-1 pt-2.5 pb-1 dark:border-zinc-800"
            onSubmit={(e) => {
              e.preventDefault();
              if (from && to) {
                f.setRange(from <= to ? { from, to } : { from: to, to: from });
                close();
              }
            }}
          >
            <p className="mb-1.5 text-xs font-medium text-zinc-500">Custom range (UTC)</p>
            <div className="flex items-center gap-1.5">
              <Input type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} aria-label="From" className="px-2 text-xs" />
              <span className="text-zinc-400">–</span>
              <Input type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} aria-label="To" className="px-2 text-xs" />
            </div>
            <Button type="submit" variant="primary" size="sm" className="mt-2 w-full">
              Apply
            </Button>
          </form>
        </div>
      )}
    </Popover>
  );
}

/** Small "x" chip showing an active filter. */
export function FilterChip({ children, onClear }: { children: ReactNode; onClear: () => void }) {
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-full bg-zinc-100 pr-1 pl-2.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
      {children}
      <button type="button" onClick={onClear} aria-label="Clear filter" className="rounded-full p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-700">
        <X className="size-3" />
      </button>
    </span>
  );
}
