import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Activity, BellOff, Pause, Play, Search, Zap } from "lucide-react";
import type { Transaction, TransactionKind } from "@shared/types";
import { COUNTRY_NAMES, flag } from "@shared/countries";
import { FilterBar } from "../components/FilterBar";
import { KIND_META, TransactionRow } from "../components/TransactionRow";
import { Button } from "../components/ui/Button";
import { Input, Select } from "../components/ui/Form";
import { Card, EmptyState, ErrorState, PageHeader, Skeleton, Spinner } from "../components/ui/Misc";
import { api, type TransactionQuery } from "../lib/api";
import { useFilters } from "../lib/filters";
import { cn } from "../lib/format";
import { useSession } from "../lib/session";
import { useDebounced, useNow } from "../lib/useFetch";

const KINDS: TransactionKind[] = ["new", "renewal", "trial", "conversion", "one_time"];
const chip = (on: boolean, onCls: string) =>
  cn(
    "inline-flex h-8 items-center gap-1 rounded-full px-3 text-xs font-medium ring-1 transition",
    on ? onCls : "bg-white text-zinc-600 ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800 dark:hover:bg-zinc-800",
  );
const COUNTRIES = Object.entries(COUNTRY_NAMES).sort((a, b) => a[1].localeCompare(b[1]));
const PAGE = 50;
/** Acquisition of the purchase's RevflareKit install (unknown: no install linked). */
const SOURCES = [
  { value: "apple_ads", label: "Apple Ads" },
  { value: "google_ads", label: "Google Ads" },
  { value: "referral", label: "Referral" },
  { value: "organic", label: "Organic" },
  { value: "unknown", label: "Unknown" },
] as const;

