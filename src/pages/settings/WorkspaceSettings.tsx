import { useState } from "react";
import { CurrencySelect } from "../../components/CurrencySelect";
import { Button } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/Confirm";
import { Field, Input } from "../../components/ui/Form";
import { Card } from "../../components/ui/Misc";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { invalidate } from "../../lib/useFetch";
import { Section } from "../SettingsPage";

export function WorkspaceSettings() {
  const { workspace, can, refresh, me, switchWorkspace } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const [name, setName] = useState(workspace!.name);
  const [currency, setCurrency] = useState(workspace!.currency);
  const [busy, setBusy] = useState(false);
  const manage = can("manage");
  const dirty = name !== workspace!.name || currency !== workspace!.currency;

  return (
    <>
      <Section title="Workspace" description="A workspace holds apps, credentials, members and API keys.">
        <Card className="p-5">
          <form
            className="grid max-w-xl gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api.workspace.update({ name, currency });
                await refresh();
                invalidate("apps", "metrics", "goals");
                toast.success("Workspace saved");
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} disabled={!manage} required />}</Field>
            <Field label="Reporting currency" help="Every amount in the app, the iOS app and the API is converted into this currency at each day's rate.">
              {(id) => (manage ? <CurrencySelect id={id} value={currency} onChange={setCurrency} /> : <Input id={id} value={currency} disabled />)}
            </Field>
            {manage && (
              <div>
                <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
                  Save
                </Button>
              </div>
            )}
          </form>
        </Card>
      </Section>
      {can("delete") && (
        <Section title="Danger zone">
          <Card className="flex flex-wrap items-center justify-between gap-4 p-5 ring-red-200 dark:ring-red-900/60">
            <div>
              <p className="text-sm font-medium">Delete this workspace</p>
              <p className="text-sm text-zinc-500">Deletes its apps, transactions, metrics, credentials, members and API keys. This cannot be undone.</p>
            </div>
            <Button
              variant="danger"
              onClick={async () => {
                const ok = await confirm({
                  title: `Delete ${workspace!.name}?`,
                  danger: true,
                  typeToConfirm: workspace!.name,
                  confirmLabel: "Delete workspace",
                  message: "All of its data is deleted for good. iOS devices and API keys of this workspace stop working.",
                });
                if (!ok) return;
                try {
                  await api.workspace.remove();
                  const next = me.workspaces.find((w) => w.id !== workspace!.id);
                  if (next) {
                    await switchWorkspace(next.id);
                    toast.success("Workspace deleted");
                  } else {
                    // No workspace left: start over without the header.
                    try {
                      localStorage.removeItem("revflare:workspace");
                    } catch {
                      /* storage disabled */
                    }
                    window.location.assign("/");
                  }
                } catch (err) {
                  toast.error(err);
                }
              }}
            >
              Delete workspace
            </Button>
          </Card>
        </Section>
      )}
    </>
  );
}
