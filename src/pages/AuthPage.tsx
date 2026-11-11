import { useState, type ReactNode } from "react";
import { BellRing, LineChart, ShieldCheck, Smartphone } from "lucide-react";
import { CurrencySelect } from "../components/CurrencySelect";
import { Logo, Wordmark } from "../components/Logo";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Form";
import { ErrorState } from "../components/ui/Misc";
import { api } from "../lib/api";
import { AppLoginPanel } from "./AppLoginPanel";

export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <div className="relative hidden overflow-hidden bg-zinc-950 lg:block">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(249,87,22,0.55),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(251,191,36,0.35),transparent_55%)]" />
        <svg className="absolute inset-x-0 bottom-0 h-1/2 w-full opacity-60" viewBox="0 0 600 300" preserveAspectRatio="none" aria-hidden>
          <defs>
            <linearGradient id="auth-area" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#fb7a3c" stopOpacity="0.45" />
              <stop offset="1" stopColor="#fb7a3c" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d="M0 250 L60 230 L120 238 L180 200 L240 210 L300 160 L360 170 L420 120 L480 128 L540 80 L600 60 L600 300 L0 300Z" fill="url(#auth-area)" />
          <path d="M0 250 L60 230 L120 238 L180 200 L240 210 L300 160 L360 170 L420 120 L480 128 L540 80 L600 60" fill="none" stroke="#fdaa74" strokeWidth="2.5" />
        </svg>
        <div className="relative flex h-full flex-col justify-between p-12 text-white">
          <span className="flex items-center gap-2.5">
            <Logo className="size-9" />
            <span className="text-lg font-semibold tracking-tight">Revflare</span>
          </span>
          <div className="max-w-md">
            <h2 className="text-3xl leading-tight font-semibold tracking-tight">Every sale, straight from Apple. On your own Cloudflare.</h2>
            <ul className="mt-8 space-y-4 text-sm text-zinc-300">
              <li className="flex gap-3">
                <LineChart className="size-5 shrink-0 text-brand-300" /> MRR, revenue, churn, cohorts and forecasts across all your apps.
              </li>
              <li className="flex gap-3">
                <BellRing className="size-5 shrink-0 text-brand-300" /> Live App Store Server Notifications, with alerts on your iPhone.
              </li>
              <li className="flex gap-3">
                <ShieldCheck className="size-5 shrink-0 text-brand-300" /> Self-hosted: your revenue data never leaves your account.
              </li>
            </ul>
          </div>
          <p className="text-xs text-zinc-500">Self-hosted in-app purchase analytics</p>
        </div>
      </div>
      <div className="flex items-center justify-center px-5 py-12 sm:px-10">
        <div className="w-full max-w-sm">
          <Wordmark className="mb-10 lg:hidden" />
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
          <div className="mt-8">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function AuthPage({
  mode,
  setupToken,
  magicLink,
  appLogin,
  onDone,
}: {
  mode: "login" | "setup";
  setupToken: boolean;
  magicLink?: boolean;
  /** "Sign in with the iPhone app" (auth status appLogin / pushLogin / appStoreUrl). */
  appLogin?: { push: boolean; appStoreUrl?: string } | null;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [token, setToken] = useState("");
  const [withLink, setWithLink] = useState(false);
  const [withApp, setWithApp] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const link = mode === "login" && !!magicLink && withLink;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (link) {
        await api.auth.magicLink(email);
        setSentTo(email.trim());
        return;
      }
      if (mode === "setup") await api.auth.setup({ name, email, password, workspaceName: workspaceName || undefined, currency, setupToken: setupToken ? token : undefined });
      else await api.auth.login(email, password);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (sentTo)
    return (
      <AuthShell
        title="Check your email"
        subtitle={
          <>
            If an account exists for <b>{sentTo}</b>, a sign-in link is on its way. It works once, for 15 minutes.
          </>
        }
      >
        <Button size="lg" className="w-full" onClick={() => setSentTo(null)}>
          Back
        </Button>
      </AuthShell>
    );

  if (mode === "login" && appLogin && withApp)
    return (
      <AuthShell title="Sign in with the iPhone app" subtitle="Approve the sign-in in the Revflare app on your iPhone.">
        <AppLoginPanel push={appLogin.push} appStoreUrl={appLogin.appStoreUrl} email={email} onDone={onDone} />
        <button
          type="button"
          className="mt-6 w-full text-center text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          onClick={() => {
            setWithApp(false);
            setError(null);
          }}
        >
          Sign in with a password instead
        </button>
      </AuthShell>
    );

  return (
    <AuthShell
      title={mode === "setup" ? "Set up Revflare" : "Sign in"}
      subtitle={mode === "setup" ? "Create the first account. You become the admin of this instance." : link ? "We will email you a link to sign in." : "Welcome back. Sign in to see your revenue."}
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorState error={error} />}
        {mode === "setup" && (
          <Field label="Your name" required>
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required autoFocus />}
          </Field>
        )}
        <Field label="Email" required>
          {(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required autoFocus={mode === "login"} />}
        </Field>
        {!link && (
          <Field label="Password" required help={mode === "setup" ? "At least 8 characters." : undefined}>
            {(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "setup" ? "new-password" : "current-password"} required minLength={mode === "setup" ? 8 : undefined} />}
          </Field>
        )}
        {mode === "setup" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Workspace">
                {(id) => <Input id={id} value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} placeholder="My apps" />}
              </Field>
              <Field label="Currency">{(id) => <CurrencySelect id={id} value={currency} onChange={setCurrency} />}</Field>
            </div>
            {setupToken && (
              <Field label="Setup token" required help="The SETUP_TOKEN secret of this deployment.">
                {(id) => <Input id={id} type="password" value={token} onChange={(e) => setToken(e.target.value)} required />}
              </Field>
            )}
          </>
        )}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          {mode === "setup" ? "Create account" : link ? "Email me a sign-in link" : "Sign in"}
        </Button>
        {mode === "login" && magicLink && (
          <button
            type="button"
            className="w-full text-center text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            onClick={() => {
              setWithLink(!link);
              setError(null);
            }}
          >
            {link ? "Sign in with a password instead" : "Email me a sign-in link instead"}
          </button>
        )}
        {mode === "login" && appLogin && (
          <>
            <div className="flex items-center gap-3 pt-1 text-xs text-zinc-400">
              <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
              or
              <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
            </div>
            <Button
              size="lg"
              className="w-full"
              icon={<Smartphone className="size-4" />}
              onClick={() => {
                setWithApp(true);
                setError(null);
              }}
            >
              Sign in with the iPhone app
            </Button>
          </>
        )}
      </form>
    </AuthShell>
  );
}

/** /auth/link, opened from a sign-in email: the token is in the URL fragment (never sent to servers or logs) and is used on click. */
export function MagicLinkPage({ onDone }: { onDone: () => void }) {
  const [token] = useState(() => window.location.hash.slice(1));
  const [error, setError] = useState<string | null>(token ? null : "This sign-in link is incomplete. Open it again from the email, or request a new one.");
  const [busy, setBusy] = useState(false);
  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.auth.verifyMagicLink(token);
      window.history.replaceState(null, "", "/");
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title="Sign in to Revflare" subtitle="Continue with the link from your email.">
      <div className="space-y-4">
        {error && <ErrorState error={error} />}
        {token && (
          <Button variant="primary" size="lg" className="w-full" loading={busy} onClick={signIn}>
            Sign in
          </Button>
        )}
        <a href="/" className="block text-center text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
          Back to sign in
        </a>
      </div>
    </AuthShell>
  );
}
