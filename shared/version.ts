// Version of this Revflare build, shared by the Worker and the web app.

/** Server/app version from the root package.json, injected at build time. */
export const VERSION: string = typeof __REVFLARE_VERSION__ === "string" ? __REVFLARE_VERSION__ : "0.0.0-dev";
/** Short git commit SHA of the build, or "dev". */
export const COMMIT: string = typeof __REVFLARE_COMMIT__ === "string" ? __REVFLARE_COMMIT__ : "dev";
/** Version of the REST API contract (`/api/v1`). Bump on breaking changes only. */
export const API_VERSION = 1;

/** GitHub repository the daily update check asks for releases (UPDATE_REPO overrides it). */
export const UPSTREAM_REPO = "FerdiKT/revflare";
export const REPO_URL = `https://github.com/${UPSTREAM_REPO}`;
export const releaseUrl = (version: string, repo = UPSTREAM_REPO) => `https://github.com/${repo}/releases/tag/v${version.replace(/^v/, "")}`;

/** [major, minor, patch, prerelease] of "v1.2.3" / "1.2.3-beta.1", or null. */
export function parseVersion(v: string): [number, number, number, string] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""] : null;
}

/** Semver order of two versions (<0, 0, >0); unparsable versions sort first. Prereleases sort before the release. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] as number) - (pb[i] as number);
  if (pa[3] === pb[3]) return 0;
  if (!pa[3]) return 1;
  if (!pb[3]) return -1;
  return pa[3] < pb[3] ? -1 : 1;
}
