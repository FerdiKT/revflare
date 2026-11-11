// App-wide state for the Workers Free plan's daily database limit (`503 { code: "quota" }`): set by the API client,
// shown as one banner instead of an error on every card, gone at the reset (00:00 UTC) or on "Try again".
import { useSyncExternalStore } from "react";
import { useNow } from "./useFetch";

let until: number | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Next 00:00 UTC. */
export function nextUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export function reportQuota() {
  const u = nextUtcMidnight();
  if (until !== u) {
    until = u;
    emit();
  }
}

export function clearQuota() {
  if (until !== null) {
    until = null;
    emit();
  }
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** When the limit resets (ms) while it is hit, else null. */
export function useQuota(): number | null {
  const u = useSyncExternalStore(subscribe, () => until);
  const now = useNow(30_000);
  return u !== null && u > now ? u : null;
}

/** "5h 12m" / "12m" until `ms`. */
export function countdown(ms: number, now = Date.now()): string {
  const mins = Math.max(1, Math.ceil((ms - now) / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
