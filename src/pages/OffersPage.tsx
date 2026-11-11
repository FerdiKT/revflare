import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, Download, ListChecks, Plus, RefreshCw, Save, TicketPercent, Trash2, TriangleAlert, UserMinus } from "lucide-react";
import type { OfferEntry, OfferKind, OfferSettings, OfferSignatureLogItem } from "@shared/types";
import { AppIcon } from "../components/Logo";
import { AppleOnlyNotice, isAndroid } from "../components/Platform";
import { Button } from "../components/ui/Button";
import { Input, Select, Switch } from "../components/ui/Form";
import { Badge, Card, CardHeader, CopyField, EmptyState, ErrorState, Segmented, Skeleton, Stat, Table, td, th } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { ago, cn, countryLabel, date, dateTime, fullNumber, money } from "../lib/format";
import { useSession } from "../lib/session";
import { invalidate, useFetch, useNow } from "../lib/useFetch";

const STATUS_TONE: Record<OfferSignatureLogItem["status"], "green" | "red" | "amber"> = { signed: "green", not_allowed: "red", not_configured: "amber", not_subscribed: "amber" };

/** Apps → app → Offers: promotional offer signing for RevflareKit, lapsed subscribers, promotional / win-back redemptions. */
export function OffersPage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const manage = can("manage");
  const app = useFetch(`app:${id}`, () => api.apps.get(id), { tags: ["apps"] });
  const r = useFetch(`offers:${id}`, () => api.apps.offers.get(id), { tags: ["apps"] });
  const toast = useToast();
  const [busy, setBusy] = useState<"save" | "import" | null>(null);
  const s = r.data;

  const back = (
    <Link to={`/apps/${id}`} className="mb-4 inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
      <ArrowLeft className="size-4" /> {app.data?.name ?? "App"}
    </Link>
  );
  if (isAndroid(app.data))
    return (
      <>
        {back}
        <AppleOnlyNotice what="Promotional and win-back offers" />
      </>
    );
  if (r.error)
    return (
      <>
        {back}
        <ErrorState error={r.error} onRetry={r.refetch} />
      </>
    );
  if (!s)
    return (
      <>
        {back}
        <div className="space-y-5">
          <Skeleton className="h-16" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </>
    );

  const save = async (b: { offers?: OfferEntry[]; strict?: boolean }, message = "Offers saved") => {
    setBusy("save");
    try {
      const res = await api.apps.offers.update(id, b);
      r.setData(() => res);
      toast.success(message);
      invalidate("apps");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };
  const importOffers = async () => {
    setBusy("import");
    try {
      const res = await api.apps.offers.import(id);
      r.setData(() => res.settings);
      toast.success(`Found ${res.found} offers in App Store Connect, added ${res.added}`);
      for (const e of res.errors) toast.error(e);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };
  const missing = [!s.keyConfigured && "an In-App Purchase key (Settings → Store credentials)", !s.bundleId && "the app's bundle id"].filter(Boolean) as string[];

  return (
    <>
      {back}
      <div className="mb-6 flex flex-wrap items-center gap-4">
        {app.data && <AppIcon name={app.data.name} url={app.data.iconUrl} size={48} />}
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Offers</h1>
          <p className="mt-0.5 text-sm text-zinc-500">
            Promotional offers must be signed with your In-App Purchase key: RevflareKit asks Revflare for the signature, Revflare signs only the offers listed here. Win-back offers need no
            signature. See{" "}
            <a href="https://github.com/FerdiKT/revflare/blob/main/docs/offers.md" target="_blank" rel="noreferrer" className="text-brand-700 hover:underline dark:text-brand-400">
              the guide
            </a>
            .
          </p>
        </div>
      </div>

      {missing.length > 0 && (
        <p className="mb-5 flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-100 dark:ring-amber-900">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          Signing needs {missing.join(" and ")}: until then RevflareKit gets 409 not_configured.
        </p>
      )}

      <AllowlistCard key={JSON.stringify(s.offers)} s={s} manage={manage} busy={busy} save={save} importOffers={importOffers} canImport={!!app.data?.appleAppId} />
      <RedemptionsCard id={id} />
      <LapsedCard id={id} />
      <LogCard id={id} />
    </>
  );
}

function AllowlistCard({
  s,
  manage,
  busy,
  save,
  importOffers,
  canImport,
}: {
  s: OfferSettings;
  manage: boolean;
  busy: "save" | "import" | null;
  save: (b: { offers?: OfferEntry[]; strict?: boolean }, message?: string) => void;
  importOffers: () => void;
  canImport: boolean;
}) {
  const [rows, setRows] = useState<OfferEntry[]>(s.offers);
  const dirty = JSON.stringify(rows) !== JSON.stringify(s.offers);
  const set = (i: number, patch: Partial<OfferEntry>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const bad = rows.some((r) => !/^\S{1,255}$/.test(r.productId) || !/^\S{1,255}$/.test(r.offerId));

  return (
    <Card>
      <CardHeader
        title="Allowlist"
        description="The (product, offer) pairs RevflareKit may get a signature for. Anyone can call the signing endpoint with the app's public SDK key: only these offers are signed, with rate limits per install and per app."
        action={
          manage && (
            <Button size="sm" icon={<Download className="size-3.5" />} loading={busy === "import"} disabled={!canImport} onClick={importOffers}>
              Import from App Store Connect
            </Button>
          )
        }
      />
      <div className="px-5 pb-5">
        <label className="mb-4 flex items-center justify-between gap-4 rounded-xl bg-zinc-50 px-4 py-3 ring-1 ring-zinc-200 dark:bg-zinc-800/40 dark:ring-zinc-700">
          <span>
            <span className="block text-sm font-medium">Strict mode</span>
            <span className="block text-xs text-zinc-500">
              Sign only for installs linked to a subscription (current or lapsed) in the product&rsquo;s subscription group (purchases made with appAccountToken = install id, or reported by
              RevflareKit).
            </span>
          </span>
          <Switch checked={s.strict} onChange={(v) => save({ strict: v }, v ? "Strict mode on" : "Strict mode off")} disabled={!manage || busy !== null} label="Strict mode" />
        </label>
        {rows.length === 0 ? (
          <EmptyState icon={<TicketPercent />} title="No offers yet" description="Add the offer identifiers you set up in App Store Connect (subscription → Promotional Offers), or import them." className="py-8" />
        ) : (
          <Table>
            <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
              <tr>
                <th className={th}>Product id</th>
                <th className={th}>Offer id</th>
                <th className={th}>Kind</th>
                <th className={th}>Label</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((o, i) => (
                <tr key={i}>
                  <td className={td}>
                    <Input value={o.productId} disabled={!manage} aria-label="Product id" className="font-mono text-xs" onChange={(e) => set(i, { productId: e.target.value.trim() })} />
                  </td>
                  <td className={td}>
                    <Input value={o.offerId} disabled={!manage} aria-label="Offer id" className="font-mono text-xs" onChange={(e) => set(i, { offerId: e.target.value.trim() })} />
                  </td>
                  <td className={td}>
                    <Select value={o.kind} disabled={!manage} aria-label="Kind" onChange={(e) => set(i, { kind: e.target.value as OfferKind })}>
                      <option value="promotional">Promotional (signed)</option>
                      <option value="win_back">Win-back (no signature)</option>
                    </Select>
                  </td>
                  <td className={td}>
                    <Input value={o.label ?? ""} disabled={!manage} aria-label="Label" placeholder="optional" onChange={(e) => set(i, { label: e.target.value || null })} />
                  </td>
                  <td className={td}>
                    {manage && (
                      <Button size="sm" variant="ghost" aria-label="Remove" icon={<Trash2 className="size-3.5" />} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {manage && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setRows((rs) => [...rs, { productId: "", offerId: "", label: null, kind: "promotional" }])}>
              Add offer
            </Button>
            <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} loading={busy === "save"} disabled={!dirty || bad} onClick={() => save({ offers: rows })}>
              Save allowlist
            </Button>
          </div>
        )}
        {s.sdkKey && (
          <div className="mt-5">
            <p className="mb-1 text-xs font-medium text-zinc-500">SDK key (RevflareKit)</p>
            <CopyField value={s.sdkKey} />
          </div>
        )}
      </div>
    </Card>
  );
}

function RedemptionsCard({ id }: { id: string }) {
  const [range, setRange] = useState("90d");
  const r = useFetch(`offers-stats:${id}:${range}`, () => api.apps.offers.stats(id, range), { tags: ["apps"] });
  const d = r.data;
  return (
    <Card className="mt-5 overflow-hidden">
      <CardHeader
        title="Redemptions"
        description="Purchases made with a promotional (offerType 2) or win-back (offerType 4) offer, from the App Store transactions."
        action={
          <Segmented
            size="sm"
            label="Range"
            value={range}
            onChange={setRange}
            options={[
              { value: "30d", label: "30d" },
              { value: "90d", label: "90d" },
              { value: "12m", label: "12m" },
            ]}
          />
        }
      />
      {r.error ? (
        <ErrorState error={r.error} onRetry={r.refetch} className="m-5" />
      ) : !d ? (
        <div className="p-5">
          <Skeleton className="h-24" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-5 border-t border-zinc-100 p-5 dark:border-zinc-800">
            <Stat label="Redemptions" value={fullNumber(d.totals.redemptions)} />
            <Stat label="Revenue" value={money(d.totals.revenue, d.currency)} />
            <Stat label="Proceeds" value={money(d.totals.proceeds, d.currency)} />
          </div>
          {d.items.length > 0 && (
            <Table>
              <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
                <tr>
                  <th className={th}>Type</th>
                  <th className={th}>Offer</th>
                  <th className={th}>Product</th>
                  <th className={cn(th, "text-right")}>Redemptions</th>
                  <th className={cn(th, "text-right")}>Customers</th>
                  <th className={cn(th, "text-right")}>Revenue</th>
                  <th className={cn(th, "text-right")}>Proceeds</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {d.items.map((i) => (
                  <tr key={`${i.offerType}:${i.offerId}:${i.productId}`}>
                    <td className={td}>
                      <Badge tone={i.offerType === 4 ? "violet" : "brand"}>{i.offerTypeLabel}</Badge>
                    </td>
                    <td className={td}>
                      {i.label ?? <span className="font-mono text-xs">{i.offerId ?? "—"}</span>}
                      {i.label && <p className="font-mono text-xs text-zinc-500">{i.offerId}</p>}
                    </td>
                    <td className={cn(td, "font-mono text-xs")}>{i.productId}</td>
                    <td className={cn(td, "text-right tabular-nums")}>{fullNumber(i.redemptions)}</td>
                    <td className={cn(td, "text-right tabular-nums")}>{fullNumber(i.customers)}</td>
                    <td className={cn(td, "text-right tabular-nums")}>{money(i.revenue, d.currency)}</td>
                    <td className={cn(td, "text-right tabular-nums")}>{money(i.proceeds, d.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </>
      )}
    </Card>
  );
}

function LapsedCard({ id }: { id: string }) {
  const [days, setDays] = useState("90");
  const r = useFetch(`lapsed:${id}:${days}`, () => api.apps.offers.lapsed(id, Number(days)), { tags: ["apps"] });
  const navigate = useNavigate();
  const d = r.data;
  return (
    <Card className="mt-5 overflow-hidden">
      <CardHeader
        title="Lapsed subscribers"
        description="Subscriptions that expired without auto-renew (grace period and billing retry are still subscribers): the audience for a promotional or win-back offer."
        action={
          <Segmented
            size="sm"
            label="Window"
            value={days}
            onChange={setDays}
            options={[
              { value: "30", label: "30d" },
              { value: "90", label: "90d" },
              { value: "365", label: "1y" },
            ]}
          />
        }
      />
      {r.error ? (
        <ErrorState error={r.error} onRetry={r.refetch} className="m-5" />
      ) : !d ? (
        <div className="p-5">
          <Skeleton className="h-24" />
        </div>
      ) : d.total === 0 ? (
        <EmptyState icon={<UserMinus />} title="No lapsed subscribers" description={`No subscription expired without auto-renew in the last ${d.days} days.`} className="py-8" />
      ) : (
        <>
          <div className="flex flex-wrap gap-x-8 gap-y-3 border-t border-zinc-100 p-5 dark:border-zinc-800">
            <Stat label="Lapsed" value={fullNumber(d.total)} sub={`last ${d.days} days`} />
            {d.byProduct.slice(0, 6).map((p) => (
              <Stat key={p.productId} label={p.productName ?? p.productId} value={fullNumber(p.count)} />
            ))}
          </div>
          <Table>
            <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
              <tr>
                <th className={th}>Expired</th>
                <th className={th}>Customer</th>
                <th className={th}>Product</th>
                <th className={th}>Country</th>
                <th className={cn(th, "text-right")}>Total paid</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {d.items.map((i) => (
                <tr
                  key={i.originalTransactionId}
                  className={cn(i.customerId && "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/40")}
                  onClick={() => i.customerId && navigate(`/customers/${i.customerId}`)}
                >
                  <td className={td} title={dateTime(i.expiredAt)}>
                    {date(i.expiredAt)}
                  </td>
                  <td className={cn(td, "font-mono text-xs")}>{i.customerId ?? i.originalTransactionId}</td>
                  <td className={td}>{i.productName ?? i.productId}</td>
                  <td className={td}>{countryLabel(i.country)}</td>
                  <td className={cn(td, "text-right tabular-nums")}>{money(i.totalPaid, d.currency)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {d.total > d.items.length && <p className="px-5 py-3 text-xs text-zinc-500">The {d.items.length} most recent of {fullNumber(d.total)}.</p>}
        </>
      )}
    </Card>
  );
}

function LogCard({ id }: { id: string }) {
  const log = useFetch(`offers-log:${id}`, () => api.apps.offers.log(id), { tags: ["apps"], refreshMs: 60_000 });
  const now = useNow(30_000);
  return (
    <Card className="mt-5 overflow-hidden">
      <CardHeader
        title="Signature requests"
        description="The last 100 requests from RevflareKit (Revflare keeps the last 1000 per app). Rate-limited requests are not logged."
        action={
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={log.refetch}>
            Refresh
          </Button>
        }
      />
      {log.error ? (
        <ErrorState error={log.error} onRetry={log.refetch} className="m-5" />
      ) : !log.data ? (
        <div className="space-y-2 p-5">
          <Skeleton className="h-10" />
        </div>
      ) : log.data.items.length === 0 ? (
        <EmptyState icon={<ListChecks />} title="No signature requests yet" description="They show up here when the app asks for a promotional offer signature." className="py-8" />
      ) : (
        <Table>
          <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
            <tr>
              <th className={th}>When</th>
              <th className={th}>Install</th>
              <th className={th}>Product</th>
              <th className={th}>Offer</th>
              <th className={th}>Status</th>
              <th className={th}>Build</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {log.data.items.map((i, n) => (
              <tr key={`${i.at}:${n}`}>
                <td className={cn(td, "text-zinc-600 dark:text-zinc-300")} title={dateTime(i.at)}>
                  {ago(i.at, now)}
                </td>
                <td className={cn(td, "font-mono text-xs")}>{i.installId}</td>
                <td className={cn(td, "font-mono text-xs")}>{i.productId}</td>
                <td className={cn(td, "font-mono text-xs")}>{i.offerId}</td>
                <td className={td}>
                  <Badge tone={STATUS_TONE[i.status]}>{i.status.replace(/_/g, " ")}</Badge>
                  {i.count > 1 && <span className="ml-1.5 text-xs text-muted-foreground" title={`Sampled: stands for ${i.count} refusals`}>×{i.count}</span>}
                </td>
                <td className={cn(td, "text-xs")}>{i.environment ? i.environment === "production" ? "production" : <Badge tone="amber">{i.environment}</Badge> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
