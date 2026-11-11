import type { CustomerEvent } from "@shared/types";
import type { Tone } from "../components/ui/Misc";

const EXPIRED: Record<string, string> = {
  VOLUNTARY: "Expired (cancelled)",
  BILLING_RETRY: "Expired (billing)",
  PRICE_INCREASE: "Expired (price increase)",
  PRODUCT_NOT_FOR_SALE: "Expired (product not for sale)",
};

/** Readable label of an Apple notification (unknown types shown raw); `trial`: its transaction is a free trial. */
export function appleEventLabel(e: Pick<CustomerEvent, "type" | "subtype">, trial = false): { label: string; tone: Tone } {
  const raw = e.subtype ? `${e.type} · ${e.subtype}` : e.type;
  switch (e.type) {
    case "SUBSCRIBED":
      if (e.subtype === "RESUBSCRIBE") return { label: "Resubscribed", tone: "green" };
      return trial ? { label: "Trial started", tone: "violet" } : { label: "Subscribed", tone: "green" };
    case "DID_RENEW":
      return { label: e.subtype === "BILLING_RECOVERY" ? "Renewed (billing recovered)" : "Renewed", tone: "blue" };
    case "DID_CHANGE_RENEWAL_STATUS":
      if (e.subtype === "AUTO_RENEW_DISABLED") return { label: "Auto-renew turned off", tone: "red" };
      if (e.subtype === "AUTO_RENEW_ENABLED") return { label: "Auto-renew turned on", tone: "green" };
      break;
    case "SUBSCRIPTION_CANCELED":
      return { label: "Auto-renew turned off", tone: "red" };
    case "DID_CHANGE_RENEWAL_PREF":
      if (e.subtype === "UPGRADE") return { label: "Plan change (upgrade)", tone: "brand" };
      if (e.subtype === "DOWNGRADE") return { label: "Plan change (downgrade)", tone: "amber" };
      return { label: "Plan change cancelled", tone: "zinc" };
    case "DID_FAIL_TO_RENEW":
      return { label: e.subtype === "GRACE_PERIOD" ? "Billing problem (grace period)" : "Billing problem", tone: "amber" };
    case "GRACE_PERIOD_EXPIRED":
      return { label: "Grace period ended", tone: "amber" };
    case "EXPIRED":
      return { label: (e.subtype && EXPIRED[e.subtype]) ?? "Expired", tone: "zinc" };
    case "REFUND":
      return { label: "Refunded", tone: "red" };
    case "REFUND_DECLINED":
      return { label: "Refund declined", tone: "zinc" };
    case "REFUND_REVERSED":
      return { label: "Refund reversed", tone: "green" };
    case "CONSUMPTION_REQUEST":
      return { label: "Consumption request (refund asked)", tone: "amber" };
    case "OFFER_REDEEMED":
      return { label: e.subtype === "UPGRADE" ? "Offer redeemed (upgrade)" : e.subtype === "DOWNGRADE" ? "Offer redeemed (downgrade)" : "Offer redeemed", tone: "brand" };
    case "PRICE_INCREASE":
      return { label: e.subtype === "ACCEPTED" ? "Price increase accepted" : e.subtype === "PENDING" ? "Price increase (pending consent)" : "Price increase", tone: "amber" };
    case "RENEWAL_EXTENDED":
      return { label: "Renewal date extended", tone: "blue" };
    case "REVOKE":
      return { label: "Access revoked (Family Sharing)", tone: "red" };
    case "ONE_TIME_CHARGE":
      return { label: "Purchase", tone: "green" };
  }
  return { label: raw, tone: "zinc" };
}
