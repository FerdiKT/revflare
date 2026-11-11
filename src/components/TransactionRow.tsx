import { Link } from "react-router";
import { ChevronRight, Megaphone, Zap } from "lucide-react";
import { OFFER_TYPE_LABELS, QUICK_ACTION_MS, type AdsAttribution, type Transaction, type TransactionKind } from "@shared/types";
import { flag } from "@shared/countries";
import { useApps } from "../lib/apps";
import { ago, cn, countryName, dateTime, duration, money, time } from "../lib/format";
import { AppIcon } from "./Logo";
import { StoreGlyph } from "./Platform";
import { Badge, type Tone } from "./ui/Misc";

export const KIND_META: Record<TransactionKind, { label: string; tone: Tone }> = {
  new: { label: "New", tone: "brand" },
  renewal: { label: "Renewal", tone: "blue" },
  trial: { label: "Trial", tone: "violet" },
  conversion: { label: "Conversion", tone: "green" },
  one_time: { label: "One-time", tone: "amber" },
  cancellation: { label: "Cancellation", tone: "red" },
};

export const isQuick = (ms: number | null | undefined): ms is number => typeof ms === "number" && ms >= 0 && ms <= QUICK_ACTION_MS;

/** "⚡ 2 min": bought within 5 minutes of the install, or cancelled within 5 minutes of the purchase. */
export function QuickBadge({ t }: { t: Pick<Transaction, "quick" | "kind" | "sinceInstallMs" | "cancelledAfterMs" | "sincePurchaseMs"> }) {
  if (!t.quick) return null;
  const parts: string[] = [];
  if (t.kind === "cancellation") {
    if (t.sincePurchaseMs != null) parts.push(`Cancelled ${duration(t.sincePurchaseMs)} after the purchase`);
  } else {
    if (isQuick(t.sinceInstallMs)) parts.push(`Bought ${duration(t.sinceInstallMs)} after the install`);
    if (isQuick(t.cancelledAfterMs)) parts.push(`Cancelled ${duration(t.cancelledAfterMs)} after the purchase`);
  }
  const ms = t.kind === "cancellation" ? t.sincePurchaseMs : isQuick(t.sinceInstallMs) ? t.sinceInstallMs : t.cancelledAfterMs;
  return (
    <Badge tone="amber" icon={<Zap />} title={parts.join(" · ") || "Within 5 minutes"}>
      {ms != null ? duration(ms) : "5 min"}
    </Badge>
  );
}

export function KindBadge({ kind }: { kind: TransactionKind }) {
  const m = KIND_META[kind] ?? { label: kind, tone: "zinc" as Tone };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

function storePrice(t: Transaction): string | null {
  if (!t.storeCurrency || t.storeCurrency === "") return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: t.storeCurrency }).format(t.storePrice);
  } catch {
    return `${t.storePrice} ${t.storeCurrency}`;
  }
}

const OFFER_TONES: Record<number, Tone> = { 2: "brand", 3: "blue", 4: "violet" };

/** Promotional / offer code / win-back offers (Apple offerType 2, 3, 4) as a badge; introductory offers show no badge. */
export function OfferBadge({ t }: { t: Pick<Transaction, "offerType" | "offerId"> }) {
  if (!t.offerType || !OFFER_TONES[t.offerType]) return null;
  return (
    <Badge tone={OFFER_TONES[t.offerType]} title={t.offerId ? `Offer ${t.offerId}` : undefined}>
      {OFFER_TYPE_LABELS[t.offerType]}
    </Badge>
  );
}

/** An Apple Ads campaign / ad group / keyword: its name, else "#<id>". */
export function adsName(id: string | null | undefined, name: string | null | undefined): string | null {
  return name || (id ? `#${id}` : null);
}

/** "Apple Ads" badge for purchases whose install Apple attributed (campaign → ad group → keyword in the tooltip). */
export function AdsBadge({ a }: { a: AdsAttribution | null | undefined }) {
  if (!a || a.source !== "apple_ads") return null;
  const path = [adsName(a.campaignId, a.campaignName), adsName(a.adGroupId, a.adGroupName), adsName(a.keywordId, a.keywordName)].filter(Boolean).join(" → ");
  return (
    <Badge tone={a.test ? "zinc" : "blue"} icon={<Megaphone />} title={a.test ? `Test (sandbox) attribution${path ? `: ${path}` : ""}` : path || "Apple Ads"}>
      {a.test ? "Apple Ads (test)" : "Apple Ads"}
    </Badge>
  );
}

