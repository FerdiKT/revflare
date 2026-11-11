// Update check: once a day (cron, slot 2 at :55) the instance asks GitHub for the newest release of FerdiKT/revflare
// (tags `v*`; drafts and prereleases are ignored) and stores the answer in settings. One outgoing request a day.
// UPDATE_CHECK="false" turns it off, UPDATE_REPO points it elsewhere. A 404 (repository missing or still private) is
// stored as status `not_found`: never an exception.

import type { UpdateStatus } from "../../shared/types";
import { API_VERSION, COMMIT, UPSTREAM_REPO, VERSION, compareVersions, parseVersion, releaseUrl } from "../../shared/version";
import type { Db } from "./db";
import { getSetting, setSetting } from "./settings";
import { errorMessage, now, parseJson } from "./util";

export const UPDATE_SETTING = "update_check";
const DAY = 24 * 60 * 60 * 1000;
/** After a failed check (rate limit, GitHub down...), try again sooner than a day. */
const RETRY_AFTER_ERROR = 6 * 60 * 60 * 1000;
/** Manual checks (POST /admin/updates/check): at most one request per minute. */
export const MANUAL_CHECK_INTERVAL = 60 * 1000;

export interface StoredUpdate {
  status: "ok" | "not_found" | "error";
  latestVersion: string | null;
  url: string | null;
  publishedAt: number | null;
  checkedAt: number;
  message: string | null;
}

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
}

export const updateCheckEnabled = (env: Env) => env.UPDATE_CHECK?.trim().toLowerCase() !== "false";
export const updateRepo = (env: Env) =>
  (env.UPDATE_REPO?.trim() || UPSTREAM_REPO)
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

export const versionInfo = () => ({ version: VERSION, commit: COMMIT, apiVersion: API_VERSION });

export async function readStoredUpdate(db: Db): Promise<StoredUpdate | null> {
  return parseJson<StoredUpdate | null>(await getSetting(db, UPDATE_SETTING), null);
}

/** Highest semver `v<x.y.z>` release that is neither a draft nor a prerelease. */
export function pickLatestRelease(releases: GitHubRelease[]): GitHubRelease | null {
  let best: GitHubRelease | null = null;
  for (const r of releases) {
    if (r.draft || r.prerelease || !/^v?\d/.test(r.tag_name)) continue;
    const v = parseVersion(r.tag_name);
    if (!v || v[3]) continue;
    if (!best || compareVersions(r.tag_name, best.tag_name) > 0) best = r;
  }
  return best;
}

/** Asks GitHub now (one request) and stores the result. Never throws. */
export async function checkForUpdatesNow(env: Env, db: Db, fetchImpl: typeof fetch = fetch): Promise<StoredUpdate> {
  const repo = updateRepo(env);
  const previous = await readStoredUpdate(db);
  const keep = { latestVersion: previous?.latestVersion ?? null, url: previous?.url ?? null, publishedAt: previous?.publishedAt ?? null };
  let result: StoredUpdate;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": `revflare/${VERSION} (update check)`,
      },
    });
    if (res.status === 404) {
      await res.body?.cancel();
      result = { status: "not_found", latestVersion: null, url: null, publishedAt: null, checkedAt: now(), message: `GitHub has no public repository ${repo} (missing or private)` };
    } else if (!res.ok) {
      await res.body?.cancel();
      result = { status: "error", ...keep, checkedAt: now(), message: `GitHub answered ${res.status}` };
    } else {
      const body = (await res.json()) as unknown;
      const latest = Array.isArray(body) ? pickLatestRelease(body as GitHubRelease[]) : null;
      result = {
        status: "ok",
        latestVersion: latest ? latest.tag_name.replace(/^v/, "") : null,
        url: latest?.html_url ?? null,
        publishedAt: latest?.published_at ? Date.parse(latest.published_at) : null,
        checkedAt: now(),
        message: latest ? null : "No releases yet",
      };
    }
  } catch (err) {
    result = { status: "error", ...keep, checkedAt: now(), message: `Update check failed: ${errorMessage(err)}` };
  }
  await setSetting(db, UPDATE_SETTING, JSON.stringify(result));
  return result;
}

/** Cron: checks at most once a day (sooner after an error). Returns whether it asked GitHub. */
export async function updateCheckCron(env: Env, db: Db, fetchImpl: typeof fetch = fetch): Promise<StoredUpdate | null> {
  if (!updateCheckEnabled(env)) return null;
  const stored = await readStoredUpdate(db);
  if (stored && now() - stored.checkedAt < (stored.status === "error" ? RETRY_AFTER_ERROR : DAY)) return null;
  return checkForUpdatesNow(env, db, fetchImpl);
}

export function updateStatus(env: Env, stored: StoredUpdate | null): UpdateStatus {
  const repo = updateRepo(env);
  const enabled = updateCheckEnabled(env);
  const latest = stored?.latestVersion ?? null;
  return {
    current: VERSION,
    commit: COMMIT,
    latest,
    updateAvailable: !!latest && compareVersions(latest, VERSION) > 0,
    url: stored?.url ?? (latest ? releaseUrl(latest, repo) : null),
    publishedAt: stored?.publishedAt ?? null,
    checkedAt: stored?.checkedAt ?? null,
    status: !enabled ? "disabled" : (stored?.status ?? "never"),
    message: !enabled ? 'Update checks are turned off (UPDATE_CHECK="false")' : (stored?.message ?? null),
    enabled,
    repo,
  };
}
