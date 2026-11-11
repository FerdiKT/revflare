import { useState } from "react";
import { Link2, MailPlus, Trash2, UserPlus } from "lucide-react";
import type { Role } from "@shared/types";
import { Button, IconButton } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/Confirm";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select } from "../../components/ui/Form";
import { Badge, Card, CopyField, ErrorState, Skeleton } from "../../components/ui/Misc";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { date, inFuture } from "../../lib/format";
import { initials, useSession } from "../../lib/session";
import { invalidate, useFetch, useNow } from "../../lib/useFetch";
import { Section } from "../SettingsPage";

const ROLES: Array<{ value: Role; label: string; help: string }> = [
  { value: "viewer", label: "Viewer", help: "Sees every number; cannot change anything." },
  { value: "admin", label: "Admin", help: "Manages apps, credentials, imports, goals and members." },
  { value: "owner", label: "Owner", help: "Everything, including deleting the workspace." },
];

export function MembersSettings() {
  const { can, user, workspace } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const r = useFetch("members", api.members.list, { tags: ["members"] });
  const manage = can("members");
  const [inviting, setInviting] = useState(false);
  const roles = ROLES.filter((x) => x.value !== "owner" || workspace?.role === "owner" || user.isAdmin);

  return (
    <Section
      title="Members"
      description="People who can see this workspace. Invite them with a link; it works once and expires after 7 days."
      action={
        manage && (
          <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setInviting(true)}>
            Invite
          </Button>
        )
      }
    >
      {r.error && <ErrorState error={r.error} onRetry={r.refetch} className="mb-4" />}
      <Card className="overflow-hidden">
        {!r.data ? (
          <Skeleton className="m-5 h-16" />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {r.data.items.map((m) => (
              <li key={m.userId} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <span className="flex size-9 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{initials(m.name)}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {m.name} {m.userId === user.id && <Badge className="ml-1">You</Badge>}
                  </p>
                  <p className="truncate text-xs text-zinc-500">
                    {m.email} · joined {date(m.createdAt)}
                  </p>
                </div>
                {manage && m.userId !== user.id ? (
                  <>
                    <Select
                      aria-label={`Role of ${m.name}`}
                      value={m.role}
                      className="w-32"
                      onChange={async (e) => {
                        try {
                          await api.members.setRole(m.userId, e.target.value as Role);
                          invalidate("members");
                          toast.success("Role updated");
                        } catch (err) {
                          toast.error(err);
                        }
                      }}
                    >
                      {ROLES.filter((x) => roles.includes(x) || x.value === m.role).map((x) => (
                        <option key={x.value} value={x.value}>
                          {x.label}
                        </option>
                      ))}
                    </Select>
                    <IconButton
                      label={`Remove ${m.name}`}
                      variant="danger"
                      onClick={async () => {
                        if (!(await confirm({ title: `Remove ${m.name}?`, danger: true, confirmLabel: "Remove", message: "They lose access to this workspace, including from the iOS app." }))) return;
                        try {
                          await api.members.remove(m.userId);
                          invalidate("members");
                        } catch (err) {
                          toast.error(err);
                        }
                      }}
                    >
                      <Trash2 className="size-4" />
                    </IconButton>
                  </>
                ) : (
                  <Badge tone={m.role === "owner" ? "brand" : m.role === "admin" ? "violet" : "zinc"} className="capitalize">
                    {m.role}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {manage && <PendingInvitations />}
      <InviteDialog open={inviting} onClose={() => setInviting(false)} roles={roles} />
    </Section>
  );
}

/** Invitations not yet accepted. Their links are shown once (when created), so they can only be revoked here. */
function PendingInvitations() {
  const toast = useToast();
  const confirm = useConfirm();
  const now = useNow(60_000);
  const r = useFetch("invitations", api.members.invitations, { tags: ["members"] });
  if (r.error) return <ErrorState error={r.error} onRetry={r.refetch} className="mt-4" />;
  if (!r.data?.items.length) return null;
  return (
    <Card className="mt-4 overflow-hidden">
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
                {i.createdBy ? `Invited by ${i.createdBy} · ` : ""}
                {date(i.createdAt)} · expires {inFuture(i.expiresAt, now)}
              </p>
            </div>
            <Badge tone={i.role === "owner" ? "brand" : i.role === "admin" ? "violet" : "zinc"} className="capitalize">
              {i.role}
            </Badge>
            <Button
              size="sm"
              variant="outline"
              aria-label={`Revoke the invitation${i.email ? ` for ${i.email}` : ""}`}
              onClick={async () => {
                if (!(await confirm({ title: "Revoke this invitation?", danger: true, confirmLabel: "Revoke", message: "Its link stops working. You can invite them again later." }))) return;
                try {
                  await api.members.revokeInvitation(i.id);
                  r.setData((prev) => prev && { items: prev.items.filter((x) => x.id !== i.id) });
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

function InviteDialog({ open, onClose, roles }: { open: boolean; onClose: () => void; roles: typeof ROLES }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: number } | null>(null);
  const close = () => {
    setEmail("");
    setRole("viewer");
    setLink(null);
    setError(null);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={link ? "Invitation link" : "Invite a member"}
      description={link ? `Send this link to the person you invite. It expires ${date(link.expiresAt)}.` : undefined}
      footer={
        link ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" type="submit" form="invite" loading={busy} icon={<Link2 className="size-4" />}>
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
          id="invite"
          className="space-y-4 p-5"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              setLink(await api.members.invite({ email: email.trim() || undefined, role }));
              invalidate("members");
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
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">Role</legend>
            <div className="space-y-2">
              {roles.map((x) => (
                <label key={x.value} className="flex cursor-pointer gap-3 rounded-lg p-3 ring-1 ring-zinc-200 has-checked:bg-brand-50/50 has-checked:ring-brand-400 dark:ring-zinc-700 dark:has-checked:bg-brand-950/30">
                  <input type="radio" name="role" value={x.value} checked={role === x.value} onChange={() => setRole(x.value)} className="mt-0.5 accent-brand-600" />
                  <span>
                    <span className="block text-sm font-medium">{x.label}</span>
                    <span className="block text-xs text-zinc-500">{x.help}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </form>
      )}
    </Dialog>
  );
}
