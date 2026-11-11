# revflare (CLI)

Command line client for Revflare, the self-hosted in-app purchase and subscription revenue tracker on Cloudflare:
MRR, revenue, proceeds, churn, trials, refunds, sales feed, cohorts and imports, from your terminal or an AI agent.

- Node.js 20+, no runtime dependencies.
- Human-friendly tables with money in the workspace currency (or `--currency`), `--json` on every command.
- Apps can be given by id, bundle id, App Store id or name everywhere (`--app`, repeatable or comma separated).
- Exit codes: `0` ok, `1` error (API errors print the server's message), `2` usage error, `3` Cloudflare Free plan
  daily limit (see below).

## Cloudflare Free plan limits

On the Workers Free plan Revflare's database has daily limits (5M rows read, 100k written; reset 00:00 UTC). Every
command turns the server's answers into one line and exit code `3`:

- `503 { code: "quota" }`: the daily limit is reached; every request fails until 00:00 UTC (the time left is printed).
- `429 { code: "budget" }`: today's share for background work (imports) is used up; reads keep working.

`revflare usage` (instance admins, signed in with `login --email`) shows the database size, today's background rows
read / written against their budgets and the Free plan limits.

## Install

From the repo: `npm run cli:build && npm install -g ./cli`, then `revflare --help`.

## Log in

Create a workspace API key (`rf_...`, `POST /api/v1/api-keys` or the web app). A key belongs to one workspace.

```bash
revflare login --url https://revflare.example.com          # asks for the key without echoing it
echo "$KEY" | revflare login --url https://revflare.example.com
revflare whoami
```

Instance admins can sign in as themselves instead (`revflare login --email you@example.com`, prompts for the password
or reads it from stdin): the CLI saves a device token (`rfd_...`) that sees the workspaces you see and is needed for
`usage` and the `admin` commands (the server refuses API keys there). `revflare logout` ends that sign-in on the server.
Keep both with profiles: `revflare login --profile admin --email ...`.

Credentials are saved to `~/.config/revflare/config.json` (mode 0600; `$XDG_CONFIG_HOME` is honored, `REVFLARE_CONFIG`
overrides the path). Several instances: `revflare login --profile work ...`, then `--profile work` or
`REVFLARE_PROFILE=work`. `REVFLARE_URL` + `REVFLARE_API_KEY` override the saved profile. `revflare logout [--all]`.

## Commands

| Command | |
|---|---|
| `whoami`, `version` | User, workspace, currency, permissions; CLI and server versions |
| `overview` | Today, yesterday, KPIs with 28-day trends, MRR movement, at risk, forecast, goals, top apps, alerts |
| `apps [--all]`, `app <id\|bundle-id> [--sdk-key]` | Apps with MRR / revenue / actives; one app's setup and products (`--sdk-key`: only its RevflareKit key) |
| `chart <metric> [--range] [--from --to] [--interval] [--group-by] [--app]` | A metric over time (see metrics below) |
| `breakdown --by app\|country\|product [--metric]` | A metric split by a dimension |
| `mrr-movement` | New, expansion, reactivation, contraction, churn, net per period |
| `revenue-daily` | Per app and day (the Adsflare ROAS feed) |
| `transactions [--kind] [--app] [--country] [--refunded] [--limit] [--follow]` | Sales feed; `--follow` polls and prints new sales |
| `customer <id>` | A customer's spend, subscriptions and transactions |
| `at-risk`, `forecast [--days]`, `cohorts [--months] [--ltv]` | Revenue at risk, renewal forecast, cohorts |
| `attribution [--range] [--app] [--by campaign\|adgroup\|keyword] [--json [--raw]]` | Apple Ads revenue from RevflareKit attribution: revenue, proceeds, transactions, trials, installs, payers, revenue per install per Apple Ads id, plus coverage |
| `ltv [--range] [--app] [--by source\|campaign\|adgroup\|keyword\|country] [--cohort day\|week\|month] [--proceeds] [--summary]` | LTV by acquisition source: revenue (or proceeds) per install at D0/D7/D30/D90/D180 and to date per install cohort and group, immature horizons dotted, coverage; `--summary` pools each group over installs old enough per horizon (payback / ROAS) |
| `sdk-key <app> [--rotate --yes]` | The app's public RevflareKit SDK key; `--rotate --yes` replaces it (the old key stops working at once) |
| `acquisition [--range] [--app] [--by source\|referrer\|campaign\|day\|app]` | App Store acquisition (Apple App Analytics): impressions → page views → downloads, conversion, redownloads, purchases, proceeds per source type, referrer, campaign token, day or app |
| `acquisition campaigns`, `acquisition status` | Campaign tokens seen (first / last seen, downloads, proceeds); per app report request state, data range, errors |
| `acquisition requests [--retry]`, `acquisition import` | Ask Apple for the App Analytics reports (Admin key; data arrives 1–2 days later); import all reports now (job) |
| `alerts [--all]`, `alerts resolve <id...>` | Alerts |
| `goals`, `goals add --metric --target [--app]`, `goals remove <id...>` | Monthly goals |
| `jobs`, `jobs show <id>`, `jobs cancel <id>` | Import jobs |
| `invite --role viewer\|admin\|owner [--email]` | Create an invitation link (valid 7 days, works once) |
| `invitations`, `invitations revoke <id...>` | Pending invitations; revoke them |
| `usage` | Database size, today's background budget, Free plan limits (instance admins) |
| `admin overview` | Instance overview: users, workspaces, apps, purchases, jobs, cron, database usage, version and available update (instance admins) |
| `admin users` | Every user: admin, status, last sign-in, workspaces and roles (instance admins) |
| `admin workspaces` | Every workspace: owners, members, apps (instance admins) |
| `import apple [--app]`, `import fx [--from]`, `import sales-reports [--days]`, `import revenuecat --credential <id>` | Server-side imports (jobs) |
| `import revenuecat-charts [--project] [--metric] [--dry-run] [--force]` | RevenueCat Charts history (see below) |
| `mcp [--claude-code]` | MCP server config for Claude / agents (`<url>/mcp` with the bearer key) |
| `skill install [--dir]` | Install the bundled Claude Code skill into `~/.claude/skills/revflare/` |

Ranges: `7d`, `28d`, `30d`, `90d`, `12m`, `mtd`, `ytd`, `all` (or `--from YYYY-MM-DD --to YYYY-MM-DD`). Chart metrics:
`revenue, proceeds, mrr, mrr_proceeds, arr, active_subscriptions, active_trials, new_subscriptions, renewals,
one_time_purchases, trials_started, trial_conversions, trial_conversion_rate, refunds, refunds_amount, refund_rate,
churn_rate, churned_subscriptions, new_customers, arppu`.

```bash
revflare chart mrr --range all --interval month
revflare chart revenue --range 90d --group-by country
revflare breakdown --by app --metric mrr
revflare transactions --kind new,conversion --follow
revflare attribution --range 90d --by keyword
revflare ltv --summary --by campaign --range 180d
```

Apple Ads attribution needs RevflareKit in the app: `Revflare.configure(sdkKey: "<revflare sdk-key <app>>", server: <your Revflare URL>)` at launch
and, for StoreKit 2 purchases, `.appAccountToken(Revflare.installId)` (apps on RevenueCat only need `configure`).
`attribution` shows campaign, ad group and keyword names when Revflare knows them (a connected Adsflare fills them, or
`revflare attribution names import names.csv` with `kind,id,name` lines), else the ids; `--include-test` counts Apple's
test attribution and sandbox builds. `transactions --source apple_ads|organic|unknown` filters the feed by acquisition.

App Store acquisition needs the App Analytics reports requested once per app (`revflare acquisition requests`, with an
App Store Connect key that has the Admin role; reading them works with Sales). Apple produces them 1–2 days later.
Referrer and campaign rows come from Apple's Detailed reports (rows under 5 users left out, a little noise), so they
sum to less than the totals. Campaign links: `https://apps.apple.com/app/id<APPID>?pt=<provider token>&ct=<campaign>`.

## RevenueCat Charts history

`revflare import revenuecat-charts` brings the RevenueCat dashboard's daily history into Revflare for the days before
Revflare's own transaction history of each app:

1. Reads RevenueCat through your local, OAuth-authenticated [`revenuecat` CLI](https://www.revenuecat.com/docs)
   (`revenuecat auth login`; `--revenuecat-bin` or `REVENUECAT_BIN` for another path). No secret key is needed.
2. Maps each RevenueCat project to Revflare apps by the bundle ids of its App Store apps (projects sharing a bundle id
   are summed).
3. Reads each chart per App Store app (`app_id` filter), daily, in USD, from the project's creation day:
   revenue and proceeds (`revenue`, `revenue_type`), MRR (`mrr`), active subscriptions (`actives`), active trials
   (`trials`), new subscriptions (`actives_new`: trial conversions + intro offers + direct + resubscriptions), trials
   started (`trials_new`), refunds (`refunds`: refunded transactions), churned subscriptions (`actives_movement`).
   `new_customers` is opt-in (`--metric new_customers`): RevenueCat counts every new app user, Revflare only customers
   with a purchase or trial.
4. Stores them with `POST /api/v1/imports/external-metrics` (≤ 5000 points per request), skipping zero days and days
   Revflare already covers (`--all-days`, `--keep-zeros` to send them). Metrics Revflare already holds up to the last
   day to send (`GET /api/v1/imports/external-metrics`) are skipped; `--force` sends them anyway (the server only
   rewrites changed values). `--replace` deletes an app's imported RevenueCat history first.
5. When the daily import budget is used up (`429 budget`) or the daily quota is reached, it stops, prints how far it
   got and exits with `3`; re-run the same command after 00:00 UTC to continue.

```bash
revflare import revenuecat-charts --dry-run
revflare import revenuecat-charts
revflare import revenuecat-charts --project proj1a2b3c4d --metric mrr,revenue
```

## Development

`npm run cli:build` (embeds `skills/revflare/SKILL.md` into `cli/src/skill-content.ts`, then compiles to `cli/dist`),
`npx vitest run --project cli`.
