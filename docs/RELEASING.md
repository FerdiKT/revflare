# Releasing Revflare

For the maintainer. Two things are released from this repository, separately:

| What | Version in | Tag | Changelog | Published to |
|---|---|---|---|---|
| Server + web app (+ iOS app, RevflareKit) | `package.json` | `v<x.y.z>` | `CHANGELOG.md` | GitHub release (self-hosters redeploy) |
| CLI | `cli/package.json` | `cli-v<x.y.z>` | `cli/CHANGELOG.md` | GitHub release + npm (`revflare`) |

Both use [semver](https://semver.org). Before 1.0, `feat` bumps the minor version, `fix` the patch, and breaking changes
(`!`) the minor version (`bump-minor-pre-major`). The server reports its version at `GET /api/v1/version` (from
`package.json`) together with the integer REST `API_VERSION` (`shared/version.ts`): bump that only on breaking API
changes. `VERSION` and `COMMIT` are injected at build time by Vite `define` (`build-info.ts`).

The iOS app (`ios/project.yml`, `MARKETING_VERSION`) and RevflareKit (`Revflare.version`) keep their own versions and
are released by hand (TestFlight: `ios/scripts/release.sh`).

RevflareKit for Android (`sdk/android`, `version` in `sdk/android/revflarekit/build.gradle.kts`, equal to
`Revflare.VERSION`) is mirrored to `FerdiKT/RevflareKit-Android` by `revflarekit-android-publish.yml`
(`scripts/publish-revflarekit-android.sh`, secret `REVFLAREKIT_ANDROID_DEPLOY_KEY`) on every push touching
`sdk/android`; a new version tag there runs the mirror's `publish.yml`, which publishes
`io.github.ferdikt:revflarekit` to GitHub Packages.

## How releases work (release-please)

[`release.yml`](../.github/workflows/release.yml) runs [release-please](https://github.com/googleapis/release-please) on
every push to `main` (config: [`release-please-config.json`](../release-please-config.json), current versions:
[`.release-please-manifest.json`](../.release-please-manifest.json)). It only runs in `FerdiKT/revflare` (not in forks)
and only while the repository is public: it is skipped while private.

1. Merge PRs with [Conventional Commit](../CONTRIBUTING.md#commit-messages) titles (squash merge).
2. release-please keeps **one release PR per component** open ("release revflare x.y.z" and "release cli x.y.z"). Each
   bumps its `package.json` and changelog. Commits that only touch `cli/` go to the CLI (`exclude-paths`).
3. Merge the release PR: release-please tags it and creates the GitHub release; for the CLI the `publish-cli` job builds
   `cli/` and publishes it to npm with provenance.

Breaking change in the server? Use `feat!:` or a `BREAKING CHANGE:` footer and describe the upgrade steps (they become
the release notes). Call out `wrangler.jsonc` changes (new bindings, Durable Object migrations, Workflows): self-hosters
with a `wrangler.local.jsonc` must copy them by hand.

Optional: a `RELEASE_PLEASE_TOKEN` secret (fine-grained PAT or GitHub App token with contents + pull requests write) so
CI runs on release PRs; PRs opened with the default `GITHUB_TOKEN` trigger no workflows.

## How self-hosters learn about and get releases

- **Update check** (`worker/lib/updates.ts`): the cron asks GitHub for the releases of `FerdiKT/revflare` at most once a
  day (6 hours after a failure) and stores the highest non-draft, non-prerelease `v<x.y.z>` release in `settings`
  (`update_check`); `cli-v*` releases are ignored, so a CLI release marked "latest" does not hide the server's.
  Admin → Overview shows it to instance admins (`GET /api/v1/admin/updates`). While the repository is private GitHub
  answers 404: the check stores that and tries again later. Instances opt out with `UPDATE_CHECK = "false"` and follow
  a fork with `UPDATE_REPO`.
- **Update workflow** (`.github/workflows/revflare-update.yml` + `scripts/revflare-update.sh`): in copies of the
  repository (Deploy to Cloudflare button), weekly or by hand, it compares the copy's `package.json` version with the
  newest upstream `v*` tag and opens a PR (`revflare-update/<tag>`) that copies the release over the code, except
  `wrangler.jsonc`, `wrangler.local*.jsonc`, `.dev.vars*` and `.github/workflows/`, deletes files removed upstream and
  shows upstream `wrangler.jsonc` / workflow changes in the PR description. It does nothing in `FerdiKT/revflare`, and
  opens an issue instead when Actions may not create PRs. CI runs `scripts/test-revflare-update.sh` against fake
  repositories.

So a release must: be tagged `v<x.y.z>` (release-please does it) with `package.json` at that version, and put any
`wrangler.jsonc` change in the release notes.

## One-time setup (when the repository goes public)

1. **Actions may open PRs**: Settings → Actions → General → Workflow permissions → *Allow GitHub Actions to create and
   approve pull requests*.
2. **npm Trusted Publishing** for the `revflare` package (no `NPM_TOKEN`): npmjs.com → package → Settings → Trusted
   publisher → GitHub Actions: user `FerdiKT`, repository `revflare`, workflow `release.yml`. Provenance requires a
   public repository, and the package name must be free or yours.
3. **Private vulnerability reporting**: Settings → Code security → enable it (SECURITY.md points there).
4. **Deploy to Cloudflare** button in the README works once the repository is public.

## Before making the repository public

- [ ] `git log --all -p | grep` for real bundle ids, app names, App Store Connect key / issuer ids, vendor numbers,
      team ids, domains, emails, keys and revenue numbers: history must only contain synthetic data.
- [ ] `wrangler.local.jsonc`, `.dev.vars`, `ios/Local.xcconfig`, `PROGRESS.local.md` and `ios/screenshots/` are
      git-ignored and not in history.
- [ ] README screenshots show demo data only (no real domain in URLs or QR codes).
- [ ] CI is green on `main`.
