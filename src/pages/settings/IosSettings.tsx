import { useCallback, useEffect, useState } from "react";
import { BellRing, QrCode as QrIcon, RefreshCw, Smartphone, Trash2 } from "lucide-react";
import type { PairingCode } from "@shared/types";
import { QrCode } from "../../components/QrCode";
import { Button, IconButton } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/Confirm";
import { Badge, Card, EmptyState, ErrorState, Skeleton } from "../../components/ui/Misc";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { ago, date } from "../../lib/format";
import { useSession } from "../../lib/session";
import { invalidate, useFetch, useNow } from "../../lib/useFetch";
import { Section } from "../SettingsPage";

export function IosSettings() {
  const { me } = useSession();
  return (
    <>
      <Pairing disabled={me.auth !== "session"} />
      <Devices push={me.features.push} />
    </>
  );
}

function Pairing({ disabled }: { disabled: boolean }) {
  const [code, setCode] = useState<PairingCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);
  const now = useNow(1000);

  const create = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setCode(await api.pairingCode());
      setShown(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const left = code ? Math.max(0, Math.floor((code.expiresAt - now) / 1000)) : 0;
  const expired = !!code && left === 0;
  useEffect(() => {
    // Devices list picks up the new phone shortly after pairing.
    if (expired) invalidate("devices");
  }, [expired]);

  return (
    <Section title="Connect your iPhone" description="Scan the code with the Revflare iOS app (or the Camera app) to sign in on your phone. No password needed.">
      <Card className="p-5 sm:p-6">
        {!shown ? (
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-amber-400 text-white shadow-sm">
              <Smartphone className="size-6" />
            </span>
            <div className="flex-1">
              <p className="text-sm font-medium">Live sales, push notifications, widgets and a Live Activity for today&rsquo;s revenue.</p>
              <p className="mt-0.5 text-sm text-zinc-500">The code works once and expires after 10 minutes.</p>
            </div>
            <Button variant="primary" icon={<QrIcon className="size-4" />} onClick={create} loading={busy} disabled={disabled} title={disabled ? "Pairing codes are created from a web session" : undefined}>
              Show QR code
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
            <div className="relative">
              {code ? <QrCode value={code.url} size={208} label="Pairing QR code for the Revflare iOS app" /> : <Skeleton className="size-52 rounded-xl" />}
              {expired && (
                <div className="absolute inset-0 flex flex-col items-center justify-center rounded-xl bg-white/90 text-center text-sm font-medium text-zinc-700 backdrop-blur-sm dark:bg-zinc-900/90 dark:text-zinc-200">
                  Expired
                  <Button size="sm" className="mt-2" icon={<RefreshCw className="size-3.5" />} onClick={create} loading={busy}>
                    New code
                  </Button>
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1 text-center sm:text-left">
              <ol className="space-y-1.5 text-sm text-zinc-600 dark:text-zinc-300">
                <li>1. Open Revflare on your iPhone and tap “Scan QR code”.</li>
                <li>2. Point the camera at this code.</li>
                <li>3. Your phone signs in to this workspace.</li>
              </ol>
              {code && (
                <div className="mt-5">
                  <p className="text-xs text-zinc-500">Or type this code</p>
                  <p className="mt-1 font-mono text-2xl font-semibold tracking-[0.2em] select-all" aria-label={`Code ${code.code.split("").join(" ")}`}>
                    {code.code.slice(0, 5)}-{code.code.slice(5)}
                  </p>
                  <p className="mt-3 text-sm tabular-nums text-zinc-500" aria-live="polite">
                    {expired ? "This code has expired." : `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}
                  </p>
                </div>
              )}
              <div className="mt-4 flex flex-wrap justify-center gap-2 sm:justify-start">
                <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={create} loading={busy}>
                  New code
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShown(false)}>
                  Hide
                </Button>
              </div>
            </div>
          </div>
        )}
        {error && <ErrorState error={error} className="mt-4" />}
      </Card>
    </Section>
  );
}

function Devices({ push }: { push: boolean }) {
  const r = useFetch("devices", api.devices.list, { tags: ["devices"], refreshMs: 30_000 });
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <Section title="Your devices" description="iPhones signed in to your account. Each one has its own notification settings in the app.">
      {!push && (
        <p className="mb-3 rounded-lg bg-amber-50 px-4 py-2.5 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
          Push notifications are not configured on this server (APNS_* settings), so devices cannot receive pushes yet.
        </p>
      )}
      {r.error && <ErrorState error={r.error} onRetry={r.refetch} className="mb-4" />}
      <Card className="overflow-hidden">
        {!r.data ? (
          <Skeleton className="m-5 h-14" />
        ) : r.data.items.length === 0 ? (
          <EmptyState icon={<Smartphone />} title="No devices yet" description="Scan the QR code above with the Revflare iOS app." />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {r.data.items.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <Smartphone className="size-5 text-zinc-400" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {d.name ?? "iPhone"}
                    {d.environment === "sandbox" && <Badge>Sandbox</Badge>}
                    {d.liveActivity && <Badge tone="green">Live Activity</Badge>}
                  </p>
                  <p className="text-xs text-zinc-500">
                    Added {date(d.createdAt)} · {d.lastPushAt ? `last push ${ago(d.lastPushAt)}` : "no push yet"}
                  </p>
                </div>
                <Button
                  size="sm"
                  icon={<BellRing className="size-3.5" />}
                  loading={busy === d.id}
                  disabled={!push}
                  title={push ? undefined : "Push is not configured on this server"}
                  onClick={async () => {
                    setBusy(d.id);
                    try {
                      await api.devices.test(d.id);
                      toast.success("Test push sent", "It should arrive within a few seconds.");
                      invalidate("devices");
                    } catch (err) {
                      toast.error(err);
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  Send test push
                </Button>
                <IconButton
                  label="Remove device"
                  variant="danger"
                  onClick={async () => {
                    if (!(await confirm({ title: `Remove ${d.name ?? "this device"}?`, danger: true, confirmLabel: "Remove", message: "It stops receiving notifications. The app asks to sign in again." }))) return;
                    try {
                      await api.devices.remove(d.id);
                      invalidate("devices");
                    } catch (err) {
                      toast.error(err);
                    }
                  }}
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Section>
  );
}
