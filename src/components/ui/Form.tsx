import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/format";

export const inputClass =
  "block w-full rounded-lg border-0 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm ring-1 ring-inset placeholder:text-zinc-400 transition focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-500 disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-500 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:disabled:bg-zinc-900/50";

const ringOk = "ring-zinc-300 dark:ring-zinc-700";
const ringBad = "ring-red-500 dark:ring-red-500";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input(
  { className, invalid, ...rest },
  ref,
) {
  return <input ref={ref} className={cn(inputClass, "h-9", invalid ? ringBad : ringOk, className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ className, invalid, ...rest }, ref) {
    return <textarea ref={ref} className={cn(inputClass, "min-h-20 resize-y", invalid ? ringBad : ringOk, className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <div className={cn("relative", className)}>
      <select ref={ref} className={cn(inputClass, ringOk, "h-9 appearance-none pr-8")} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
    </div>
  );
});

export function Label({ htmlFor, children, required }: { htmlFor?: string; children: ReactNode; required?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-zinc-800 dark:text-zinc-200">
      {children}
      {required && <span className="ml-0.5 text-red-500">*</span>}
    </label>
  );
}

/** Label + control + help/error. The child receives the generated id via render prop. */
export function Field({
  label,
  help,
  error,
  required,
  children,
  className,
}: {
  label?: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={className}>
      {label && (
        <Label htmlFor={id} required={required}>
          {label}
        </Label>
      )}
      {children(id)}
      {error ? (
        <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : help ? (
        <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">{help}</p>
      ) : null}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-brand-600 dark:bg-brand-500" : "bg-zinc-300 dark:bg-zinc-700",
      )}
    >
      <span className={cn("inline-block size-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-4.5" : "translate-x-0.5")} />
    </button>
  );
}

export function Checkbox({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={cn(
        "size-4 rounded border-zinc-300 text-brand-600 accent-brand-600 focus:ring-brand-500 dark:border-zinc-600",
        className,
      )}
      {...rest}
    />
  );
}
