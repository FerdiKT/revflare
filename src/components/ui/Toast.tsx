import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { errorMessage } from "../../lib/api";
import { cn } from "../../lib/format";

type Kind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: Kind;
  title: string;
  description?: string;
}

interface ToastApi {
  success: (title: string, description?: string) => void;
  error: (titleOrError: unknown, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);
let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (kind: Kind, title: string, description?: string) => {
      const id = nextId++;
      setToasts((t) => [...t.slice(-4), { id, kind, title, description }]);
      setTimeout(() => dismiss(id), kind === "error" ? 7000 : 4000);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({
      success: (t, d) => push("success", t, d),
      info: (t, d) => push("info", t, d),
      error: (e, d) => push("error", typeof e === "string" ? e : errorMessage(e), d),
    }),
    [push],
  );
  return (
    <Ctx.Provider value={api}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed right-4 top-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex animate-pop items-start gap-3 rounded-xl bg-white p-3.5 shadow-lg ring-1 ring-zinc-200 dark:bg-zinc-800 dark:ring-zinc-700"
          >
            {t.kind === "success" ? (
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-500" />
            ) : t.kind === "error" ? (
              <XCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
            ) : (
              <Info className="mt-0.5 size-5 shrink-0 text-sky-500" />
            )}
            <div className="min-w-0 flex-1">
              <p className={cn("whitespace-pre-line break-words text-sm font-medium text-zinc-900 dark:text-zinc-50")}>{t.title}</p>
              {t.description && <p className="mt-0.5 break-words text-sm text-zinc-500 dark:text-zinc-400">{t.description}</p>}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="rounded p-0.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
              aria-label="Dismiss"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast outside ToastProvider");
  return ctx;
}
