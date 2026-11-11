import { useState } from "react";
import { KeyRound, Link2, MailPlus, ShieldCheck, ShieldOff, Trash2, UserCheck, UserPlus, UserX } from "lucide-react";
import type { AdminUser, Role } from "@shared/types";
import { Button, IconButton } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/Confirm";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Field, Input, Select } from "../../components/ui/Form";
import { Badge, Card, CopyField, ErrorState, PageHeader, Skeleton } from "../../components/ui/Misc";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { ago, date, dateTime, inFuture } from "../../lib/format";
import { initials, useSession } from "../../lib/session";
import { invalidate, useFetch, useNow } from "../../lib/useFetch";

const roleTone = (r: Role) => (r === "owner" ? "brand" : r === "admin" ? "violet" : "zinc");

/** Admin → Users: every account of the instance, instance invitations. */
export function AdminUsersPage() {
  const { user: me, refresh } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const now = useNow(60_000);
  const r = useFetch("admin-users", api.admin.users, { tags: ["admin"] });
  const [inviting, setInviting] = useState(false);
  const [password, setPassword] = useState<{ name: string; password: string } | null>(null);

  const update = async (u: AdminUser, b: Parameters<typeof api.admin.updateUser>[1], done: string) => {
    try {
      const res = await api.admin.updateUser(u.id, b);
      invalidate("admin");
      if (res.password) setPassword({ name: u.name, password: res.password });
      else toast.success(done);
      if (u.id === me.id) await refresh();
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <>
      <PageHeader
        title="Users"
        description="Everyone with an account on this Revflare server. Instance admins manage users and act as owners in every workspace."
        actions={
          <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setInviting(true)}>
            Invite user
          </Button>
        }
      />
      {r.error && <ErrorState error={r.error} onRetry={r.refetch} className="mb-4" />}
      <Card className="overflow-hidden">
        {!r.data ? (
          <Skeleton className="m-5 h-24" />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {r.data.items.map((u) => {
              const self = u.id === me.id;
              const disabled = u.status === "disabled";
              return (
                <li key={u.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                  <span className="flex size-9 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{initials(u.name)}</span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      <span className={disabled ? "text-zinc-400 line-through" : undefined}>{u.name}</span>
                      {self && <Badge>You</Badge>}
                      {u.isAdmin && <Badge tone="violet" icon={<ShieldCheck />}>Admin</Badge>}
                      {disabled && <Badge tone="red">Disabled</Badge>}
                    </p>
                    <p className="truncate text-xs text-zinc-500">
                      {u.email} · joined {date(u.createdAt)} ·{" "}
                      <span title={u.lastLoginAt ? dateTime(u.lastLoginAt) : undefined}>{u.lastLoginAt ? `signed in ${ago(u.lastLoginAt, now)}` : "never signed in"}</span>
                    </p>
                    {u.workspaces.length > 0 && (
                      <p className="mt-1 flex flex-wrap gap-1">
                        {u.workspaces.map((w) => (
                          <Badge key={w.id} tone={roleTone(w.role)} title={`${w.role} of ${w.name}`}>
                            {w.name} · {w.role}
                          </Badge>
                        ))}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <IconButton
                      label={u.isAdmin ? `Remove admin rights of ${u.name}` : `Make ${u.name} an instance admin`}
                      onClick={async () => {
                        if (
                          !(await confirm({
                            title: u.isAdmin ? `Remove admin rights of ${u.name}?` : `Make ${u.name} an instance admin?`,
                            message: u.isAdmin
                              ? "They keep their workspace memberships but lose the Admin area and access to other workspaces."
                              : "Instance admins manage users and workspaces and act as owners in every workspace.",
                            confirmLabel: u.isAdmin ? "Remove admin" : "Make admin",
                            danger: u.isAdmin,
                          }))
                        )
                          return;
                        await update(u, { isAdmin: !u.isAdmin }, u.isAdmin ? "Admin rights removed" : "Now an instance admin");
                      }}
                    >
                      {u.isAdmin ? <ShieldOff className="size-4" /> : <ShieldCheck className="size-4" />}
                    </IconButton>
                    <IconButton
                      label={`Reset the password of ${u.name}`}
                      onClick={async () => {
                        if (
                          !(await confirm({
                            title: `Reset the password of ${u.name}?`,
                            message: "A new one-time password is generated and shown once. They are signed out of the web and the iOS app; API keys keep working.",
                            confirmLabel: "Reset password",
                          }))
                        )
                          return;
                        await update(u, { resetPassword: true }, "Password reset");
                      }}
                    >
                      <KeyRound className="size-4" />
                    </IconButton>
                    {!self && (
                      <IconButton
                        label={disabled ? `Enable ${u.name}` : `Disable ${u.name}`}
                        onClick={async () => {
                          if (
                            !disabled &&
                            !(await confirm({
                              title: `Disable ${u.name}?`,
                              message: "They are signed out everywhere and cannot sign in; their API keys stop working until you enable them again.",
                              confirmLabel: "Disable",
                              danger: true,
                            }))
                          )
                            return;
                          await update(u, { status: disabled ? "active" : "disabled" }, disabled ? "User enabled" : "User disabled");
                        }}
                      >
                        {disabled ? <UserCheck className="size-4" /> : <UserX className="size-4" />}
                      </IconButton>
                    )}
                    {!self && (
                      <IconButton
                        label={`Delete ${u.name}`}
                        variant="danger"
                        onClick={async () => {
                          if (
                            !(await confirm({
                              title: `Delete ${u.name}?`,
                              message: "Their account, memberships, sessions and API keys are deleted. Workspace data stays.",
                              confirmLabel: "Delete user",
                              danger: true,
                              typeToConfirm: u.email,
                            }))
                          )
                            return;
                          try {
                            await api.admin.deleteUser(u.id);
                            invalidate("admin");
                            toast.success("User deleted");
                          } catch (err) {
                            toast.error(err);
                          }
                        }}
                      >
                        <Trash2 className="size-4" />
                      </IconButton>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <PendingInvitations />
      <InviteUserDialog open={inviting} onClose={() => setInviting(false)} />
      <Dialog
        open={!!password}
        onClose={() => setPassword(null)}
        title="New password"
        description={password ? `Send this one-time password to ${password.name}; it is not shown again. They can change it in Settings → Account.` : undefined}
        footer={
          <Button variant="primary" onClick={() => setPassword(null)}>
            Done
          </Button>
        }
      >
        <div className="p-5">{password && <CopyField value={password.password} />}</div>
      </Dialog>
    </>
  );
}

/** Pending invitations of the whole instance (workspace and new-workspace invitations). */
function PendingInvitations() {
  const toast = useToast();
  const confirm = useConfirm();
  const now = useNow(60_000);
  const r = useFetch("admin-invitations", api.admin.invitations, { tags: ["admin"] });
  if (r.error) return <ErrorState error={r.error} onRetry={r.refetch} className="mt-4" />;
  if (!r.data?.items.length) return null;
  return (
    <Card className="mt-6 overflow-hidden">
      <h3 className="px-5 pt-4 pb-1 text-sm font-semibold">Pending invitations</h3>
      <p className="px-5 text-xs text-zinc-500 dark:text-zinc-400">Links are shown only when they are created. Lost one? Revoke it and invite again.</p>
      <ul className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-800">
        {r.data.items.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
            <span className="flex size-9 items-center justify-center rounded-full border border-dashed border-zinc-300 text-zinc-400 dark:border-zinc-700">
              <MailPlus className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{i.email ?? <span className="text-zinc-500">Anyone with the link</span>}</p>
              <p className="truncate text-xs text-zinc-500" title={`Expires ${date(i.expiresAt)}`}>
                {i.workspaceId ? `${i.workspaceName ?? i.workspaceId} as ${i.role}` : `New workspace${i.newWorkspaceName ? ` "${i.newWorkspaceName}"` : ""}`}
                {i.createdBy ? ` · invited by ${i.createdBy}` : ""} · expires {inFuture(i.expiresAt, now)}
              </p>
            </div>
            {i.isAdmin && <Badge tone="violet">Instance admin</Badge>}
            <Button
              size="sm"
              variant="outline"
              aria-label={`Revoke the invitation${i.email ? ` for ${i.email}` : ""}`}
              onClick={async () => {
                if (!(await confirm({ title: "Revoke this invitation?", danger: true, confirmLabel: "Revoke", message: "Its link stops working." }))) return;
                try {
                  await api.admin.revokeInvitation(i.id);
                  invalidate("admin", "members");
                  toast.success("Invitation revoked");
                } catch (err) {
                  toast.error(err);
                }
              }}
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const NEW_WORKSPACE = "__new__";

export function InviteUserDialog({ open, onClose, workspaceId }: { open: boolean; onClose: () => void; workspaceId?: string }) {
  const workspaces = useFetch(open ? "admin-workspaces" : null, api.admin.workspaces, { tags: ["admin"] });
  const [email, setEmail] = useState("");
  const [target, setTarget] = useState(workspaceId ?? NEW_WORKSPACE);
  const [role, setRole] = useState<Role>("viewer");
  const [wsName, setWsName] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: number } | null>(null);
  const close = () => {
    setEmail("");
    setTarget(workspaceId ?? NEW_WORKSPACE);
    setRole("viewer");
    setWsName("");
    setIsAdmin(false);
    setLink(null);
    setError(null);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={link ? "Invitation link" : "Invite a user"}
      description={link ? `Send this link to the person you invite. It works once and expires ${date(link.expiresAt)}.` : "They create their account from the link."}
      footer={
        link ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" type="submit" form="admin-invite" loading={busy} icon={<Link2 className="size-4" />}>
              Create link
            </Button>
          </>
        )
      }
    >
      {link ? (
        <div className="p-5">
          <CopyField value={link.url} />
        </div>
      ) : (
        <form
          id="admin-invite"
          className="space-y-4 p-5"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const newWs = target === NEW_WORKSPACE;
              setLink(
                await api.admin.invite({
                  email: email.trim() || undefined,
                  ...(newWs ? { newWorkspaceName: wsName.trim() || undefined } : { workspaceId: target, role }),
                  isAdmin,
                }),
              );
              invalidate("admin", "members");
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {error && <ErrorState error={error} />}
          <Field label="Email" help="Optional: only this address can accept the invitation.">
            {(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-autofocus />}
          </Field>
          <Field label="Workspace">
            {(id) => (
              <Select id={id} value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value={NEW_WORKSPACE}>A new workspace of their own (owner)</option>
                {workspaces.data?.items.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {target === NEW_WORKSPACE ? (
            <Field label="Workspace name" help={'Optional; default "<their name>\'s apps". They can rename it.'}>
              {(id) => <Input id={id} value={wsName} onChange={(e) => setWsName(e.target.value)} maxLength={100} />}
            </Field>
          ) : (
            <Field label="Role">
              {(id) => (
                <Select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  <option value="viewer">Viewer: sees every number</option>
                  <option value="admin">Admin: manages apps, credentials, imports and members</option>
                  <option value="owner">Owner: everything, including deleting the workspace</option>
                </Select>
              )}
            </Field>
          )}
          <label className="flex cursor-pointer items-start gap-3 rounded-lg p-3 ring-1 ring-zinc-200 dark:ring-zinc-700">
            <Checkbox checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} className="mt-0.5" />
            <span>
              <span className="block text-sm font-medium">Instance admin</span>
              <span className="block text-xs text-zinc-500">Manages users and workspaces of this server and acts as owner everywhere.</span>
            </span>
          </label>
        </form>
      )}
    </Dialog>
  );
}
