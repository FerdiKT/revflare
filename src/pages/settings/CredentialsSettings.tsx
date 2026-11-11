import { useState } from "react";
import { FileKey2, Plus, Trash2, Upload, Vault } from "lucide-react";
import type { CredentialKind, CredentialView } from "@shared/types";
import { Button, IconButton } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/Confirm";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Textarea } from "../../components/ui/Form";
import { Badge, Card, EmptyState, ErrorState, Segmented, Skeleton } from "../../components/ui/Misc";
import { useToast } from "../../components/ui/Toast";
import { api, type NewCredential } from "../../lib/api";
import { invalidate, useFetch } from "../../lib/useFetch";
import { Section } from "../SettingsPage";

const KINDS: Record<CredentialKind, { label: string; help: string }> = {
  appstore_iap: {
    label: "In-App Purchase key",
    help: "App Store Server API: transaction and notification history, test notifications. App Store Connect → Users and Access → Integrations → In-App Purchase.",
  },
  appstore_connect: {
    label: "App Store Connect API key",
    help: "Imports apps, products and notification URLs; with the Sales role and the vendor number also the daily Sales and Trends reports. Users and Access → Integrations → App Store Connect API.",
  },
  appstore_reports: {
    label: "App Store Connect reports key",
    help: "Optional key used only for reports (Sales and Trends, App Analytics) — e.g. a key with the Sales role. Reports try it before the main App Store Connect key. Requesting App Analytics reports needs the Admin role.",
  },
  revenuecat: { label: "RevenueCat secret key", help: "A v2 secret API key (sk_...) with read access, and the project id, to import history from RevenueCat." },
  google_play: {
    label: "Google Play service account",
    help: "Android apps: a Google Cloud service account JSON key with access to the Google Play Android Developer API, invited in Play Console with financial data access. Each Android app's Google Play page has the full setup.",
  },
};

export function CredentialsSettings() {
  const r = useFetch("credentials", api.credentials.list, { tags: ["credentials"] });
  const [adding, setAdding] = useState<CredentialKind | null>(null);
  return (
    <Section
      title="Store credentials"
      description="Keys Revflare uses to talk to Apple, Google Play and RevenueCat. Secrets are encrypted at rest and never shown again."
      action={
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding("appstore_iap")}>
          Add credential
        </Button>
      }
    >
      {r.error && <ErrorState error={r.error} onRetry={r.refetch} className="mb-4" />}
      {!r.data ? (
        <Skeleton className="h-40" />
      ) : r.data.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Vault />}
            title="No credentials yet"
            description="Start with an App Store Connect API key (to import your apps) and an In-App Purchase key (for transactions)."
            action={
              <>
                <Button onClick={() => setAdding("appstore_connect")}>App Store Connect API key</Button>
                <Button onClick={() => setAdding("appstore_iap")}>In-App Purchase key</Button>
              </>
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {r.data.items.map((c) => (
            <CredentialCard key={c.id} c={c} />
          ))}
        </div>
      )}
      <AddCredentialDialog kind={adding} onKind={setAdding} onClose={() => setAdding(null)} />
    </Section>
  );
}

