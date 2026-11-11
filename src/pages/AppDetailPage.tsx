import { useState } from "react";
import { Link, useParams } from "react-router";
import { Link as LinkIcon, Activity, Filter, Archive, ArchiveRestore, ArrowLeft, BarChart3, ChevronRight, Compass, FlaskConical, KeyRound, LayoutTemplate, Megaphone, TicketPercent, SlidersHorizontal, Package, PlugZap, Smartphone, RefreshCw, Send, Share2, TriangleAlert, Undo2 } from "lucide-react";
import type { App } from "@shared/types";
import { AppIcon } from "../components/Logo";
import { NotificationBadge } from "../components/NotificationBadge";
import { PlatformBadge, isAndroid } from "../components/Platform";
import { Button } from "../components/ui/Button";
import { useConfirm } from "../components/ui/Confirm";
import { Input } from "../components/ui/Form";
import { Badge, Card, CardHeader, CopyButton, CopyField, ErrorState, Segmented, Skeleton, Stat, Table, td, th } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { AcquisitionStateBadge } from "./AcquisitionPage";
import { PolarCard } from "./PolarCard";
import { api } from "../lib/api";
import { ago, cn, dateTime, dayLabel, fullNumber, money, periodLabel } from "../lib/format";
import { useSession } from "../lib/session";
import { invalidate, useFetch, useNow } from "../lib/useFetch";

const PRODUCT_TYPES: Record<string, string> = {
  auto_renewable: "Auto-renewable subscription",
  non_renewing: "Non-renewing subscription",
  non_consumable: "Non-consumable",
  consumable: "Consumable",
};

