import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/format";

/** Button + floating panel: closes on outside click and Escape, returns focus to the trigger. */
export function Popover({
  trigger,
  children,
  align = "left",
  className,
  panelClassName,
  label,
}: {
  trigger: (props: { open: boolean; toggle: () => void; ref: React.RefObject<HTMLButtonElement | null>; "aria-expanded": boolean; "aria-haspopup": "dialog" }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  className?: string;
  panelClassName?: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={root} className={cn("relative", className)}>
      {trigger({ open, toggle: () => setOpen((o) => !o), ref: btn, "aria-expanded": open, "aria-haspopup": "dialog" })}
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className={cn(
            "absolute top-full z-40 mt-1.5 animate-pop rounded-xl bg-white p-1.5 shadow-xl ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-700",
            align === "right" ? "right-0" : "left-0",
            panelClassName,
          )}
        >
          {children(() => {
            setOpen(false);
            btn.current?.focus();
          })}
        </div>
      )}
    </div>
  );
}
