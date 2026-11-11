import { useCallback, useEffect, useRef, useState } from "react";

/** Data tags: mutations invalidate them and every hook that depends on one refetches. */
export type Tag = "apps" | "credentials" | "goals" | "alerts" | "jobs" | "members" | "apiKeys" | "devices" | "me" | "metrics" | "admin";

const bus = new EventTarget();

export function invalidate(...tags: Tag[]) {
  for (const t of tags) bus.dispatchEvent(new Event(t));
}

export interface FetchState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  refetch: () => Promise<void>;
  setData: (fn: (prev: T | undefined) => T | undefined) => void;
}

/**
 * Tiny data-fetching hook. `key` identifies the request (null skips it); the fetcher re-runs when the key changes,
 * on refetch(), when a tag is invalidated, and every `refreshMs` while the tab is visible (silently: stale data stays).
 */
export function useFetch<T>(key: string | null, fetcher: () => Promise<T>, opts: { tags?: Tag[]; refreshMs?: number } = {}): FetchState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(key !== null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const seq = useRef(0);
  const lastKey = useRef<string | null>(null);

  const run = useCallback(async () => {
    if (key === null) return;
    const id = ++seq.current;
    // A new key drops the previous data (skeletons); a refresh of the same key keeps it on screen.
    if (lastKey.current !== key) {
      lastKey.current = key;
      setData(undefined);
    }
    setLoading(true);
    try {
      const result = await fetcherRef.current();
      if (id === seq.current) {
        setData(result);
        setError(undefined);
      }
    } catch (err) {
      if (id === seq.current) setError(err as Error);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    void run();
  }, [run]);

  const tagKey = (opts.tags ?? []).join(",");
  useEffect(() => {
    if (!tagKey) return;
    const handler = () => void run();
    const list = tagKey.split(",");
    for (const t of list) bus.addEventListener(t, handler);
    return () => {
      for (const t of list) bus.removeEventListener(t, handler);
    };
  }, [tagKey, run]);

  const refreshMs = opts.refreshMs;
  useEffect(() => {
    if (!refreshMs || key === null) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void run();
    }, refreshMs);
    const onVisible = () => document.visibilityState === "visible" && void run();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshMs, run, key]);

  const set = useCallback((fn: (prev: T | undefined) => T | undefined) => setData(fn), []);
  return { data, error, loading, refetch: run, setData: set };
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Re-render every `ms` (relative times, countdowns). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