/** The offer text next to the date: without the type when the badge shows it. */
export function offerText(t: Pick<Transaction, "offer" | "offerType" | "offerId">): string | null {
  if (t.offerType && OFFER_TONES[t.offerType]) return [t.offerId, t.offer?.match(/\((.+)\)$/)?.[1]].filter(Boolean).join(", ") || null;
  return t.offer;
}

/** One sale in a feed: links to its customer. */
export function TransactionRow({ t, currency, fresh, now, showApp = true }: { t: Transaction; currency: string; fresh?: boolean; now: number; showApp?: boolean }) {
  const local = storePrice(t);
  // Store glyph only when the workspace has Android apps (all-iOS feeds stay as they were).
  const { apps } = useApps();
  const mixed = apps.some((a) => a.platform === "android" || a.platform === "web");
  const body = (
    <>
      {showApp ? <AppIcon name={t.appName} url={t.appIconUrl} size={36} /> : <span className="hidden" />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {mixed && <StoreGlyph store={t.store ?? "app_store"} />}
          <span className="truncate text-sm font-medium">{showApp ? t.appName : (t.productName ?? t.productId)}</span>
          <KindBadge kind={t.kind} />
          {t.kind === "cancellation" && t.purchaseKind === "trial" && <Badge tone="violet">Trial</Badge>}
          <QuickBadge t={t} />
          {t.kind === "trial" && t.autoRenew === false && (t.expiresAt ?? 0) > now && (
            <Badge tone="red" title="Auto-renew is off: the trial ends without converting">
              Cancelled
            </Badge>
          )}
          <OfferBadge t={t} />
          <AdsBadge a={t.attribution} />
          {t.refundedAt && <Badge tone="red">Refunded</Badge>}
          {t.environment !== "Production" && <Badge tone="zinc">{t.environment}</Badge>}
        </div>
        <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
          {showApp && <span>{t.productName ?? t.productId} · </span>}
          {t.country && (
            <span title={countryName(t.country)}>
              {flag(t.country)} {t.country} ·{" "}
            </span>
          )}
          <time dateTime={new Date(t.purchasedAt).toISOString()} title={dateTime(t.purchasedAt)}>
            {time(t.purchasedAt)} · {ago(t.purchasedAt, now)}
          </time>
          {t.kind === "cancellation" && t.sincePurchaseMs != null && (
            <span>
              {" "}
              · {duration(t.sincePurchaseMs)} after the {t.purchaseKind === "trial" ? "trial started" : "purchase"}
            </span>
          )}
          {t.kind !== "cancellation" && t.sinceInstallMs != null && <span> · {duration(t.sinceInstallMs)} after install</span>}
          {offerText(t) && <span> · {offerText(t)}</span>}
        </p>
      </div>
      {t.kind === "cancellation" ? (
        <div className="shrink-0 text-right">
          <p className="text-sm font-semibold text-red-600 dark:text-red-400">Auto-renew off</p>
          {t.expiresAt && (
            <p className="text-xs text-zinc-500">
              {t.expiresAt > now ? "ends" : "ended"} {dateTime(t.expiresAt)}
            </p>
          )}
        </div>
      ) : (
        <div className="shrink-0 text-right">
          <p className={cn("text-sm font-semibold tabular-nums", t.refundedAt && "text-zinc-400 line-through", t.price === 0 && "text-zinc-400")}>{money(t.price, currency)}</p>
          <p className="text-xs text-zinc-500 tabular-nums">
            {t.price ? (
              <>
                {money(t.proceeds, currency)} net{local && t.storeCurrency !== currency && <span className="hidden sm:inline"> · {local}</span>}
              </>
            ) : (
              "free"
            )}
          </p>
        </div>
      )}
      {t.customerId && <ChevronRight className="size-4 shrink-0 text-zinc-300 dark:text-zinc-600" />}
    </>
  );
  const cls = cn("flex items-center gap-3 px-4 py-3 sm:px-5", fresh && "animate-flash");
  return t.customerId ? (
    <Link to={`/customers/${t.customerId}`} className={cn(cls, "transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