export function AppDetailPage() {
  const { id = "" } = useParams();
  const { can, currency } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const now = useNow(30_000);
  const r = useFetch(`app:${id}`, () => api.apps.get(id), { tags: ["apps"] });
  const [busy, setBusy] = useState<string | null>(null);
  const a = r.data;
  const manage = can("manage");
  const android = isAndroid(a);
  const web = a?.platform === "web";

  const run = async (name: string, fn: () => Promise<unknown>, ok: string, desc?: (res: unknown) => string | undefined) => {
    setBusy(name);
    try {
      const res = await fn();
      toast.success(ok, desc?.(res));
      invalidate("apps", "metrics");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  if (r.error)
    return (
      <>
        <BackLink />
        <ErrorState error={r.error} onRetry={r.refetch} />
      </>
    );
  if (!a)
    return (
      <>
        <BackLink />
        <div className="space-y-5">
          <Skeleton className="h-20" />
          <Skeleton className="h-24" />
          <Skeleton className="h-64" />
        </div>
      </>
    );

  const connect = async () => {
    const ok = await confirm({
      title: `Send ${a.name}'s notifications to Revflare?`,
      danger: true,
      confirmLabel: "Replace the URL",
      typeToConfirm: "REPLACE",
      message: (
        <>
          <p>
            This <strong>replaces</strong> the App Store Server Notifications URL of this app in App Store Connect (production and sandbox) with Revflare&rsquo;s.
          </p>
          {a.currentNotificationUrl && (
            <p className="rounded-lg bg-zinc-100 px-3 py-2 font-mono text-xs break-all text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">Current: {a.currentNotificationUrl}</p>
          )}
          <p className="font-medium text-amber-700 dark:text-amber-400">
            {a.currentNotificationUrl
              ? "Revflare forwards every notification, unchanged, to the current URL above, so the service behind it (for example RevenueCat) keeps getting them. You can change or remove the forwarding URL on this page."
              : "Nothing receives this app's notifications now."}
          </p>
          <p>Without this, Revflare keeps reading Apple&rsquo;s notification history every few minutes, which is enough for most dashboards.</p>
        </>
      ),
    });
    if (ok) await run("connect", () => api.apps.connectNotifications(a.id), "Notifications now go to Revflare", () => "Send a test notification to check.");
  };

  const rotateSdkKey = async () => {
    if (a.sdkKey) {
      const ok = await confirm({
        title: `Rotate ${a.name}'s SDK key?`,
        danger: true,
        confirmLabel: "Rotate key",
        message: (
          <>
            <p>
              The current key <span className="font-mono text-xs">{a.sdkKey}</span> <strong>stops working at once</strong>: installs of app versions that embed it can no longer report {android ? "installs, purchases and events" : "Apple Ads attribution"}.
            </p>
            <p>Ship an app update with the new key first, unless the old key leaked.</p>
          </>
        ),
      });
      if (!ok) return;
    }
    await run("sdk-key", () => api.apps.rotateSdkKey(a.id), a.sdkKey ? "SDK key rotated" : "SDK key created", () => (android ? "Put the new key in the RevflareKit configuration of the app and ship an update." : "Put the new key in Revflare.configure(sdkKey:server:) and ship an update."));
  };

  return (
    <>
      <BackLink />
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <AppIcon name={a.name} url={a.iconUrl} size={64} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{a.name}</h1>
            <PlatformBadge platform={a.platform} />
            <NotificationBadge app={a} />
            {a.archived && <Badge>Archived</Badge>}
          </div>
          <p className="mt-0.5 text-sm text-zinc-500">
            {a.bundleId ?? (android ? "No package name" : web ? "Website (Polar)" : "No bundle id")}
            {!android && a.appleAppId && (
              <>
                {" "}
                ·{" "}
                <a href={`https://apps.apple.com/app/id${a.appleAppId}`} target="_blank" rel="noreferrer" className="hover:underline">
                  App Store id {a.appleAppId}
                </a>
              </>
            )}
          </p>
        </div>
        <Link
          to={`/charts?apps=${a.id}`}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-white px-3.5 text-sm font-medium text-zinc-800 shadow-sm ring-1 ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-zinc-700"
        >
          <BarChart3 className="size-4" /> Charts
        </Link>
      </div>

      <Card className="grid grid-cols-2 gap-5 p-5 sm:grid-cols-4">
        <Stat label="MRR" value={money(a.mrr, currency)} />
        <Stat label="Revenue · 28 days" value={money(a.revenue28d, currency)} />
        <Stat label="Active subscriptions" value={fullNumber(a.activeSubscriptions)} />
        <Stat label="Active trials" value={fullNumber(a.activeTrials)} />
      </Card>

      <div className="mt-5 grid gap-5 lg:grid-cols-3 [&>*]:min-w-0">
        {web ? (
          <PolarCard app={a} now={now} manage={manage} />
        ) : android ? (
          <GooglePlayCard app={a} now={now} />
        ) : (
          <Card className="lg:col-span-2">
            <CardHeader title="App Store Server Notifications" description="How Revflare hears about this app's sales." />
            <div className="space-y-5 px-5 pb-5">
              <StatusExplainer status={a.notificationUrlStatus} storeAvailable={a.storeAvailable} current={a.currentNotificationUrl} />
              <div>
                <p className="mb-1.5 text-xs font-medium text-zinc-500">Revflare notification URL</p>
                <CopyField value={a.revflareNotificationUrl} />
                <details className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
                  <summary className="cursor-pointer font-medium text-zinc-800 dark:text-zinc-200">Set it up in App Store Connect by hand</summary>
                  <ol className="mt-2 list-decimal space-y-1 pl-5">
                    <li>
                      Open{" "}
                      <a href="https://appstoreconnect.apple.com/apps" target="_blank" rel="noreferrer" className="text-brand-700 hover:underline dark:text-brand-400">
                        App Store Connect
                      </a>{" "}
                      → your app → <strong>App Information</strong>.
                    </li>
                    <li>
                      Under <strong>App Store Server Notifications</strong>, set the Production and Sandbox Server URLs to the URL above, with <strong>Version 2</strong> notifications.
                    </li>
                    <li>Save, then use “Send test notification” here to check that it arrives.</li>
                    <li>Using RevenueCat too? Keep RevenueCat&rsquo;s URL in App Store Connect and add Revflare&rsquo;s as the forwarding URL in RevenueCat instead.</li>
                  </ol>
                </details>
              </div>
              <ForwardSetting app={a} manage={manage} busy={busy === "forward"} save={(url) => run("forward", () => api.apps.update(a.id, { forwardNotificationUrl: url }), url ? "Forwarding saved" : "Forwarding turned off")} />
              <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-zinc-500">Last notification</dt>
                  <dd className="mt-0.5 font-medium" title={a.lastNotificationAt ? dateTime(a.lastNotificationAt) : undefined}>
                    {a.lastNotificationAt ? ago(a.lastNotificationAt, now) : "Never"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-500">Last history sync</dt>
                  <dd className="mt-0.5 font-medium" title={a.lastHistorySyncAt ? dateTime(a.lastHistorySyncAt) : undefined}>
                    {a.lastHistorySyncAt ? ago(a.lastHistorySyncAt, now) : "Never"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-500">History imported from</dt>
                  <dd className="mt-0.5 font-medium">{a.historyBackfilledFrom ?? "Not yet"}</dd>
                </div>
              </dl>
              {manage && (
                <div className="flex flex-wrap gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
                  <Button
                    icon={<Send className="size-4" />}
                    loading={busy === "test"}
                    onClick={() => run("test", () => api.apps.testNotification(a.id, "Sandbox"), "Test notification requested", () => "Apple sends a TEST notification to the app's Sandbox URL within a minute.")}
                  >
                    Send test notification (Sandbox)
                  </Button>
                  <Button
                    icon={<RefreshCw className="size-4" />}
                    loading={busy === "sync"}
                    onClick={() =>
                      run("sync", () => api.apps.sync(a.id), "Synced with Apple", (res) => {
                        const r = res as { history?: { processed?: number; error?: string }; transactions?: { transactions?: number } | null };
                        if (r.history?.error) return r.history.error;
                        return `${fullNumber(r.history?.processed ?? 0)} notifications, ${fullNumber(r.transactions?.transactions ?? 0)} transactions`;
                      })
                    }
                  >
                    Sync now
                  </Button>
                  {a.notificationUrlStatus !== "revflare" && (
                    <Button variant="outline" icon={<PlugZap className="size-4" />} loading={busy === "connect"} onClick={connect} disabled={!a.appleAppId} title={a.appleAppId ? undefined : "Needs the App Store id"}>
                      Connect notifications to Revflare
                    </Button>
                  )}
                </div>
              )}
            </div>
          </Card>
        )}

        <div className="space-y-5">
          <Card className={web ? "hidden" : undefined}>
            <CardHeader
              title={android ? "Google Play service fee" : "Apple commission"}
              description={
                android
                  ? "15% for subscriptions and the first $1M a year, 30% otherwise. Used to estimate proceeds until Google's order data confirms them."
                  : "15% for the Small Business Program (and subscriptions after a year), 30% otherwise. Used to estimate proceeds until Apple's reports confirm them."
              }
            />
            <div className="px-5 pb-5">
              <Segmented
                label="Commission"
                value={String(a.commissionPct) as "15" | "30"}
                onChange={async (v) => {
                  if (!manage) return;
                  const ok = await confirm({ title: `Use a ${v}% commission?`, message: "Unconfirmed proceeds of this app are re-estimated and its metrics rebuilt.", confirmLabel: `Switch to ${v}%` });
                  if (ok) await run("commission", () => api.apps.update(a.id, { commissionPct: Number(v) as 15 | 30 }), `Commission set to ${v}%`);
                }}
                options={[
                  { value: "15", label: android ? "15%" : "15% · Small Business" },
                  { value: "30", label: "30%" },
                ]}
              />
            </div>
          </Card>
          {manage && (
            <Card className="p-5">
              <p className="text-sm font-semibold">{a.archived ? "Archived" : "Archive"}</p>
              <p className="mt-1 text-[13px] text-zinc-500">{a.archived ? "Archived apps are hidden from the app filter and skipped by imports. Their history stays." : "Hide the app from filters and stop importing it. Its history stays."}</p>
              <Button
                className="mt-3"
                icon={a.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
                loading={busy === "archive"}
                onClick={async () => {
                  if (!a.archived && !(await confirm({ title: `Archive ${a.name}?`, message: "You can restore it at any time.", confirmLabel: "Archive" }))) return;
                  await run("archive", () => api.apps.update(a.id, { archived: !a.archived }), a.archived ? "App restored" : "App archived");
                }}
              >
                {a.archived ? "Restore" : "Archive app"}
              </Button>
            </Card>
          )}
        </div>
      </div>

      {android ? <SdkKeyCard app={a} manage={manage} busy={busy === "sdk-key"} onRotate={rotateSdkKey} /> : <AttributionCard app={a} manage={manage} busy={busy === "sdk-key"} onRotate={rotateSdkKey} />}

      <OfferingsCard app={a} />

      <EventsCard app={a} />

      <IntegrationsCard app={a} />

      {!android && <AcquisitionCard app={a} now={now} />}

      <Card className="mt-5 overflow-hidden">
        <CardHeader title="Products" description={android ? "From the transactions seen so far." : "From App Store Connect and the transactions seen so far."} />
        {a.products.length === 0 ? (
          <div className="flex flex-col items-center px-5 pb-8 text-center">
            <Package className="size-6 text-zinc-300 dark:text-zinc-600" />
            <p className="mt-2 text-sm text-zinc-500">{android ? "No products yet: they appear with the first sale." : "No products yet. Use “Sync products” on the Apps page, or they appear with the first sale."}</p>
          </div>
        ) : (
          <Table>
            <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
              <tr>
                <th className={th}>Product</th>
                <th className={th}>Type</th>
                <th className={th}>Period</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {a.products.map((p) => (
                <tr key={p.productId}>
                  <td className={td}>
                    <p className="font-medium">{p.name ?? p.productId}</p>
                    {p.name && <p className="font-mono text-xs text-zinc-500">{p.productId}</p>}
                  </td>
                  <td className={cn(td, "text-zinc-600 dark:text-zinc-300")}>{p.type ? (PRODUCT_TYPES[p.type] ?? p.type) : "—"}</td>
                  <td className={cn(td, "text-zinc-600 dark:text-zinc-300")}>{periodLabel(p.period)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}

function BackLink() {
  return (
    <Link to="/apps" className="mb-4 inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
      <ArrowLeft className="size-4" /> Apps
    </Link>
  );
}

function StatusExplainer({ status, storeAvailable, current }: { status: string; storeAvailable: boolean | null; current: string | null }) {
  const box = "rounded-xl px-4 py-3 text-sm ring-1";
  if (storeAvailable === false)
    return <p className={cn(box, "bg-zinc-50 text-zinc-700 ring-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-300 dark:ring-zinc-700")}>This app is not released yet: Apple has no production data for it. Sandbox purchases still show up with the Sandbox filter.</p>;
  if (status === "revflare")
    return <p className={cn(box, "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900")}>Live: Apple sends every purchase, renewal and refund to Revflare within seconds.</p>;
  if (status === "other")
    return (
      <div className={cn(box, "bg-sky-50 text-sky-900 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-900")}>
        <p>
          Notifications go to <span className="font-mono text-xs break-all">{current ?? "another service"}</span> (usually RevenueCat). Revflare reads Apple&rsquo;s notification history every few minutes, so sales
          appear with a short delay.
        </p>
      </div>
    );
  if (status === "none")
    return (
      <p className={cn(box, "flex gap-2 bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900")}>
        <TriangleAlert className="mt-0.5 size-4 shrink-0" /> No notification URL is set for this app. Connect it to Revflare to receive sales live.
      </p>
    );
  return <p className={cn(box, "bg-zinc-50 text-zinc-700 ring-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-300 dark:ring-zinc-700")}>Revflare could not read this app&rsquo;s notification URL. Add an App Store Connect API key and import apps again.</p>;
}

/** RevflareKit: the public SDK key and how to wire it up for Apple Ads attribution. */
function AttributionCard({ app, manage, busy, onRotate }: { app: App; manage: boolean; busy: boolean; onRotate: () => void }) {
  const key = app.sdkKey ?? "YOUR_SDK_KEY";
  const snippet = `import RevflareKit

// App launch (App init or application(_:didFinishLaunchingWithOptions:))
Revflare.configure(sdkKey: "${key}", server: URL(string: "${window.location.origin}")!)

// StoreKit 2 purchases: tag them with the install id
let result = try await product.purchase(options: [
  .appAccountToken(Revflare.installId)
])`;
  return (
    <Card className="mt-5">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Megaphone className="size-4 text-brand-600 dark:text-brand-400" /> Apple Ads attribution
          </span>
        }
        description="RevflareKit sends Apple's attribution token from the app; Revflare asks Apple which Apple Ads campaign, ad group and keyword brought the install and joins its revenue to them."
        action={
          <Link to={`/apple-ads?apps=${app.id}`} className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
            <LinkIcon className="size-3.5" /> Attributed revenue
          </Link>
        }
      />
      <div className="grid gap-5 px-5 pb-5 lg:grid-cols-5 [&>*]:min-w-0">
        <div className="space-y-4 lg:col-span-2">
          <div>
            <p className="mb-1.5 text-xs font-medium text-zinc-500">SDK key</p>
            {app.sdkKey ? <CopyField value={app.sdkKey} /> : <p className="text-sm text-zinc-500">No key yet.</p>}
            <p className="mt-1.5 text-xs text-zinc-500">Public: it ships inside the app and can only report installs and purchases for this app.</p>
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
            <li>
              Add the <strong>RevflareKit</strong> Swift package to the app.
            </li>
            <li>
              Call <code className="font-mono text-xs">Revflare.configure(sdkKey:server:)</code> at launch.
            </li>
            <li>
              StoreKit 2: purchase with <code className="font-mono text-xs">.appAccountToken(Revflare.installId)</code>.
            </li>
          </ol>
          <p className="rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-900 ring-1 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-900">
            Using RevenueCat for purchases? Only <code className="font-mono text-xs">configure</code> is needed: RevflareKit reports the install&rsquo;s original transaction ids itself.
          </p>
          {manage && (
            <Button variant="outline" icon={<KeyRound className="size-4" />} loading={busy} onClick={onRotate}>
              {app.sdkKey ? "Rotate key" : "Create key"}
            </Button>
          )}
        </div>
        <div className="lg:col-span-3">
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-xs font-medium text-zinc-500">Swift</p>
            <CopyButton text={snippet} label="Copy snippet" />
          </div>
          <pre className="overflow-x-auto rounded-xl bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-100 ring-1 ring-zinc-800 scrollbar-thin">
            <code>{snippet}</code>
          </pre>
        </div>
      </div>
    </Card>
  );
}

/** App Analytics report request of the app (App Store acquisition: impressions, page views, downloads by source). */
function AcquisitionCard({ app, now }: { app: App; now: number }) {
  const s = app.acquisition;
  return (
    <Card className="mt-5">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Compass className="size-4 text-brand-600 dark:text-brand-400" /> App Store acquisition
          </span>
        }
        description="Apple's App Analytics reports: impressions, product page views and downloads by source, referrer and campaign."
        action={
          <Link to={`/acquisition?apps=${app.id}`} className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
            <LinkIcon className="size-3.5" /> Acquisition
          </Link>
        }
      />
      <div className="px-5 pb-5">
        {!s ? (
          <p className="text-sm text-zinc-500">No report status available.</p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-zinc-500">Report request</dt>
                <dd className="mt-1">
                  <AcquisitionStateBadge state={s.state} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">Requested</dt>
                <dd className="mt-0.5 font-medium" title={s.requestedAt ? dateTime(s.requestedAt) : undefined}>
                  {s.requestedAt ? ago(s.requestedAt, now) : "Not yet"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">Last report imported</dt>
                <dd className="mt-0.5 font-medium">{s.lastProcessingDate ? dayLabel(s.lastProcessingDate) : "None yet"}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">Data</dt>
                <dd className="mt-0.5 font-medium">{s.lastDay ? `${dayLabel(s.firstDay ?? s.lastDay)} → ${dayLabel(s.lastDay)}` : "None yet"}</dd>
              </div>
            </dl>
            {s.error && <p className="mt-3 text-xs break-words text-red-600 dark:text-red-400">{s.error}</p>}
            {s.state === "none" && <p className="mt-3 text-xs text-zinc-500">Request the reports on the Acquisition page (needs an App Store Connect key with the Admin role). Apple produces the first ones within 1–2 days.</p>}
          </>
        )}
      </div>
    </Card>
  );
}

/** Forwarding of verified notifications to a second service (e.g. RevenueCat's Apple server notification URL). */
function ForwardSetting({ app, manage, busy, save }: { app: App; manage: boolean; busy: boolean; save: (url: string | null) => void }) {
  const [value, setValue] = useState(app.forwardNotificationUrl ?? "");
  const now = useNow();
  const st = app.forwardStatus;
  const ok = st && st.status >= 200 && st.status < 300;
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-zinc-500">Forward notifications to</p>
      <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-400">
        Apple sends an app&rsquo;s notifications to one URL. Revflare passes each verified notification on, unchanged, to this URL — for example RevenueCat&rsquo;s Apple server notification URL
        (RevenueCat → your app → App Store settings), so both stay up to date.
      </p>
      {manage ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save(value.trim() || null);
          }}
        >
          <Input className="min-w-0 flex-1 font-mono text-xs" placeholder="https://api.revenuecat.com/v1/incoming-webhooks/apple-server-to-server-notification/…" value={value} onChange={(e) => setValue(e.target.value)} />
          <Button type="submit" loading={busy} disabled={value.trim() === (app.forwardNotificationUrl ?? "")}>
            Save
          </Button>
          {app.forwardNotificationUrl && (
            <Button type="button" variant="outline" onClick={() => (setValue(""), save(null))}>
              Turn off
            </Button>
          )}
        </form>
      ) : (
        <p className="font-mono text-xs break-all">{app.forwardNotificationUrl ?? "Off"}</p>
      )}
      {app.forwardNotificationUrl && st && (
        <p className={cn("mt-1.5 text-xs", ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")} title={dateTime(st.at)}>
          Last forward {ago(st.at, now)}: {ok ? `delivered (${st.status})` : `failed (${st.status || "network"}${st.error ? `: ${st.error}` : ""})`}
        </p>
      )}
    </div>
  );
}

/** Offerings and placements (paywalls RevflareKit loads remotely) and remote config: their own pages. */
function OfferingsCard({ app }: { app: App }) {
  const rows = [
    { to: `/apps/${app.id}/offerings`, icon: LayoutTemplate, title: "Offerings", text: "Offerings, packages, the current offering and placements" },
    ...(isAndroid(app) ? [] : [{ to: `/apps/${app.id}/offers`, icon: TicketPercent, title: "Offers", text: "Promotional offer signing (allowlist, strict mode), lapsed subscribers and promotional / win-back redemptions" }]),
    { to: `/apps/${app.id}/config`, icon: SlidersHorizontal, title: "Remote config", text: "Parameters and values per country, language, app version, acquisition source or % rollout (like Firebase Remote Config)" },
    { to: `/apps/${app.id}/experiments`, icon: FlaskConical, title: "Experiments", text: "A/B tests on remote config parameters: variants, exposures, trial and paid conversion, revenue per install, rollout" },
  ];
  return (
    <Card className="mt-5">
      <CardHeader title="Paywalls and remote config" description="Change paywall products and app settings without an app update (RevflareKit loads them at launch)." />
      <ul className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-zinc-800 dark:border-zinc-800">
        {rows.map((r) => (
          <li key={r.to}>
            <Link to={r.to} className="flex items-center gap-3 px-5 py-3.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
              <r.icon className="size-4 text-brand-600 dark:text-brand-400" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{r.title}</p>
                <p className="text-xs text-zinc-500">{r.text}</p>
              </div>
              <ChevronRight className="size-4 text-zinc-400" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** App events and funnels (RevflareKit events in Workers Analytics Engine): their own pages. */
function EventsCard({ app }: { app: App }) {
  const rows = [
    { to: `/apps/${app.id}/events`, icon: Activity, title: "Events", text: "Top events, unique installs and events per day" },
    { to: `/apps/${app.id}/funnels`, icon: Filter, title: "Funnels", text: "Where users drop off: onboarding, paywall, trial and purchase steps" },
    { to: `/apps/${app.id}/key-events`, icon: KeyRound, title: "Key events", text: "Events stored exactly (first open, purchases, paywall, onboarding, exposures): extra patterns, daily cap, retention" },
    { to: `/apps/${app.id}/test-devices`, icon: Smartphone, title: "Test devices", text: "Your own installs, left out of events, funnels, experiments, LTV and attribution (like sandbox and Xcode builds)" },
  ];
  return (
    <Card className="mt-5">
      <CardHeader title="Events and funnels" description="App events from RevflareKit (Revflare.track), stored in Cloudflare Workers Analytics Engine; key events also exactly in the database." />
      <ul className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-zinc-800 dark:border-zinc-800">
        {rows.map((r) => (
          <li key={r.to}>
            <Link to={r.to} className="flex items-center gap-3 px-5 py-3.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
              <r.icon className="size-4 text-brand-600 dark:text-brand-400" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{r.title}</p>
                <p className="text-xs text-zinc-500">{r.text}</p>
              </div>
              <ChevronRight className="size-4 text-zinc-400" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Outgoing integrations of the app (Meta Ads, Apple refund requests), each with its own page. */
function IntegrationsCard({ app }: { app: App }) {
  return (
    <Card className="mt-5">
      <CardHeader
        title="Integrations"
        description={isAndroid(app) ? "Send this app's purchases to ad networks so they optimize on real trials, conversions and renewals." : "Send this app's purchases to ad networks so they optimize on real trials, conversions and renewals, and answer Apple's refund requests."}
      />
      <ul className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-zinc-800 dark:border-zinc-800">
        <li>
          <Link to={`/apps/${app.id}/integrations/meta`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
            <Share2 className="size-4 text-brand-600 dark:text-brand-400" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Meta Ads</p>
              <p className="text-xs text-zinc-500">Conversions API: trials, purchases and renewals as app events</p>
            </div>
            <Badge tone={app.metaEnabled ? "green" : "zinc"} dot>
              {app.metaEnabled ? "On" : "Off"}
            </Badge>
            <ChevronRight className="size-4 text-zinc-400" />
          </Link>
        </li>
        {!isAndroid(app) && (
          <li>
            <Link to={`/apps/${app.id}/integrations/refunds`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
              <Undo2 className="size-4 text-brand-600 dark:text-brand-400" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Refund requests</p>
                <p className="text-xs text-zinc-500">Answer Apple&rsquo;s refund requests with consumption information</p>
              </div>
              <Badge tone={app.refundRequestsEnabled ? "green" : "zinc"} dot>
                {app.refundRequestsEnabled ? "On" : "Off"}
              </Badge>
              <ChevronRight className="size-4 text-zinc-400" />
            </Link>
          </li>
        )}
      </ul>
    </Card>
  );
}

/** Android apps: Google Play summary (the setup lives on its own page). */
function GooglePlayCard({ app, now }: { app: App; now: number }) {
  const g = app.googlePlay;
  const check = g?.lastCheck;
  return (
    <Card className="lg:col-span-2">
      <CardHeader
        title="Google Play"
        description="How Revflare hears about this app's sales: real-time developer notifications through Pub/Sub, read with a service account."
        action={
          <Link to={`/apps/${app.id}/google-play`} className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
            <LinkIcon className="size-3.5" /> Google Play settings
          </Link>
        }
      />
      <div className="space-y-4 px-5 pb-5">
        {!g?.configured ? (
          <p className="flex gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" /> No Google Play service account key yet. Open the Google Play settings to connect this app.
          </p>
        ) : app.lastNotificationAt ? (
          <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900">Live: Google Play sends every purchase, renewal, cancellation and refund to Revflare within seconds.</p>
        ) : (
          <p className="rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-900 ring-1 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-900">Service account set; no notification received yet. Finish the Pub/Sub and Play Console steps, then send a test notification.</p>
        )}
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-zinc-500">Package name</dt>
            <dd className="mt-0.5 truncate font-mono text-xs font-medium">{app.bundleId ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Last notification</dt>
            <dd className="mt-0.5 font-medium" title={app.lastNotificationAt ? dateTime(app.lastNotificationAt) : undefined}>
              {app.lastNotificationAt ? ago(app.lastNotificationAt, now) : "Never"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Last check</dt>
            <dd className={cn("mt-0.5 font-medium", check && !check.ok && "text-red-700 dark:text-red-400")} title={check?.error}>
              {check ? `${check.ok ? "OK" : "Failed"} · ${ago(check.at, now)}` : "Never"}
            </dd>
          </div>
        </dl>
        {g && !g.pushAuth && <p className="text-xs text-zinc-500">Push authentication is off: set the push service account on the Google Play page so only Pub/Sub can post to the notification URL.</p>}
        <Link
          to={`/apps/${app.id}/google-play`}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-white px-3.5 text-sm font-medium text-zinc-800 shadow-sm ring-1 ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-zinc-700"
        >
          <PlugZap className="size-4" /> {g?.configured ? "Google Play settings" : "Connect Google Play"}
        </Link>
      </div>
    </Card>
  );
}

/** Android apps: the RevflareKit SDK key (no Apple Ads attribution; installs carry the Play Install Referrer). */
function SdkKeyCard({ app, manage, busy, onRotate }: { app: App; manage: boolean; busy: boolean; onRotate: () => void }) {
  return (
    <Card className="mt-5">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <KeyRound className="size-4 text-brand-600 dark:text-brand-400" /> SDK key
          </span>
        }
        description="RevflareKit reports installs (with their Play Install Referrer: Google Ads, referral or organic), purchases and events with this key."
      />
      <div className="space-y-3 px-5 pb-5">
        {app.sdkKey ? <CopyField value={app.sdkKey} /> : <p className="text-sm text-zinc-500">No key yet.</p>}
        <p className="text-xs text-zinc-500">Public: it ships inside the app and can only report installs and purchases for this app.</p>
        {manage && (
          <Button variant="outline" icon={<KeyRound className="size-4" />} loading={busy} onClick={onRotate}>
            {app.sdkKey ? "Rotate key" : "Create key"}
          </Button>
        )}
      </div>
    </Card>
  );
}
