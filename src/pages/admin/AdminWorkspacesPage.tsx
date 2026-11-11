import { useState } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, Building2, Plus, Trash2, UserPlus } from "lucide-react";
import { Button, IconButton } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/Confirm";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Form";
import { Card, EmptyState, ErrorState, PageHeader, Skeleton, Table, td, th } from "../../components/ui/Misc";
import { useToast } from "../../components/ui/Toast";
import { CurrencySelect } from "../../components/CurrencySelect";
import { api } from "../../lib/api";
import { date, fullNumber } from "../../lib/format";
import { useSession } from "../../lib/session";
import { invalidate, useFetch } from "../../lib/useFetch";
import { InviteUserDialog } from "./AdminUsersPage";

/** Admin → Workspaces: every workspace of the instance with its owners, members and apps. */
export function AdminWorkspacesPage() {
  const { workspace, switchWorkspace, refresh } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const r = useFetch("admin-workspaces", api.admin.workspaces, { tags: ["admin"] });
  const [creating, setCreating] = useState(false);
  const [inviteTo, setInviteTo] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Workspaces"
        description="Every workspace on this server. As an instance admin you can open any of them as an owner."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            Create workspace
          </Button>
        }
      />
      {r.error && <ErrorState error={r.error} onRetry={r.refetch} className="mb-4" />}
      <Card className="overflow-hidden">
        {!r.data ? (
          <Skeleton className="m-5 h-24" />
        ) : !r.data.items.length ? (
          <EmptyState icon={<Building2 />} title="No workspaces" description="Create one, or invite a user into a new workspace of their own." />
        ) : (
          <Table>
            <thead className="border-b border-zinc-100 dark:border-zinc-800">
              <tr>
                <th className={th}>Workspace</th>
                <th className={th}>Owners</th>
                <th className={`${th} text-right`}>Members</th>
                <th className={`${th} text-right`}>Apps</th>
                <th className={`${th} text-right`}>API keys</th>
                <th className={th}>Created</th>
                <th className={th}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {r.data.items.map((w) => (
                <tr key={w.id}>
                  <td className={td}>
                    <p className="font-medium">{w.name}</p>
                    <p className="text-xs text-zinc-500">
                      {w.currency} · {w.id}
                    </p>
                  </td>
                  <td className={`${td} max-w-64 whitespace-normal`}>
                    {w.owners.length ? (
                      w.owners.map((o) => (
                        <p key={o.id} className="truncate text-xs" title={o.email}>
                          {o.name} <span className="text-zinc-500">{o.email}</span>
                        </p>
                      ))
                    ) : (
                      <span className="text-xs text-amber-600 dark:text-amber-400">No owner (admins only)</span>
                    )}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{fullNumber(w.members)}</td>
                  <td className={`${td} text-right tabular-nums`}>{fullNumber(w.apps)}</td>
                  <td className={`${td} text-right tabular-nums`}>{fullNumber(w.apiKeys)}</td>
                  <td className={td}>{date(w.createdAt)}</td>
                  <td className={`${td} text-right`}>
                    <div className="flex justify-end gap-1">
                      <IconButton label={`Invite someone to ${w.name}`} onClick={() => setInviteTo(w.id)}>
                        <UserPlus className="size-4" />
                      </IconButton>
                      <IconButton
                        label={`Open ${w.name}`}
                        onClick={async () => {
                          try {
                            await switchWorkspace(w.id);
                            navigate("/");
                          } catch (err) {
                            toast.error(err);
                          }
                        }}
                      >
                        <ArrowRight className="size-4" />
                      </IconButton>
                      <IconButton
                        label={`Delete ${w.name}`}
                        variant="danger"
                        onClick={async () => {
                          if (
                            !(await confirm({
                              title: `Delete ${w.name}?`,
                              message: "Its apps, sales history, credentials, members, API keys and invitations are deleted for good.",
                              confirmLabel: "Delete workspace",
                              danger: true,
                              typeToConfirm: w.name,
                            }))
                          )
                            return;
                          try {
                            await api.admin.deleteWorkspace(w.id);
                            // The open workspace is gone: reload so the app picks another one.
                            if (workspace?.id === w.id) return window.location.assign("/admin/workspaces");
                            invalidate("admin");
                            await refresh();
                            toast.success("Workspace deleted");
                          } catch (err) {
                            toast.error(err);
                          }
                        }}
                      >
                        <Trash2 className="size-4" />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <CreateWorkspaceDialog open={creating} onClose={() => setCreating(false)} />
      {inviteTo && <InviteUserDialog open onClose={() => setInviteTo(null)} workspaceId={inviteTo} />}
    </>
  );
}

function CreateWorkspaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { refresh } = useSession();
  const toast = useToast();
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setName("");
    setOwnerEmail("");
    setError(null);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Create workspace"
      description="A separate set of apps, credentials, members and API keys."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" type="submit" form="admin-create-ws" loading={busy}>
            Create
          </Button>
        </>
      }
    >
      <form
        id="admin-create-ws"
        className="space-y-4 p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.admin.createWorkspace({ name, currency, ownerEmail: ownerEmail.trim() || undefined });
            invalidate("admin");
            await refresh();
            toast.success("Workspace created");
            close();
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
        <Field label="Reporting currency">{(id) => <CurrencySelect id={id} value={currency} onChange={setCurrency} />}</Field>
        <Field label="Owner email" help="Optional: an existing user who becomes its owner (default: you). New people: invite them instead.">
          {(id) => <Input id={id} type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}
