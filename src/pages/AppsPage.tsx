import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { AppWindow, DownloadCloud, Plus, RefreshCw } from "lucide-react";
import { AppIcon } from "../components/Logo";
import { NotificationBadge } from "../components/NotificationBadge";
import { PlatformBadge } from "../components/Platform";
import { Button } from "../components/ui/Button";
import { Dialog } from "../components/ui/Dialog";
import { Field, Input } from "../components/ui/Form";
import { Badge, Card, EmptyState, ErrorState, PageHeader, Segmented, Skeleton, Table, td, th } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { useConfirm } from "../components/ui/Confirm";
import { api } from "../lib/api";
import { useApps } from "../lib/apps";
import { ago, cn, fullNumber, money } from "../lib/format";
import { useSession } from "../lib/session";
import { invalidate, useNow } from "../lib/useFetch";

export function AppsPage() {
  const { apps, loading, error, currency } = useApps();
  const { can, currency: wsCurrency } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const now = useNow(60_000);
  const [show, setShow] = useState<"active" | "archived">("active");
  const [adding, setAdding] = useState(false);
  const [addingAndroid, setAddingAndroid] = useState(false);
  const [platform, setPlatform] = useState<"all" | "ios" | "android" | "web">("all");
  const [importing, setImporting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const cur = currency ?? wsCurrency;
  const hasAndroid = apps.some((a) => a.platform === "android" || a.platform === "web");
  const hasWeb = apps.some((a) => a.platform === "web");
  const list = apps.filter((a) => (show === "archived") === a.archived && (!hasAndroid || platform === "all" || platform === (a.platform || "ios")));
  const archivedCount = apps.filter((a) => a.archived).length;

  const importApps = async () => {
    const setUrls = await confirm({
      title: "Import apps from App Store Connect",
      message: (
        <>
          <p>Revflare reads your apps with the App Store Connect API key in Settings → Store credentials.</p>
          <p>
            Apps <strong>without</strong> a notification URL will be pointed at Revflare. Apps whose URL points elsewhere (for example RevenueCat) are left alone: Revflare reads their notification history
            instead.
          </p>
        </>
      ),
      confirmLabel: "Import",
    });
    if (!setUrls) return;
    setImporting(true);
    try {
      const r = await api.apps.import("empty");
      const list = (Array.isArray(r.apps) ? r.apps : []) as Array<{ created: boolean; urlSet: boolean; error?: string }>;
      const created = list.filter((a) => a.created).length;
      const urls = list.filter((a) => a.urlSet).length;
      const failed = list.filter((a) => a.error).length;
      toast.success(
        `${list.length} app${list.length === 1 ? "" : "s"} found`,
        [`${created} new`, urls ? `${urls} now send notifications to Revflare` : null, failed ? `${failed} could not be connected` : null].filter(Boolean).join(" · "),
      );
      invalidate("apps");
    } catch (err) {
      toast.error(err);
    } finally {
      setImporting(false);
    }
  };

  const syncProducts = async () => {
    setSyncing(true);
    try {
      await api.apps.syncProducts();
      toast.success("Products synced", "Names and periods come from App Store Connect.");
      invalidate("apps");
    } catch (err) {
      toast.error(err);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Apps"
        description="Your apps, their revenue and where their sales come from."
        actions={
          can("manage") && (
            <>
              <Button icon={<RefreshCw className="size-4" />} onClick={syncProducts} loading={syncing}>
                Sync products
              </Button>
              <Button icon={<DownloadCloud className="size-4" />} onClick={importApps} loading={importing}>
                Import from App Store Connect
              </Button>
              <Button icon={<Plus className="size-4" />} onClick={() => setAddingAndroid(true)}>
                Add Android app
              </Button>
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
                Add iOS app
              </Button>
            </>
          )
        }
      />
      {(archivedCount > 0 || hasAndroid) && (
        <div className="mb-4 flex flex-wrap gap-2">
          {hasAndroid && (
            <Segmented
              label="Platform"
              value={platform}
              onChange={setPlatform}
              options={[
                { value: "all", label: "All" },
                { value: "ios", label: "iOS" },
                { value: "android", label: "Android" },
                ...(hasWeb ? [{ value: "web" as const, label: "Web" }] : []),
              ]}
            />
          )}
          {archivedCount > 0 && (
            <Segmented
              label="Show"
              value={show}
              onChange={setShow}
              options={[
                { value: "active", label: "Active" },
                { value: "archived", label: `Archived (${archivedCount})` },
              ]}
            />
          )}
        </div>
      )}
      {error && <ErrorState error={error} className="mb-4" />}
      <Card className="overflow-hidden">
        {loading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            icon={<AppWindow />}
            title={show === "archived" ? "No archived apps" : apps.length ? "No apps match" : "No apps yet"}
            description="Import your iOS apps from App Store Connect (needs an App Store Connect API key in Settings → Store credentials), add one by bundle id, or add an Android app by package name."
            action={
              can("manage") && show === "active" ? (
                <>
                  <Button icon={<DownloadCloud className="size-4" />} onClick={importApps} loading={importing}>
                    Import from App Store Connect
                  </Button>
                  <Button icon={<Plus className="size-4" />} onClick={() => setAddingAndroid(true)}>
                    Add Android app
                  </Button>
                  <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
                    Add iOS app
                  </Button>
                </>
              ) : undefined
            }
          />
        ) : (
          <>
          <ul className="divide-y divide-zinc-100 md:hidden dark:divide-zinc-800">
            {list.map((a) => (
              <li key={a.id}>
                <Link to={`/apps/${a.id}`} className="flex items-center gap-3 px-4 py-3.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                  <AppIcon name={a.name} url={a.iconUrl} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{a.name}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
                      <PlatformBadge platform={a.platform} />
                      <NotificationBadge app={a} />
                      <span>{a.lastNotificationAt ? ago(a.lastNotificationAt, now) : "No notification yet"}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold tabular-nums">{money(a.mrr, cur)}</p>
                    <p className="text-xs text-zinc-500 tabular-nums">MRR · {fullNumber(a.activeSubscriptions)} subs</p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <Table className="hidden md:block">
            <thead className="border-b border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
              <tr>
                <th className={th}>App</th>
                <th className={cn(th, "text-right")}>MRR</th>
                <th className={cn(th, "text-right")}>Revenue · 28 days</th>
                <th className={cn(th, "text-right")}>Subscriptions</th>
                <th className={cn(th, "text-right")}>Trials</th>
                <th className={th}>Notifications</th>
                <th className={th}>Last notification</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {list.map((a) => (
                <tr
                  key={a.id}
                  tabIndex={0}
                  onClick={() => navigate(`/apps/${a.id}`)}
                  onKeyDown={(e) => e.key === "Enter" && navigate(`/apps/${a.id}`)}
                  className="cursor-pointer hover:bg-zinc-50 focus-visible:bg-zinc-50 dark:hover:bg-zinc-800/40 dark:focus-visible:bg-zinc-800/40"
                >
                  <td className={td}>
                    <div className="flex items-center gap-3">
                      <AppIcon name={a.name} url={a.iconUrl} size={36} />
                      <div className="min-w-0">
                        <p className="font-medium">
                          {a.name}
                          {a.commissionPct === 30 && (
                            <Badge className="ml-2" tone="zinc">
                              30%
                            </Badge>
                          )}
                        </p>
                        <p className="flex items-center gap-1.5 text-xs text-zinc-500">
                          <PlatformBadge platform={a.platform} />
                          {a.bundleId ?? "—"}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className={cn(td, "text-right font-medium tabular-nums")}>{money(a.mrr, cur)}</td>
                  <td className={cn(td, "text-right tabular-nums")}>{money(a.revenue28d, cur)}</td>
                  <td className={cn(td, "text-right tabular-nums")}>{fullNumber(a.activeSubscriptions)}</td>
                  <td className={cn(td, "text-right tabular-nums")}>{fullNumber(a.activeTrials)}</td>
                  <td className={td}>
                    <NotificationBadge app={a} />
                  </td>
                  <td className={cn(td, "text-zinc-500")}>
                    {a.lastNotificationAt ? ago(a.lastNotificationAt, now) : "Never"}
                    {a.platform !== "android" && a.notificationUrlStatus === "other" && a.lastHistorySyncAt && <span className="block text-xs text-zinc-400">history synced {ago(a.lastHistorySyncAt, now)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          </>
        )}
      </Card>
      <AddAppDialog open={adding} onClose={() => setAdding(false)} />
      <AddAndroidAppDialog open={addingAndroid} onClose={() => setAddingAndroid(false)} />
    </>
  );
}

function AddAppDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [bundleId, setBundleId] = useState("");
  const [appleAppId, setAppleAppId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add an iOS app"
      description="Usually you import apps from App Store Connect; add one by hand if you prefer."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="add-app" loading={busy}>
            Add app
          </Button>
        </>
      }
    >
      <form
        id="add-app"
        className="space-y-4 p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const app = await api.apps.create({ name, bundleId, appleAppId: appleAppId || undefined });
            invalidate("apps");
            toast.success(`${app.name} added`);
            onClose();
            navigate(`/apps/${app.id}`);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {error && <ErrorState error={error} />}
        <Field label="Name" required>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required data-autofocus />}
        </Field>
        <Field label="Bundle id" required>
          {(id) => <Input id={id} value={bundleId} onChange={(e) => setBundleId(e.target.value)} placeholder="com.example.app" required pattern="[A-Za-z0-9.\-]+" />}
        </Field>
        <Field label="Apple app id" help="The numeric App Store id (optional).">
          {(id) => <Input id={id} value={appleAppId} onChange={(e) => setAppleAppId(e.target.value)} inputMode="numeric" pattern="\d*" />}
        </Field>
      </form>
    </Dialog>
  );
}

const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** Android (Google Play) app by package name; then its Google Play setup page. */
function AddAndroidAppDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [packageName, setPackageName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pkg = packageName.trim();
  const invalid = pkg !== "" && !PACKAGE_RE.test(pkg);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add an Android app"
      description="A Google Play app, by its package name. Its sales arrive through Google Play real-time developer notifications."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="add-android-app" loading={busy} disabled={invalid}>
            Add app
          </Button>
        </>
      }
    >
      <form
        id="add-android-app"
        className="space-y-4 p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!PACKAGE_RE.test(pkg)) return setError("Enter a package name like com.example.app");
          setBusy(true);
          setError(null);
          try {
            const app = await api.apps.create({ platform: "android", name: name.trim(), packageName: pkg });
            invalidate("apps");
            toast.success(`${app.name} added`, "Next: connect Google Play.");
            onClose();
            navigate(`/apps/${app.id}/google-play`);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {error && <ErrorState error={error} />}
        <Field label="Name" required>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required data-autofocus />}
        </Field>
        <Field label="Package name" required error={invalid ? "Letters, digits and underscores in at least two dot-separated parts, e.g. com.example.app" : undefined} help="The applicationId in Play Console (e.g. com.example.app).">
          {(id) => <Input id={id} value={packageName} onChange={(e) => setPackageName(e.target.value)} placeholder="com.example.app" required invalid={invalid} className="font-mono" autoComplete="off" spellCheck={false} />}
        </Field>
      </form>
    </Dialog>
  );
}
