// Forwards App Store Server Notifications to a second service (e.g. RevenueCat) once Revflare has verified them.
// Apple sends each app's notifications to one URL; with forwarding both Revflare and that service get every event.
// The body is passed on unchanged: Apple signed it, so the receiver verifies it as if Apple had sent it.

import { defineDbFunction } from "../lib/db";
import { errorMessage, now } from "../lib/util";

/** Checks a forward URL: https, not this Revflare instance. Returns the cleaned URL or an error. */
export function checkForwardUrl(value: unknown, requestUrl: string): { url: string | null } | { error: string } {
  if (value === null || value === "") return { url: null };
  if (typeof value !== "string" || value.length > 500) return { error: "forwardNotificationUrl must be an https URL" };
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    return { error: "forwardNotificationUrl must be an https URL" };
  }
  if (u.protocol !== "https:") return { error: "forwardNotificationUrl must be an https URL" };
  if (u.host === new URL(requestUrl).host) return { error: "forwardNotificationUrl cannot point at this Revflare instance" };
  return { url: u.toString() };
}

export const recordForward = defineDbFunction("recordForward", async (db, args: { appId: string; status: number; error?: string }) => {
  const value = JSON.stringify({ at: now(), status: args.status, ...(args.error ? { error: args.error.slice(0, 200) } : {}) });
  await db.prepare("UPDATE apps SET forward_status = ? WHERE id = ?").bind(value, args.appId).run();
  return { ok: true };
});

/** POSTs the notification body to the forward URL (10 s timeout, one retry on a network error or 5xx). */
export async function forwardNotification(env: Env, args: { appId: string; url: string; body: string }, fetcher: typeof fetch = (i, init) => fetch(i, init)) {
  let status = 0;
  let error: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetcher(args.url, { method: "POST", headers: { "content-type": "application/json" }, body: args.body, signal: AbortSignal.timeout(10_000) });
      status = res.status;
      error = res.ok ? undefined : (await res.text().catch(() => "")).slice(0, 200) || `HTTP ${res.status}`;
      if (res.status < 500) break;
    } catch (err) {
      status = 0;
      error = errorMessage(err);
    }
  }
  if (error) console.warn(JSON.stringify({ event: "forward_failed", appId: args.appId, status, error }));
  await recordForward(env, { appId: args.appId, status, error }).catch((err) => console.error("recordForward", err));
  return { status, error };
}
