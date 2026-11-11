// Apps are referred to by id, bundle id (Android: package name), App Store id or exact name everywhere. An iOS app and
// an Android app often share the bundle id / package name: "ios:<bundle id>" / "android:<package>" picks one.

import { UsageError } from "./errors.js";
import type { App } from "./types.js";

function describe(apps: App[]): string {
  return apps.map((a) => `  ${a.id}  ${a.bundleId ?? "-"}  ${a.name}${a.platform === "android" ? " (Android)" : a.platform === "web" ? " (web)" : ""}${a.archived ? " (archived)" : ""}`).join("\n");
}

/** One app from an id (`app_...`), bundle id, App Store id or name (case-insensitive). */
export function resolveApp(selector: string, apps: App[]): App {
  const s = selector.trim();
  if (!s) throw new UsageError("Empty app selector");
  const prefixed = /^(ios|android|web):(.+)$/i.exec(s);
  if (prefixed) {
    const platform = prefixed[1].toLowerCase();
    return resolveApp(prefixed[2], apps.filter((a) => (a.platform || "ios") === platform));
  }
  const lower = s.toLowerCase();
  const tiers: Array<(a: App) => boolean> = [
    (a) => a.id === s,
    (a) => (a.bundleId ?? "").toLowerCase() === lower,
    (a) => a.appleAppId === s,
    (a) => a.name.trim().toLowerCase() === lower,
  ];
  for (const match of tiers) {
    const found = apps.filter(match);
    // Prefer active apps when an archived duplicate shares the bundle id or name.
    const active = found.filter((a) => !a.archived);
    const pick = active.length ? active : found;
    if (pick.length === 1) return pick[0];
    if (pick.length > 1) {
      const platforms = new Set(pick.map((a) => a.platform || "ios"));
      const hint = platforms.size === pick.length ? ` or ios:${s} / android:${s}` : "";
      throw new UsageError(`"${s}" matches ${pick.length} apps:\n${describe(pick)}\nUse the app id${hint}.`);
    }
  }
  if (!apps.length) throw new UsageError(`No app matches "${s}": the workspace has no apps yet.`);
  throw new UsageError(`No app matches "${s}". Apps:\n${describe(apps)}`);
}

/** Several selectors (repeatable and/or comma separated), deduplicated, in order. */
export function resolveApps(selectors: string[], apps: App[]): App[] {
  const out: App[] = [];
  for (const sel of selectors.flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean)) {
    const a = resolveApp(sel, apps);
    if (!out.includes(a)) out.push(a);
  }
  return out;
}
