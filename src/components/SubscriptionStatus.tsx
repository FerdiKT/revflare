import type { Subscription } from "@shared/types";
import { cancelReasonLabel, dateTime, duration } from "../lib/format";
import { Badge, type Tone } from "./ui/Misc";

const STATUS: Record<Subscription["status"], { label: string; tone: Tone }> = {
  trial: { label: "Trial", tone: "violet" },
  active: { label: "Active", tone: "green" },
  grace: { label: "Grace period", tone: "amber" },
  billing_retry: { label: "Billing retry", tone: "amber" },
  expired: { label: "Expired", tone: "zinc" },
  revoked: { label: "Revoked", tone: "red" },
  refunded: { label: "Refunded", tone: "red" },
};

const RUNNING = new Set<Subscription["status"]>(["trial", "active", "grace", "billing_retry"]);

/** A running subscription whose auto-renew is off: cancelled, it ends at its expiry. */
export const isCancelled = (s: Pick<Subscription, "status" | "autoRenew">) => !s.autoRenew && RUNNING.has(s.status);

export function SubscriptionStatus({ s }: { s: Pick<Subscription, "status" | "autoRenew"> & Partial<Pick<Subscription, "expiresAt" | "autoRenewOffAt" | "cancelReason" | "cancelledAfterMs">> }) {
  const m = STATUS[s.status] ?? { label: s.status, tone: "zinc" as Tone };
  const cancelled = isCancelled(s);
  const reason = cancelReasonLabel(s.cancelReason);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <span className="inline-flex flex-wrap gap-1">
        {cancelled ? (
          <Badge tone="red" dot title="Auto-renew is off: the subscription will not renew">
            {s.status === "trial" ? "Trial cancelled" : "Cancelled"}
          </Badge>
        ) : (
          <Badge tone={m.tone} dot>
            {m.label}
          </Badge>
        )}
        {cancelled && s.status !== "trial" && s.status !== "active" && <Badge tone={m.tone}>{m.label}</Badge>}
      </span>
      {cancelled && (s.expiresAt || s.autoRenewOffAt || reason) && (
        <span className="text-xs text-zinc-500">
          {[
            s.expiresAt ? `ends ${dateTime(s.expiresAt)}` : null,
            s.autoRenewOffAt || reason
              ? ["cancelled", s.autoRenewOffAt ? dateTime(s.autoRenewOffAt) : null, s.cancelledAfterMs != null ? `(${duration(s.cancelledAfterMs)} after the purchase)` : null, reason].filter(Boolean).join(" ")
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      )}
      {!cancelled && reason && s.status !== "active" && s.status !== "trial" && <span className="text-xs text-zinc-500">Cancelled {reason}</span>}
    </span>
  );
}
