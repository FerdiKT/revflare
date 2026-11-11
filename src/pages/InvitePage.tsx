import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Form";
import { ErrorState, Segmented } from "../components/ui/Misc";
import { api } from "../lib/api";
import { useFetch } from "../lib/useFetch";
import { AuthShell } from "./AuthPage";

/** /invite/:token — join a workspace with a new account or an existing one. */
export function InvitePage({ onDone }: { onDone: () => void }) {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const info = useFetch(token ? `invitation:${token}` : null, () => api.auth.invitation(token));
  const inv = info.data;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.auth.acceptInvitation({ token, email, password, ...(mode === "new" ? { name } : {}) });
      try {
        localStorage.setItem("revflare:workspace", r.workspaceId);
      } catch {
        /* storage disabled */
      }
      onDone();
      navigate("/", { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title={inv?.newWorkspace ? "Join Revflare" : "Join the workspace"}
      subtitle={
        inv?.newWorkspace
          ? `You have been invited to Revflare with a workspace of your own${inv.newWorkspaceName ? ` ("${inv.newWorkspaceName}")` : ""}${inv.isAdmin ? ", as an instance admin" : ""}.`
          : inv?.workspaceName
            ? `You have been invited to ${inv.workspaceName} as ${inv.role}${inv.isAdmin ? " and as an instance admin" : ""}.`
            : "You have been invited to a Revflare workspace."
      }
    >
      <Segmented
        label="Account"
        className="mb-6 flex w-full [&>button]:flex-1 [&>button]:justify-center"
        value={mode}
        onChange={setMode}
        options={[
          { value: "new", label: "Create an account" },
          { value: "existing", label: "I have an account" },
        ]}
      />
      <form onSubmit={submit} className="space-y-4">
        {error ? <ErrorState error={error} /> : info.error ? <ErrorState error={info.error} /> : null}
        {mode === "new" && (
          <Field label="Your name" required>
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required autoFocus />}
          </Field>
        )}
        <Field label="Email" required help="If the invitation names an email, use that one.">
          {(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />}
        </Field>
        <Field label="Password" required help={mode === "new" ? "At least 8 characters." : undefined}>
          {(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "new" ? "new-password" : "current-password"} required minLength={mode === "new" ? 8 : undefined} />}
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          {mode === "new" ? "Create account and join" : "Sign in and join"}
        </Button>
      </form>
    </AuthShell>
  );
}
