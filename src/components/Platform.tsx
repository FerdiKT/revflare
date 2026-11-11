import type { App } from "@shared/types";
import { cn } from "../lib/format";

/** Android (Google Play) app: bundleId is the package name; Apple-only features are hidden. */
export const isAndroid = (app: Pick<App, "platform"> | null | undefined) => app?.platform === "android";

/** App Store glyph: the "A" of three sticks in a blue disc. */
function AppStoreGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-3.5 shrink-0", className)} aria-hidden>
      <circle cx="12" cy="12" r="11" fill="#0D84F5" />
      <path d="M9.6 6.5 15.4 16.5M14.4 6.5 8.6 16.5M6.8 13.6h10.4" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/** Google Play glyph: the four-colour play triangle. */
function PlayGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-3.5 shrink-0", className)} aria-hidden>
      <path d="M4 2.6 13.4 12 4 21.4c-.3-.2-.5-.6-.5-1V3.6c0-.4.2-.8.5-1Z" fill="#00A0FF" />
      <path d="M16.6 15.2 13.4 12l3.2-3.2 3.8 2.2c.8.5.8 1.5 0 2l-3.8 2.2Z" fill="#FFBC00" />
      <path d="M16.6 15.2 13.4 12 4 21.4c.4.3.9.3 1.4 0l11.2-6.2Z" fill="#FF3A44" />
      <path d="M16.6 8.8 5.4 2.6C4.9 2.3 4.4 2.3 4 2.6L13.4 12l3.2-3.2Z" fill="#32A071" />
    </svg>
  );
}

/** Polar glyph (web checkout): a white ring in a dark disc. */
function PolarGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-3.5 shrink-0", className)} aria-hidden>
      <circle cx="12" cy="12" r="11" fill="#18181B" />
      <ellipse cx="12" cy="12" rx="3.6" ry="7" stroke="#fff" strokeWidth="1.8" fill="none" />
      <circle cx="12" cy="12" r="7" stroke="#fff" strokeWidth="1.8" fill="none" />
    </svg>
  );
}

/** Web (Polar) app: Apple-only features are hidden. */
export const isWeb = (app: Pick<App, "platform"> | null | undefined) => app?.platform === "web";

/** Small store glyph of an app platform ("ios" | "android" | "web") or a transaction store ("app_store" | "play_store" | "polar"). */
export function StoreGlyph({ platform, store, className }: { platform?: string | null; store?: string | null; className?: string }) {
  const play = platform === "android" || store === "play_store";
  const polar = platform === "web" || store === "polar";
  return (
    <span title={polar ? "Polar (web)" : play ? "Google Play" : "App Store"} className="inline-flex">
      {polar ? <PolarGlyph className={className} /> : play ? <PlayGlyph className={className} /> : <AppStoreGlyph className={className} />}
    </span>
  );
}

/** "App Store" / "Google Play" pill. */
export function PlatformBadge({ platform, className }: { platform: string | null | undefined; className?: string }) {
  const play = platform === "android";
  if (platform === "web") {
    return (
      <span className={cn("inline-flex items-center gap-1 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-zinc-800 ring-1 ring-zinc-300 ring-inset dark:bg-zinc-800 dark:text-zinc-200 dark:ring-zinc-700", className)}>
        <PolarGlyph className="size-3" />
        Polar (web)
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset",
        play ? "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900" : "bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-950/50 dark:text-sky-300 dark:ring-sky-900",
        className,
      )}
    >
      {play ? <PlayGlyph className="size-3" /> : <AppStoreGlyph className="size-3" />}
      {play ? "Google Play" : "App Store"}
    </span>
  );
}

/** An App Store-only page opened for an Android app. */
export function AppleOnlyNotice({ what, className }: { what: string; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center rounded-2xl bg-white px-6 py-12 text-center ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800", className)}>
      <PlatformBadge platform="android" />
      <p className="mt-3 text-sm font-medium">{what} are App Store only</p>
      <p className="mt-1 max-w-md text-sm text-zinc-500">This is an Android (Google Play) app: there is nothing to set up here.</p>
    </div>
  );
}