function CredentialCard({ c }: { c: CredentialView }) {
  const toast = useToast();
  const confirm = useConfirm();
  const vendor = typeof c.config.vendorNumber === "string" ? c.config.vendorNumber : "";
  const [v, setV] = useState(vendor);
  const [saving, setSaving] = useState(false);
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex size-9 items-center justify-center rounded-xl bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          <FileKey2 className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{c.name}</p>
            <Badge tone={c.kind === "revenuecat" ? "red" : c.kind === "appstore_iap" ? "violet" : c.kind === "appstore_reports" ? "amber" : c.kind === "google_play" ? "green" : "blue"}>{KINDS[c.kind]?.label ?? c.kind}</Badge>
          </div>
          <dl className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-500">
            {c.keyId && (
              <div>
                <dt className="inline">{c.kind === "google_play" ? "Private key id " : "Key id "}</dt>
                <dd className="inline font-mono text-zinc-700 dark:text-zinc-300">{c.keyId}</dd>
              </div>
            )}
            {c.issuerId && (
              <div>
                <dt className="inline">{c.kind === "google_play" ? "Service account " : "Issuer "}</dt>
                <dd className="inline font-mono text-zinc-700 dark:text-zinc-300">{c.issuerId}</dd>
              </div>
            )}
            {typeof c.config.projectId === "string" && (
              <div>
                <dt className="inline">Project </dt>
                <dd className="inline font-mono text-zinc-700 dark:text-zinc-300">{c.config.projectId}</dd>
              </div>
            )}
          </dl>
          {(c.kind === "appstore_connect" || c.kind === "appstore_reports") && (
            <form
              className="mt-3 flex flex-wrap items-end gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                setSaving(true);
                try {
                  await api.credentials.update(c.id, { vendorNumber: v });
                  invalidate("credentials");
                  toast.success("Vendor number saved");
                } catch (err) {
                  toast.error(err);
                } finally {
                  setSaving(false);
                }
              }}
            >
              <label className="text-xs text-zinc-500">
                Vendor number (for Sales reports)
                <Input value={v} onChange={(e) => setV(e.target.value)} inputMode="numeric" placeholder="8xxxxxxx" className="mt-1 w-44" />
              </label>
              {v !== vendor && (
                <Button type="submit" size="sm" loading={saving}>
                  Save
                </Button>
              )}
            </form>
          )}
        </div>
        <IconButton
          label="Delete credential"
          variant="danger"
          onClick={async () => {
            if (!(await confirm({ title: `Delete ${c.name}?`, danger: true, confirmLabel: "Delete", message: "Syncs and imports that use this key stop working until you add another." }))) return;
            try {
              await api.credentials.remove(c.id);
              invalidate("credentials");
              toast.success("Credential deleted");
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          <Trash2 className="size-4" />
        </IconButton>
      </div>
    </Card>
  );
}

function AddCredentialDialog({ kind, onKind, onClose }: { kind: CredentialKind | null; onKind: (k: CredentialKind) => void; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [keyId, setKeyId] = useState("");
  const [issuerId, setIssuerId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [vendorNumber, setVendorNumber] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [projectId, setProjectId] = useState("");
  const [serviceAccount, setServiceAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const k = kind ?? "appstore_iap";

  const reset = () => {
    setName("");
    setKeyId("");
    setIssuerId("");
    setPrivateKey("");
    setFileName(null);
    setVendorNumber("");
    setApiKey("");
    setProjectId("");
    setServiceAccount("");
    setError(null);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setPrivateKey(text.trim());
    setFileName(file.name);
    // AuthKey_ABC123DEFG.p8 / SubscriptionKey_ABC123DEFG.p8 → key id.
    const m = /([A-Z0-9]{10})\.p8$/i.exec(file.name);
    if (m && !keyId) setKeyId(m[1].toUpperCase());
  };

  return (
    <Dialog
      open={!!kind}
      onClose={() => {
        reset();
        onClose();
      }}
      size="lg"
      title="Add a credential"
      footer={
        <>
          <Button
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="add-cred" loading={busy}>
            Save credential
          </Button>
        </>
      }
    >
      <form
        id="add-cred"
        className="space-y-4 p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const body: NewCredential =
              k === "revenuecat"
                ? { kind: k, name: name || "RevenueCat", apiKey: apiKey.trim(), projectId: projectId.trim() }
                : k === "google_play"
                  ? { kind: k, name: name.trim() || undefined, serviceAccount: serviceAccount.trim() }
                  : { kind: k, name: name || KINDS[k].label, keyId: keyId.trim(), issuerId: issuerId.trim(), privateKey, ...((k === "appstore_connect" || k === "appstore_reports") && vendorNumber ? { vendorNumber: vendorNumber.trim() } : {}) };
            await api.credentials.create(body);
            invalidate("credentials");
            toast.success("Credential saved");
            reset();
            onClose();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Segmented
          label="Kind"
          value={k}
          onChange={onKind}
          options={[
            { value: "appstore_iap", label: "In-App Purchase" },
            { value: "appstore_connect", label: "App Store Connect" },
            { value: "appstore_reports", label: "Reports" },
            { value: "revenuecat", label: "RevenueCat" },
            { value: "google_play", label: "Google Play" },
          ]}
        />
        <p className="text-sm text-zinc-500">{KINDS[k].help}</p>
        {error && <ErrorState error={error} />}
        <Field label="Name" help="To tell keys apart.">
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder={k === "revenuecat" ? "RevenueCat" : k === "google_play" ? "The service account email" : KINDS[k].label} />}
        </Field>
        {k === "google_play" ? (
          <Field label="Service account key (JSON)" required help="Pick the JSON key file from Google Cloud (IAM → Service accounts → Keys → Add key → JSON), or paste its contents.">
            {(id) => (
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
                      setServiceAccount((await file.text()).trim());
                      setFileName(file.name);
                    }}
                  />
                </label>
                <Textarea id={id} value={serviceAccount} onChange={(e) => setServiceAccount(e.target.value)} placeholder='{ "type": "service_account", "project_id": "example-project", ... }' required rows={5} className="font-mono text-xs" spellCheck={false} />
              </div>
            )}
          </Field>
        ) : k === "revenuecat" ? (
          <>
            <Field label="Secret API key" required>
              {(id) => <Input id={id} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk_..." required autoComplete="off" className="font-mono" />}
            </Field>
            <Field label="Project id" required help="RevenueCat → Project settings → General.">
              {(id) => <Input id={id} value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="proj1a2b3c4d" required className="font-mono" />}
            </Field>
          </>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Key id" required>
                {(id) => <Input id={id} value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="ABC123DEFG" required pattern="[A-Za-z0-9]{10}" className="font-mono" />}
              </Field>
              <Field label="Issuer id" required>
                {(id) => <Input id={id} value={issuerId} onChange={(e) => setIssuerId(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" required className="font-mono" />}
              </Field>
            </div>
            <Field label="Private key (.p8)" required help="Pick the .p8 file you downloaded from App Store Connect, or paste its contents.">
              {(id) => (
                <div className="space-y-2">
                  <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-zinc-300 px-4 py-3 text-sm text-zinc-600 transition hover:border-brand-400 hover:bg-brand-50/40 focus-within:ring-2 focus-within:ring-brand-500 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-brand-950/20">
                    <Upload className="size-4 text-zinc-400" />
                    <span className="flex-1 truncate">{fileName ?? "Choose a .p8 file"}</span>
                    <input type="file" accept=".p8,text/plain" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} />
                  </label>
                  <Textarea id={id} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" required rows={4} className="font-mono text-xs" spellCheck={false} />
                </div>
              )}
            </Field>
            {(k === "appstore_connect" || k === "appstore_reports") && (
              <Field label="Vendor number" help="Optional. Needed for Sales and Trends reports (Payments and Financial Reports, top left).">
                {(id) => <Input id={id} value={vendorNumber} onChange={(e) => setVendorNumber(e.target.value)} inputMode="numeric" className="w-48" />}
              </Field>
            )}
          </>
        )}
      </form>
    </Dialog>
  );
}