export function TransactionsPage() {
  const { currency } = useSession();
  const { apps } = useFilters();
  const [params, setParams] = useSearchParams();
  const kinds = (params.get("kinds")?.split(",").filter((k): k is TransactionKind => (KINDS as string[]).includes(k)) ?? []) as TransactionKind[];
  const country = params.get("country") ?? "";
  const refunded = params.get("refunded") === "true";
  const quick = params.get("quick") === "true";
  const cancellations = params.get("cancellations") === "true";
  const environment = (["Sandbox", "all"].includes(params.get("env") ?? "") ? params.get("env") : "Production") as TransactionQuery["environment"];
  const source = (SOURCES.some((x) => x.value === params.get("source")) ? params.get("source") : undefined) as TransactionQuery["source"];
  const [qInput, setQInput] = useState(params.get("q") ?? "");
  const q = useDebounced(qInput.trim(), 350);

  const set = useCallback(
    (k: string, v: string | null) =>
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          if (v) n.set(k, v);
          else n.delete(k);
          return n;
        },
        { replace: true },
      ),
    [setParams],
  );
  useEffect(() => set("q", q || null), [q, set]);

  const query = useMemo<TransactionQuery>(
    () =>
      cancellations
        ? { apps, country: country || undefined, q: q || undefined, environment, source, quick, cancellations, limit: PAGE }
        : { apps, kinds, country: country || undefined, q: q || undefined, refunded, environment, source, quick, limit: PAGE },
    [apps.join(), kinds.join(), country, q, refunded, environment, source, quick, cancellations], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const key = JSON.stringify(query);

  const [items, setItems] = useState<Transaction[] | null>(null);
  // Amounts are in the response's currency (falls back to the workspace's for older servers).
  const [txCurrency, setTxCurrency] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [live, setLive] = useState(true);
  const seq = useRef(0);
  const now = useNow(20_000);

  // First page whenever the filters change.
  useEffect(() => {
    const id = ++seq.current;
    setItems(null);
    setError(null);
    setCursor(null);
    api
      .transactions(query)
      .then((r) => {
        if (id !== seq.current) return;
        setItems(r.items);
        setTxCurrency(r.currency ?? null);
        setCursor(r.nextCursor);
      })
      .catch((e: Error) => id === seq.current && setError(e));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    const id = seq.current;
    setLoadingMore(true);
    try {
      const r = await api.transactions({ ...query, cursor });
      if (id !== seq.current) return;
      setItems((prev) => {
        const have = new Set(prev?.map((t) => t.id));
        return [...(prev ?? []), ...r.items.filter((t) => !have.has(t.id))];
      });
      setCursor(r.nextCursor);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, query]);

  // Live: poll the first page and prepend what is new.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      const id = seq.current;
      try {
        const r = await api.transactions(query);
        if (id !== seq.current) return;
        setItems((prev) => {
          if (!prev) return prev;
          const have = new Set(prev.map((x) => x.id));
          const add = r.items.filter((x) => !have.has(x.id));
          if (!add.length) return prev;
          setFresh(new Set(add.map((x) => x.id)));
          return [...add, ...prev];
        });
      } catch {
        /* keep the list; the next poll retries */
      }
      // A source / quick filter looks at up to 500 rows per request: poll it less often.
    }, source || quick ? 60_000 : 15_000);
    return () => clearInterval(t);
  }, [key, live]); // eslint-disable-line react-hooks/exhaustive-deps

  // Infinite scroll.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && void loadMore(), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  const toggleKind = (k: TransactionKind) => set("kinds", (kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k]).join(",") || null);

  return (
    <>
      <PageHeader
        title="Transactions"
        description="Every sale, renewal, trial and cancellation as it arrives from the store."
        actions={
          <Button size="sm" variant={live ? "secondary" : "outline"} onClick={() => setLive((l) => !l)} icon={live ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} aria-pressed={live}>
            {live ? (
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-emerald-500" /> Live
              </span>
            ) : (
              "Paused"
            )}
          </Button>
        }
      />
      <FilterBar>
        <div className="relative min-w-48 flex-1 sm:max-w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-zinc-400" />
          <Input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Transaction id" className="pl-8" aria-label="Search by transaction id" />
        </div>
      </FilterBar>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Kinds">
          <button
            type="button"
            aria-pressed={cancellations}
            onClick={() => set("cancellations", cancellations ? null : "true")}
            className={chip(cancellations, "bg-red-600 text-white ring-red-600")}
            title="Auto-renew turned off (App Store and Google Play)"
          >
            <BellOff className="size-3.5" /> Cancellations
          </button>
          <button
            type="button"
            aria-pressed={quick}
            onClick={() => set("quick", quick ? null : "true")}
            className={chip(quick, "bg-amber-500 text-white ring-amber-500")}
            title="Bought within 5 minutes of the install, or cancelled within 5 minutes of the purchase"
          >
            <Zap className="size-3.5" /> Within 5 min
          </button>
          {!cancellations && (
            <>
              {KINDS.map((k) => {
                const on = kinds.includes(k);
                return (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleKind(k)}
                    className={cn(
                      "h-8 rounded-full px-3 text-xs font-medium ring-1 transition",
                      on ? "bg-zinc-900 text-white ring-zinc-900 dark:bg-white dark:text-zinc-900 dark:ring-white" : "bg-white text-zinc-600 ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800 dark:hover:bg-zinc-800",
                    )}
                  >
                    {KIND_META[k].label}
                  </button>
                );
              })}
              <button
                type="button"
                aria-pressed={refunded}
                onClick={() => set("refunded", refunded ? null : "true")}
                className={cn(
                  "h-8 rounded-full px-3 text-xs font-medium ring-1 transition",
                  refunded ? "bg-red-600 text-white ring-red-600" : "bg-white text-zinc-600 ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800 dark:hover:bg-zinc-800",
                )}
              >
                Refunded only
              </button>
            </>
          )}
        </div>
        <div className="flex flex-1 flex-wrap justify-end gap-2">
          <Select value={country} onChange={(e) => set("country", e.target.value || null)} aria-label="Country" className="w-48">
            <option value="">All countries</option>
            {COUNTRIES.map(([code, name]) => (
              <option key={code} value={code}>
                {flag(code)} {name}
              </option>
            ))}
          </Select>
          <Select value={source ?? ""} onChange={(e) => set("source", e.target.value || null)} aria-label="Acquisition source" className="w-36">
            <option value="">All sources</option>
            {SOURCES.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </Select>
          <Select value={environment} onChange={(e) => set("env", e.target.value === "Production" ? null : e.target.value)} aria-label="Environment" className="w-36">
            <option value="Production">Production</option>
            <option value="Sandbox">Sandbox</option>
            <option value="all">All environments</option>
          </Select>
        </div>
      </div>

      {error && <ErrorState error={error} className="mb-4" onRetry={() => (items ? void loadMore() : window.location.reload())} />}
      <Card className="overflow-hidden">
        {!items ? (
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 px-5 py-3.5">
                <Skeleton className="size-9 rounded-lg" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-56" />
                </div>
                <Skeleton className="h-8 w-20" />
              </div>
            ))}
          </div>
        ) : items.length === 0 && cursor ? (
          // A source / quick filter can return an empty page that continues further back.
          <p className="px-5 py-8 text-center text-sm text-zinc-500">Looking further back…</p>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Activity />}
            title={cancellations ? "No cancellations match" : "No transactions match"}
            description={quick ? "Nobody bought within 5 minutes of installing (RevflareKit install time) or cancelled within 5 minutes of buying in the rows looked at." : q ? "No transaction has this id. Paste the full Apple transaction id or original transaction id." : "Try other filters, or check Apps → notification status if you expected sales here."}
          />
        ) : (
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {items.map((t) => (
              <TransactionRow key={t.id} t={t} currency={txCurrency ?? currency} fresh={fresh.has(t.id)} now={now} />
            ))}
          </div>
        )}
        <div ref={sentinel} />
        {loadingMore && (
          <div className="flex justify-center border-t border-zinc-100 py-4 dark:border-zinc-800">
            <Spinner />
          </div>
        )}
        {items && items.length > 0 && !cursor && <p className="border-t border-zinc-100 py-4 text-center text-xs text-zinc-400 dark:border-zinc-800">That’s everything.</p>}
      </Card>
    </>
  );
}
