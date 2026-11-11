# Contributing to Revflare

Thanks for helping! Bug reports, fixes, new revenue sources, metrics, iOS app and RevflareKit improvements and docs are
all welcome.

## Development setup

Requirements: Node.js 22.12+, npm. No Cloudflare account is needed for development or tests: Vite runs the Worker
locally with the Durable Object database, R2 and Workflows emulated.

```bash
git clone https://github.com/FerdiKT/revflare.git
cd revflare
npm install
echo 'DEV_SEED=true' >> .dev.vars
npm run dev            # http://localhost:5173, create the first user (instance admin) in the browser
```

With `DEV_SEED=true`, `POST /api/v1/dev/seed` fills the current workspace with a year of synthetic sales. Put other
local variables in the git-ignored `.dev.vars` too (for example `SECRET_KEY`). Personal deploy settings (custom domain,
`PUBLIC_URL`, APNs vars) go in the git-ignored `wrangler.local.jsonc` (see `wrangler.local.example.jsonc`); personal
iOS signing settings in the git-ignored `ios/Local.xcconfig` (see [ios/README.md](ios/README.md)).

> Apple only sends App Store Server Notifications to public HTTPS URLs, so live notifications need a deployed Worker.
> Integration tests sign their own notifications with a test certificate chain (`test/fixtures/apple-test-chain.json`,
> made by `scripts/make-test-chain.sh`).

Project layout: `worker/` (Hono API, Apple notification verification and ingest, ledger, rollups and metrics, imports,
cron, MCP server, the `RevflareDatabase` Durable Object), `src/` (React app), `shared/` (types and `version.ts` used by
both), `cli/` (the `revflare` CLI), `skills/` (Claude Code skill), `ios/` (iOS app, XcodeGen), `sdk/ios/` (RevflareKit,
Swift package), `migrations/` (SQLite schema). [CLAUDE.md](CLAUDE.md) lists the rules the code follows and
[docs/api.md](docs/api.md) the REST API.

## Checks

```bash
npm run typecheck      # tsc -b (app + worker)
(cd cli && npm run typecheck)
npm test               # vitest: unit tests, CLI tests and integration tests in workerd
npx vite build         # production build of the app and Worker
npm run cli:build
bash scripts/test-revflare-update.sh   # the self-hosters' update script (.github/workflows/revflare-update.yml)
(cd sdk/ios && swift test)             # RevflareKit (macOS)
```

CI runs the same commands on every pull request. The iOS app is built locally (`ios/README.md`).

## Working with Apple

- Apple is the source of truth: every sale is keyed by Apple's transaction id. Verify every JWS chain to the pinned
  Apple Root CA G3 (`worker/apple/jws.ts`); never trust unverified payloads.
- Never replace an app's notification URL that points elsewhere (e.g. RevenueCat) without the user's consent; such
  apps are polled through Notification History.
- The live APIs sometimes differ from the docs. Leave a short comment when you work around such behaviour.

## Free plan budget

Revflare must keep running on the Workers Free plan: ~10 ms CPU per Worker request (heavy work runs inside the
database object), 50 subrequests per invocation, and the database's daily limits (5M rows read, 100k written).
Rollups are incremental, reads are cached, background work is metered (`worker/lib/budget.ts`), and
`test/workers/budget.test.ts` guards the cost of a sale and of a cached read. Never scan `transactions` in recurring
work. There is one cron trigger (`*/5`); do not add more (accounts share five).

## Database changes

Add a new `migrations/000N_*.sql` file; never edit an existing one. Migrations are applied automatically when the
database object starts. Durable Object SQLite binds at most 100 parameters per statement. Every query on workspace data
must be scoped by workspace (`wsId(c)`) and guarded by `requirePermission(...)`: ids of other workspaces answer 404.

## Commit messages

Releases and changelogs are generated from commit messages ([release-please](docs/RELEASING.md)), so commits on `main`
(and PR titles: PRs are squash-merged) follow [Conventional Commits](https://www.conventionalcommits.org):

| Type | For | Release |
|---|---|---|
| `feat` | a user-visible feature | minor |
| `fix` | a bug fix | patch |
| `perf` | a performance improvement | patch |
| `docs` | documentation only | none (listed in the changelog) |
| `refactor`, `test`, `build`, `ci`, `chore` | everything else | none (hidden) |

Add `!` (`feat!: ...`) or a `BREAKING CHANGE:` footer with upgrade steps for breaking changes. Changes under `cli/` are
released with the CLI (`feat(cli): ...`). Never bump versions or edit `CHANGELOG.md` by hand.

## Pull request checklist

- [ ] Typecheck, tests, the app build and the CLI build pass.
- [ ] PR title is a Conventional Commit.
- [ ] Breaking REST API change? Bump `API_VERSION` in `shared/version.ts`.
- [ ] Workspace-scoped queries and permission guards for new routes.
- [ ] `docs/api.md`, `shared/types.ts` (mirrored in `ios/Revflare/Core/Models.swift` and `cli/src/types.ts`), the MCP
      tools and the skill updated when API shapes change.
- [ ] No secrets, personal domains, bundle ids or real revenue in the diff (use synthetic fixtures such as
      `com.example.*`).

Revflare is source available under the [PolyForm Noncommercial License](LICENSE) and sold under commercial licenses
([COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)). By contributing you agree that your contributions are licensed under
the PolyForm Noncommercial License and that the copyright holder may also license them under commercial terms;
contributions to `sdk/ios` and `sdk/android` are licensed under the MIT License.
