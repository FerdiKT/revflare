import { useCallback, useEffect, useRef, useState } from "react";
import { BellRing, CheckCircle2, Clock, RefreshCw, Smartphone, XCircle } from "lucide-react";
import type { WebLoginStart } from "@shared/types";
import { QrCode } from "../components/QrCode";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Form";
import { ErrorState, Spinner } from "../components/ui/Misc";
import { api, errorMessage } from "../lib/api";

type Phase = "starting" | "waiting" | "signing_in" | "denied" | "expired" | "error";

const POLL_MS = 2000;

/** Remaining time of a request as "2:41". */
function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * "Sign in with the iPhone app" (docs/app-login-spec.md): a QR code the signed-in app scans (or the camera, which opens
 * the app), or with push a request to the account's devices with a number to pick there. Polls every 2 s while the tab
 * is visible; the poll that finds the request approved gets the session cookie.
 */
export function AppLoginPanel({ push, appStoreUrl, email: initialEmail, onDone }: { push: boolean; appStoreUrl?: string; email: string; onDone: () => void }) {
  const [mode, setMode] = useState<"qr" | "push">("qr");
  const [request, setRequest] = useState<WebLoginStart | null>(null);
  const [phase, setPhase] = useState<Phase>("starting");
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState(initialEmail);
  const [sending, setSending] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const current = useRef<WebLoginStart | null>(null);
  /** Bumped by every cancel: a start that answers after it was superseded (or the panel closed) is dropped. */
  const seq = useRef(0);

  /** Ends the open request (the app then shows it as expired). */
  const cancel = useCallback(() => {
    seq.current++;
    const r = current.current;
    current.current = null;
    if (r) api.auth.cancelAppLogin(r.id, r.secret).catch(() => {});
  }, []);

  const begin = useCallback(
    async (b: { kind: "qr" } | { kind: "push"; email: string }) => {
      cancel();
      const mine = seq.current;
      setError(null);
      setPhase("starting");
      setRequest(null);
      try {
        const r = await api.auth.startAppLogin(b);
        if (mine !== seq.current) {
          api.auth.cancelAppLogin(r.id, r.secret).catch(() => {});
          return;
        }
        current.current = r;
        setRequest(r);
        setNowMs(Date.now());
        setPhase("waiting");
      } catch (err) {
        if (mine !== seq.current) return;
        setError(errorMessage(err));
        setPhase("error");
      }
    },
    [cancel],
  );

  useEffect(() => {
    void begin({ kind: "qr" });
    return cancel;
  }, [begin, cancel]);

  // Countdown, and expiry without waiting for the next poll.
  useEffect(() => {
    if (phase !== "waiting" || !request) return;
    const t = setInterval(() => {
      setNowMs(Date.now());
      if (Date.now() >= request.expiresAt) setPhase("expired");
    }, 1000);
    return () => clearInterval(t);
  }, [phase, request]);

  // Polling: every 2 s while the tab is visible, at once when it becomes visible again.
  useEffect(() => {
    if (phase !== "waiting" || !request) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      try {
        const r = await api.auth.pollAppLogin(request.id, request.secret);
        if (stopped) return;
        if (r.status === "signed_in") {
          current.current = null;
          setPhase("signing_in");
          if (r.workspaceId) {
            try {
              localStorage.setItem("revflare:workspace", r.workspaceId);
            } catch {
              /* storage disabled */
            }
          }
          onDone();
          return;
        }
        if (r.status === "denied" || r.status === "consumed") {
          current.current = null;
          setPhase("denied");
          return;
        }
        if (r.status === "expired") {
          current.current = null;
          setPhase("expired");
          return;
        }
      } catch (err) {
        if (stopped) return;
        setError(errorMessage(err));
        setPhase("error");
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      void tick();
    };
    timer = setTimeout(tick, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [phase, request, onDone]);

  const sendPush = async (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    try {
      await begin({ kind: "push", email: email.trim() });
    } finally {
      setSending(false);
    }
  };

  const newCode = () => void (mode === "qr" ? begin({ kind: "qr" }) : (cancel(), setRequest(null), setPhase("waiting")));
  const left = request ? request.expiresAt - nowMs : 0;
  const muted = "text-sm text-zinc-500 dark:text-zinc-400";
  const link = "text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100";

  const outcome =
    phase === "signing_in" ? (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <CheckCircle2 className="size-10 text-emerald-500" />
        <p className="font-medium">Approved. Signing you in…</p>
      </div>
    ) : phase === "denied" ? (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <XCircle className="size-10 text-red-500" />
        <p className="font-medium">The request was denied in the app.</p>
        <Button variant="primary" icon={<RefreshCw className="size-4" />} onClick={newCode}>
          {mode === "qr" ? "Show a new code" : "Try again"}
        </Button>
      </div>
    ) : phase === "expired" ? (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <Clock className="size-10 text-zinc-400" />
        <p className="font-medium">{mode === "qr" ? "This code has expired." : "This request has expired."}</p>
        <Button variant="primary" icon={<RefreshCw className="size-4" />} onClick={newCode}>
          {mode === "qr" ? "Show a new code" : "Send a new request"}
        </Button>
      </div>
    ) : null;

  return (
    <div className="space-y-5">
      {error && <ErrorState error={error} />}
      {outcome ??
        (mode === "qr" ? (
          <div className="flex flex-col items-center gap-4">
            <div className="flex size-[244px] items-center justify-center rounded-2xl bg-white p-3 shadow-sm ring-1 ring-zinc-200 dark:ring-zinc-700">
              {request?.qr ? <QrCode value={request.qr} size={220} label="Sign-in QR code for the Revflare iOS app" /> : phase === "error" ? <XCircle className="size-8 text-zinc-300" /> : <Spinner className="size-6" />}
            </div>
            <ol className={`list-decimal space-y-1 pl-5 ${muted}`}>
              <li>Open Revflare on your iPhone: Settings → Sign in on a computer (or scan with the Camera app).</li>
              <li>Check where the request comes from and approve with Face ID.</li>
            </ol>
            {request && phase === "waiting" && (
              <p className={`flex items-center gap-1.5 ${muted}`}>
                <Clock className="size-3.5" /> Expires in {countdown(left)}
                <span aria-hidden>·</span>
                <button type="button" className="font-medium text-brand-600 hover:underline dark:text-brand-400" onClick={() => void begin({ kind: "qr" })}>
                  Show a new code
                </button>
              </p>
            )}
            {phase === "error" && (
              <Button icon={<RefreshCw className="size-4" />} onClick={() => void begin({ kind: "qr" })}>
                Show a new code
              </Button>
            )}
          </div>
        ) : request?.number !== undefined && phase === "waiting" ? (
          <div className="flex flex-col items-center gap-4 py-2 text-center">
            <BellRing className="size-8 text-brand-500" />
            <p className="font-medium">
              Tap <span className="tabular-nums">{request.number}</span> in the app
            </p>
            <div className="text-6xl font-semibold tracking-tight tabular-nums" aria-live="polite">
              {request.number}
            </div>
            <p className={muted}>
              If {email.trim()} has the Revflare app with notifications on, a sign-in request is on its way. Open it and pick this number.
            </p>
            <p className={`flex items-center gap-1.5 ${muted}`}>
              <Clock className="size-3.5" /> Expires in {countdown(left)}
            </p>
          </div>
        ) : (
          <form onSubmit={sendPush} className="space-y-4">
            <p className={muted}>We send a sign-in request to the iPhones signed in to your account. The page then shows a number to pick in the app.</p>
            <Field label="Email" required>
              {(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required autoFocus />}
            </Field>
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={sending} icon={<Smartphone className="size-4" />}>
              Send to my iPhone
            </Button>
          </form>
        ))}
      <div className="flex flex-col items-center gap-2">
        {push && phase !== "signing_in" && (
          <button
            type="button"
            className={link}
            onClick={() => {
              cancel();
              setError(null);
              setRequest(null);
              if (mode === "qr") {
                setMode("push");
                setPhase("waiting");
              } else {
                setMode("qr");
                void begin({ kind: "qr" });
              }
            }}
          >
            {mode === "qr" ? "Can't scan? Send a request to my iPhone" : "Show a QR code instead"}
          </button>
        )}
        {appStoreUrl && (
          <a href={appStoreUrl} target="_blank" rel="noreferrer" className={link}>
            Get the app
          </a>
        )}
      </div>
    </div>
  );
}
