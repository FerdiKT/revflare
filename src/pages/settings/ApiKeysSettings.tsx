import { useState } from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/Confirm";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Form";
import { Card, CopyField, EmptyState, ErrorState, Skeleton } from "../../components/ui/Misc";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { ago, date } from "../../lib/format";
import { invalidate, useFetch } from "../../lib/useFetch";
import { Section } from "../SettingsPage";

export function ApiKeysSettings() {
  const r = useFetch("apiKeys", api.apiKeys.list, { tags: ["apiKeys"] });
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    setName("");
    setToken(null);
  };

  return (
    <Section
      title="API keys"
      description={
        <>
          For the <code className="font-mono text-xs">revflare</code> CLI, MCP clients and Adsflare. A key works in this workspace only, with your role.
        </>
      }
      action={
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
          Create API key
        </Button>
      }
    >
      {r.error && <ErrorState error={r.error} onRetry={r.refetch} className="mb-4" />}
      <Card className="overflow-hidden">
        {!r.data ? (
          <Skeleton className="m-5 h-16" />
        ) : r.data.items.length === 0 ? (
          <EmptyState icon={<KeyRound />} title="No API keys" description="Create one to use Revflare from the terminal, an AI agent (MCP) or Adsflare." />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {r.data.items.map((k) => (
              <li key={k.id} className="flex items-center gap-3 px-5 py-3.5">
                <KeyRound className="size-4 text-zinc-400" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{k.name}</p>
                  <p className="text-xs text-zinc-500">
                    <span className="font-mono">{k.prefix}…</span> · created {date(k.createdAt)} · {k.lastUsedAt ? `last used ${ago(k.lastUsedAt)}` : "never used"}
                  </p>
                </div>
                <IconButton
                  label="Revoke key"
                  variant="danger"
                  onClick={async () => {
                    if (!(await confirm({ title: `Revoke ${k.name}?`, danger: true, confirmLabel: "Revoke", message: "Tools using this key lose access immediately." }))) return;
                    try {
                      await api.apiKeys.remove(k.id);
                      invalidate("apiKeys");
                      toast.success("Key revoked");
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
      <Dialog
        open={open}
        onClose={close}
        title={token ? "Your new API key" : "Create API key"}
        description={token ? "Copy it now: it is shown only once." : undefined}
        footer={
          token ? (
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          ) : (
            <>
              <Button onClick={close}>Cancel</Button>
              <Button variant="primary" type="submit" form="new-key" loading={busy}>
                Create
              </Button>
            </>
          )
        }
      >
        {token ? (
          <div className="space-y-4 p-5">
            <CopyField value={token} />
            <div className="rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-950 dark:text-zinc-400 dark:ring-zinc-800">
              <p className="mb-1 font-medium text-zinc-800 dark:text-zinc-200">Use it with the CLI</p>
              <code className="font-mono break-all">revflare login --url {window.location.origin}</code>
              <p className="mt-1">It asks for the key. MCP clients use {window.location.origin}/mcp with the key as a Bearer token.</p>
            </div>
          </div>
        ) : (
          <form
            id="new-key"
            className="p-5"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                const k = await api.apiKeys.create(name || "API key");
                setToken(k.token);
                invalidate("apiKeys");
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Name" help="Where it is used, e.g. “MacBook CLI” or “Adsflare”.">
              {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} data-autofocus />}
            </Field>
          </form>
        )}
      </Dialog>
    </Section>
  );
}
