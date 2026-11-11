import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, CircleCheck, CircleX, FlaskConical, RotateCcw, Save, TriangleAlert, Upload } from "lucide-react";
import type { GooglePlaySettings } from "@shared/types";
import { AppIcon } from "../components/Logo";
import { PlatformBadge } from "../components/Platform";
import { Button } from "../components/ui/Button";
import { Field, Input, Textarea } from "../components/ui/Form";
import { Badge, Card, CardHeader, CopyField, ErrorState, Skeleton } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { ago, dateTime, fullNumber } from "../lib/format";
import { useSession } from "../lib/session";
import { invalidate, useFetch, useNow } from "../lib/useFetch";

const PLAY_PUBLISHER = "google-play-developer-notifications@system.gserviceaccount.com";

/** Apps → Android app → Google Play: service account key, push authentication, RTDN URL, checks and setup steps. */
export function GooglePlayPage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const manage = can("manage");
  const toast = useToast();
  const now = useNow(30_000);
  const app = useFetch(`app:${id}`, () => api.apps.get(id), { tags: ["apps"] });
  const r = useFetch(`google-play:${id}`, () => api.apps.googlePlay.get(id), { tags: ["apps"], refreshMs: 60_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; error?: string } | null>(null);
  const g = r.data;

  const save = async (name: string, b: Parameters<typeof api.apps.googlePlay.update>[1], ok: string): Promise<boolean> => {
    setBusy(name);
    try {
      const res = await api.apps.googlePlay.update(id, b);
      r.setData(() => res);
      invalidate("apps");
      toast.success(ok);
      return true;
    } catch (err) {
      toast.error(err);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const runTest = async () => {
    setBusy("test");
    setTest(null);
    try {
      const res = await api.apps.googlePlay.test(id);
      setTest(res);
      invalidate("apps");
      r.refetch();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  const checkRefunds = async () => {
    setBusy("voided");
    try {
      const res = await api.apps.googlePlay.voided(id);
      if (res.errors.length) toast.error(res.errors[0]);
      else toast.success("Refunds checked", res.refunded ? `${fullNumber(res.refunded)} new refund${res.refunded === 1 ? "" : "s"}` : "No new refunds");
      invalidate("apps", "metrics");
      r.refetch();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  const back = (
    <Link to={`/apps/${id}`} className="mb-4 inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
      <ArrowLeft className="size-4" /> {app.data?.name ?? "App"}
    </Link>
  );
  if (r.error)
    return (
      <>
        {back}
        <ErrorState error={r.error} onRetry={r.refetch} />
      </>
    );
  if (!g)
    return (
      <>
        {back}
        <div className="space-y-5">
          <Skeleton className="h-16" />
          <Skeleton className="h-64" />
          <Skeleton className="h-96" />
        </div>
      </>
    );

  const check = test ? { ...test, at: Date.now() } : g.lastCheck;

  return (
    <>
      {back}
      <div className="mb-6 flex flex-wrap items-center gap-4">
        {app.data && <AppIcon name={app.data.name} url={app.data.iconUrl} size={48} />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Google Play</h1>
            <PlatformBadge platform="android" />
            {g.lastNotificationAt ? (
              <Badge tone="green" dot>
                Live
              </Badge>
            ) : (
              <Badge tone="amber" dot>
                No notification yet
              </Badge>
            )}
          </div>
          <p className="mt-0.5 font-mono text-sm text-zinc-500">{g.packageName}</p>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-3 [&>*]:min-w-0">
        <div className="space-y-5 lg:col-span-2">
          <ServiceAccountCard key={g.credential?.id ?? "none"} g={g} manage={manage} busy={busy === "key"} save={(json) => save("key", { serviceAccount: json }, "Service account key saved")} />

          <Card>
            <CardHeader title="Real-time developer notifications" description="Google Play publishes every purchase, renewal, cancellation and refund to a Pub/Sub topic; a push subscription delivers them to this URL." />
            <div className="space-y-5 px-5 pb-5">
              <div>
                <p className="mb-1.5 text-xs font-medium text-zinc-500">Push endpoint URL</p>
                <CopyField value={g.rtdnUrl} />
                <p className="mt-1.5 flex gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                  <TriangleAlert className="mt-px size-3.5 shrink-0" /> Secret: anyone with this URL can post notifications to it. Turn on push authentication below so Revflare only accepts Pub/Sub&rsquo;s signed pushes.
                </p>
              </div>
              <PushAccountForm key={g.pushServiceAccount ?? ""} g={g} manage={manage} busy={busy === "push"} save={(v) => save("push", { pushServiceAccount: v }, v ? "Push authentication on" : "Push authentication off")} />
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Status" />
            <dl className="space-y-3 px-5 pb-5 text-sm">
              <Row label="Last notification">
                <span title={g.lastNotificationAt ? dateTime(g.lastNotificationAt) : undefined}>{g.lastNotificationAt ? ago(g.lastNotificationAt, now) : "Never"}</span>
              </Row>
              <Row label="Last check">
                {check ? (
                  <span className="inline-flex flex-col items-end gap-0.5">
                    <span className={check.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"} title={dateTime(check.at)}>
                      {check.ok ? <CircleCheck className="mr-1 inline size-3.5" /> : <CircleX className="mr-1 inline size-3.5" />}
                      {check.ok ? "OK" : "Failed"} · {ago(check.at, now)}
                    </span>
                  </span>
                ) : (
                  "Never"
                )}
              </Row>
              {check && !check.ok && check.error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs break-words text-red-800 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-200 dark:ring-red-900">{check.error}</p>}
              <Row label="Last refunds poll">
                <span title={g.voidedCheckedAt ? dateTime(g.voidedCheckedAt) : undefined}>{g.voidedCheckedAt ? ago(g.voidedCheckedAt, now) : "Never"}</span>
              </Row>
            </dl>
            {manage && (
              <div className="flex flex-wrap gap-2 border-t border-zinc-100 px-5 py-4 dark:border-zinc-800">
                <Button icon={<FlaskConical className="size-4" />} loading={busy === "test"} disabled={!g.credential} title={g.credential ? "Read-only check of the service account" : "Add a service account key first"} onClick={runTest}>
                  Test
                </Button>
                <Button icon={<RotateCcw className="size-4" />} loading={busy === "voided"} disabled={!g.credential} onClick={checkRefunds}>
                  Check refunds now
                </Button>
              </div>
            )}
            <p className="px-5 pb-5 text-xs text-zinc-500">Refunds are also polled daily from the Voided Purchases API, for the ones notifications miss.</p>
          </Card>
          <Card className="p-5 text-sm text-zinc-600 dark:text-zinc-400">
            <p className="font-medium text-zinc-800 dark:text-zinc-200">Good to know</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>No history import yet: sales appear from the moment notifications are set up.</li>
              <li>Exact proceeds (after Google&rsquo;s fee and taxes) come from the Orders API; until then they are estimated.</li>
            </ul>
          </Card>
        </div>
      </div>

      <SetupSteps g={g} />
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

function ServiceAccountCard({ g, manage, busy, save }: { g: GooglePlaySettings; manage: boolean; busy: boolean; save: (json: string) => Promise<boolean> }) {
  const [json, setJson] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [editing, setEditing] = useState(!g.credential);
  const c = g.credential;
  return (
    <Card>
      <CardHeader title="Service account key" description="Revflare reads purchases and refunds with the Google Play Android Developer API as this service account." />
      <div className="space-y-4 px-5 pb-5">
        {c ? (
          <dl className="grid gap-3 rounded-xl bg-zinc-50 px-4 py-3 text-sm ring-1 ring-zinc-200 sm:grid-cols-2 dark:bg-zinc-800/40 dark:ring-zinc-800">
            <div className="min-w-0 sm:col-span-2">
              <dt className="text-xs text-zinc-500">Service account</dt>
              <dd className="mt-0.5 truncate font-mono text-xs" title={c.clientEmail ?? undefined}>
                {c.clientEmail ?? c.name}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-zinc-500">Project</dt>
              <dd className="mt-0.5 truncate font-mono text-xs">{c.projectId ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">Scope</dt>
              <dd className="mt-0.5 text-xs">{c.appSpecific ? "This app's own key" : "Workspace key (newest Google Play key in Settings → Store credentials)"}</dd>
            </div>
          </dl>
        ) : (
          <p className="flex gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" /> No service account key yet. Paste the JSON key below (steps 1–3).
          </p>
        )}
        {manage &&
          (editing ? (
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await save(json.trim())) {
                  setJson("");
                  setFileName(null);
                  setEditing(false);
                }
              }}
            >
              <Field label={c ? "Replace with a new key (JSON)" : "Service account key (JSON)"} help="The whole JSON key file. Stored encrypted as this app's key; never shown again.">
                {(fid) => (
                  <div className="space-y-2">
                    <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-zinc-300 px-4 py-3 text-sm text-zinc-600 transition hover:border-brand-400 hover:bg-brand-50/40 focus-within:ring-2 focus-within:ring-brand-500 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-brand-950/20">
                      <Upload className="size-4 text-zinc-400" />
                      <span className="flex-1 truncate">{fileName ?? "Choose a .json file"}</span>
                      <input
                        type="file"
                        accept=".json,application/json"
                        className="sr-only"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          setJson((await file.text()).trim());
                          setFileName(file.name);
                        }}
                      />
                    </label>
                    <Textarea
                      id={fid}
                      value={json}
                      onChange={(e) => setJson(e.target.value)}
                      rows={6}
                      required
                      spellCheck={false}
                      className="font-mono text-xs"
                      placeholder={'{\n  "type": "service_account",\n  "project_id": "example-project",\n  "client_email": "revflare@example-project.iam.gserviceaccount.com",\n  ...\n}'}
                    />
                  </div>
                )}
              </Field>
              <div className="flex gap-2">
                <Button type="submit" variant="primary" icon={<Save className="size-4" />} loading={busy} disabled={!json.trim()}>
                  Save key
                </Button>
                {c && (
                  <Button type="button" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                )}
              </div>
            </form>
          ) : (
            <Button onClick={() => setEditing(true)}>Replace key</Button>
          ))}
      </div>
    </Card>
  );
}

function PushAccountForm({ g, manage, busy, save }: { g: GooglePlaySettings; manage: boolean; busy: boolean; save: (v: string | null) => Promise<boolean> }) {
  const [value, setValue] = useState(g.pushServiceAccount ?? "");
  const v = value.trim();
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-zinc-500">Push authentication</p>
      <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-400">
        The service account the Pub/Sub push subscription authenticates with. When set, Revflare only accepts pushes with a valid Google-signed token for this account.{" "}
        {g.pushServiceAccount ? <span className="text-emerald-700 dark:text-emerald-400">On.</span> : <span className="text-amber-700 dark:text-amber-400">Off: any request to the URL is accepted.</span>}
      </p>
      {manage ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save(v || null);
          }}
        >
          <Input className="min-w-0 flex-1 font-mono text-xs" type="email" placeholder="pubsub-push@example-project.iam.gserviceaccount.com" value={value} onChange={(e) => setValue(e.target.value)} />
          <Button type="submit" loading={busy} disabled={v === (g.pushServiceAccount ?? "")}>
            Save
          </Button>
        </form>
      ) : (
        <p className="font-mono text-xs break-all">{g.pushServiceAccount ?? "Off"}</p>
      )}
    </div>
  );
}

function SetupSteps({ g }: { g: GooglePlaySettings }) {
  const link = "text-brand-700 hover:underline dark:text-brand-400";
  const code = "rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs dark:bg-zinc-800";
  return (
    <Card className="mt-5">
      <CardHeader title="Setup" description="One-time, about 15 minutes. Steps 1–2 can be shared by all your Android apps." />
      <ol className="list-decimal space-y-4 px-5 pb-6 pl-10 text-sm text-zinc-700 dark:text-zinc-300">
        <li>
          <p className="font-medium">Google Cloud project</p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            In the{" "}
            <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer" className={link}>
              Google Cloud console
            </a>
            , create or pick a project and enable the{" "}
            <a href="https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com" target="_blank" rel="noreferrer" className={link}>
              Google Play Android Developer API
            </a>
            .
          </p>
        </li>
        <li>
          <p className="font-medium">Service account and JSON key</p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            IAM &amp; Admin → Service accounts → <strong>Create service account</strong> (no project roles needed). Open it → Keys → Add key → Create new key → <strong>JSON</strong>, and paste the downloaded file in
            &ldquo;Service account key&rdquo; above.
          </p>
        </li>
        <li>
          <p className="font-medium">Give it access in Play Console</p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            <a href="https://play.google.com/console/" target="_blank" rel="noreferrer" className={link}>
              Play Console
            </a>{" "}
            → <strong>Users and permissions</strong> → Invite new users → the service account email{g.credential?.clientEmail && <> (<span className={code}>{g.credential.clientEmail}</span>)</>}. Under App permissions add this app with{" "}
            <strong>View app information</strong> and <strong>View financial data, orders, and cancellation survey responses</strong>. Access can take a few minutes to apply; then press <strong>Test</strong>.
          </p>
        </li>
        <li>
          <p className="font-medium">Pub/Sub topic</p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            In the same project, enable Pub/Sub and{" "}
            <a href="https://console.cloud.google.com/cloudpubsub/topic/list" target="_blank" rel="noreferrer" className={link}>
              create a topic
            </a>{" "}
            (e.g. <span className={code}>play-notifications</span>). On the topic&rsquo;s Permissions, grant <span className={code}>{PLAY_PUBLISHER}</span> the <strong>Pub/Sub Publisher</strong> role.
          </p>
        </li>
        <li>
          <p className="font-medium">Push subscription to Revflare</p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            Create a subscription on the topic with delivery type <strong>Push</strong>, the endpoint URL above, and <strong>Enable authentication</strong> with a service account (it can be the one from step 2). Enter that
            service account&rsquo;s email under &ldquo;Push authentication&rdquo; above. The Pub/Sub service agent (<span className={code}>service-PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com</span>) needs the{" "}
            <strong>Service Account Token Creator</strong> role on it.
          </p>
        </li>
        <li>
          <p className="font-medium">Turn on notifications in Play Console</p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            Play Console → this app → <strong>Monetize</strong> → Monetization setup → <strong>Real-time developer notifications</strong>: enter the full topic name (
            <span className={code}>projects/example-project/topics/play-notifications</span>), save, then <strong>Send test notification</strong>. Revflare raises an info alert &ldquo;Google Play test notification
            received&rdquo; and the last notification above updates.
          </p>
        </li>
      </ol>
    </Card>
  );
}
