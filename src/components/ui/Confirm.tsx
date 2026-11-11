import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Input } from "./Form";

interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** The user must type this text to enable the confirm button (destructive or risky actions). */
  typeToConfirm?: string;
}

type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;
const Ctx = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const [typed, setTyped] = useState("");
  const resolver = useRef<(v: boolean) => void>(undefined);
  const confirm = useCallback<ConfirmFn>(
    (o) =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setTyped("");
        setOpts(o);
      }),
    [],
  );
  const close = (v: boolean) => {
    resolver.current?.(v);
    resolver.current = undefined;
    setOpts(null);
  };
  const blocked = !!opts?.typeToConfirm && typed.trim() !== opts.typeToConfirm;
  return (
    <Ctx.Provider value={confirm}>
      {children}
      <Dialog
        open={!!opts}
        onClose={() => close(false)}
        size={opts?.typeToConfirm || (opts?.message && typeof opts.message !== "string") ? "md" : "sm"}
        footer={
          <>
            <Button onClick={() => close(false)} data-autofocus={opts?.typeToConfirm ? undefined : opts?.danger ? true : undefined}>
              Cancel
            </Button>
            <Button variant={opts?.danger ? "danger" : "primary"} disabled={blocked} onClick={() => close(true)} data-autofocus={opts?.danger ? undefined : true}>
              {opts?.confirmLabel ?? "Confirm"}
            </Button>
          </>
        }
      >
        {opts && (
          <form
            className="flex gap-4 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!blocked) close(true);
            }}
          >
            {opts.danger && (
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-950">
                <AlertTriangle className="size-5 text-red-600 dark:text-red-400" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">{opts.title}</h2>
              {opts.message && <div className="mt-1.5 space-y-2 text-sm text-zinc-600 dark:text-zinc-400">{opts.message}</div>}
              {opts.typeToConfirm && (
                <label className="mt-4 block text-sm text-zinc-700 dark:text-zinc-300">
                  Type <strong className="font-mono font-semibold">{opts.typeToConfirm}</strong> to confirm
                  <Input className="mt-1.5" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" data-autofocus />
                </label>
              )}
            </div>
          </form>
        )}
      </Dialog>
    </Ctx.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useConfirm outside ConfirmProvider");
  return ctx;
}
