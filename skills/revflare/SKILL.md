---
name: revflare
description: Answer revenue and subscription questions about the user's apps with the `revflare` CLI for a self-hosted Revflare instance (in-app purchase / subscription tracking that replaces RevenueCat's dashboard). Use when the user asks how much they made (today, this month, per app, per country), about MRR, ARR, revenue vs proceeds, active subscriptions, trials and trial conversion, churn, refunds, new customers, top apps / countries / products, MRR movement, revenue at risk, renewal forecast, cohorts / LTV, recent sales, a customer's history, goals, alerts (including funnel drop, release regression and events-stopped alerts), Apple Ads attributed revenue (RevflareKit: revenue per campaign / ad group / keyword, revenue per install, the app's SDK key), LTV by acquisition source (D0/D7/D30/D90/D180 revenue per install per install cohort and source / campaign / ad group / keyword / country, Apple Ads vs organic, payback), the Meta Ads (Facebook) integration (purchases sent to Meta's Conversions API: status, settings, event names, test event, delivery log, why an event was skipped), Apple refund requests (answers to Apple's CONSUMPTION_REQUEST notifications with consumption information: status, refund preference policy, consent attestation, log, a customer withdrawing consent, prorated refunds), promotional and win-back offers (promotional offer signing for RevflareKit: allowlist, strict mode, signature log, import from App Store Connect; lapsed subscribers; promotional / win-back redemptions and revenue per offer), paywall offerings and placements (which App Store products each paywall shows, the current offering, changing them remotely for RevflareKit), server-driven entitlements and non-renewing pass durations (a new product unlocking pro without an app update), remote config (like Firebase Remote Config: parameters and their values per country, language, app version, acquisition source (Apple Ads campaign vs organic), build or percent rollout, what a device gets, importing a Firebase Remote Config template, changing a value remotely), A/B experiments on remote config parameters (paywall / onboarding tests: variants, which variant wins, exposed installs, trial and paid conversion per variant, revenue per install, probability to be best, lift vs control, starting / stopping / rolling out the winner), in-app events and funnels (RevflareKit events: top events, onboarding / paywall funnels, where users drop off, conversion to trial or paid, test devices and sandbox / Xcode test data), App Store acquisition (Apple App Analytics: where downloads come from by source type / referrer / campaign, App Store campaign links, impressions, product page views, conversion rate, downloads and App Store proceeds per source), or wants to import App Store / RevenueCat history (RevenueCat Charts import) into Revflare, set up or check Google Play (Android) apps (service account key, Pub/Sub RTDN push URL, push authentication, refunds poll; Android revenue sits next to iOS revenue in every number), set up or check Polar web checkout (web apps: webhook URL and secret, access token, product map, order import; Polar revenue sits next to store revenue), invite teammates (invitation links), check the database usage / Cloudflare Free plan daily limit, or (instance admins) review the server: users, workspaces, failed imports, cron, available updates.
---

# Revflare CLI

`revflare` reads the user's Revflare instance with a workspace API key (`rf_...`). Add `--json` to any command for
machine-readable output (prefer it when you compute or compare numbers). Money is in the workspace currency unless
`--currency USD` (etc.) is given; rates are fractions in JSON (0.034 = 3.4%). Exit codes: 0 ok, 1 error, 2 usage error,
3 daily database limit reached (see "Daily limits" below).
`revflare <command> --help` lists every option with examples.

## 1. Check access

```bash
revflare whoami      # user, workspace, currency, permissions
```
"Not logged in" → ask the user to run `revflare login --url https://<their-revflare>` (it prompts for the key). Never
ask for the key in the chat. Imports need the `manage` permission.

### Daily limits (Cloudflare Free plan)

Revflare on the Workers Free plan has a daily database limit (5M rows read, 100k written; resets at 00:00 UTC). Exit
code 3 with one line on stderr means:
- "reached today's Cloudflare Free plan database limit": every request fails until 00:00 UTC (the message says how
  long). Do not retry in a loop; tell the user when it resets.
- "database budget for imports and other background work is used up": imports are capped per day so the dashboard
  keeps working; reads still work. Re-run the same import after 00:00 UTC.
`revflare usage` (instance admins) shows the database size and today's background budget.

Instance admin commands (`usage`, `admin ...`) do not work with a workspace API key: the user must sign in as an
instance admin with `revflare login --email <their email>` (prompts for the password; use `--profile admin` to keep
the API key profile). On "Admin commands need an instance admin's sign-in", tell them that; never ask for the password
in the chat.

## 2. Answer questions

```bash
revflare overview                                  # today, yesterday, KPIs (28d) with change, MRR movement, at risk, forecast, goals, top apps, alerts
revflare apps [--platform ios|android|web]         # per app: store (App Store / Google Play / Polar), MRR, 28-day revenue, active subs, trials, notification status
revflare app <id|bundle-id>                        # one app: setup, history sync, SDK key, products (Android: Google Play setup)
revflare apps add-android <name> <package>         # add a Google Play app (manage), then set it up with google-play
revflare google-play <app> [status|set-credential <key.json|->|set-push-account <email|none>|test|voided]   # Android app's Google Play setup
revflare apps add-web <name> [id]                  # add a website selling through Polar (manage), then set it up with polar
revflare polar <app> [status|set-token -|set-secret -|map <polar-id>=<product-id>|unmap <id>|sandbox on|off|sync]   # web app's Polar setup
revflare apps <app> test-devices [list|add <install-id...>|rm <install-id...>]   # test devices (≤ 50): left out of events, funnels, experiments, LTV, attribution (add / rm need manage)
revflare chart <metric> [--range 30d|90d|12m|mtd|ytd|all | --from D --to D] [--interval day|week|month] [--group-by app|country|product] [--app X ...]
revflare breakdown --by app|country|product [--metric revenue] [--range 28d]
revflare mrr-movement [--range 12m] [--interval month]
revflare transactions [--kind new,conversion,renewal,trial,one_time] [--app X] [--country US] [--refunded] [--source apple_ads|google_ads|referral|organic|unknown] [--quick] [--limit 50] [--follow]
revflare transactions --cancellations [--quick]    # auto-renew turned off (App Store / Google Play), newest first, with the time since the purchase
revflare customer <id>                             # first / last seen (date + time, source), install time, install→buy / buy→cancel / buy→refund durations, quick flags, spend, subscriptions (auto-renew off = cancelled, with the date), transactions, notification history, acquisition
revflare at-risk                                   # billing retry, grace period, auto-renew off
revflare forecast [--days 30]
revflare cohorts [--months 12] [--ltv]
revflare revenue-daily [--range 7d]                # per app and day (what Adsflare uses for ROAS)
revflare alerts
revflare goals [--all]                             # goals: name, apps, period, current / target, progress, pace (on track / behind / reached / missed), days left (--all: archived too)
revflare goals show <id>                           # expected by now, ahead / behind, needed per day, projected end of period, start value (MRR / actives), reached date, previous period
revflare goals add --target N [--name T] [--metric revenue|proceeds|mrr|new_subscriptions|trials_started|active_subscriptions|sales] [--period week|month|quarter|year | --from D --to D] [--apps a,b | --exclude-apps a,b] [--no-notify]
revflare goals edit <id> [same options] [--all-apps] [--no-notify] | goals archive <id...> [--undo] | goals reorder <id...> | goals rm <id...>   # need manage
revflare attribution [--range 28d] [--app X] [--by campaign|adgroup|keyword] [--include-test]   # Apple Ads revenue (RevflareKit), with names
revflare attribution names [list | import <file|->]   # Apple Ads names (CSV / TSV kind,id,name or JSON; import needs manage)
revflare ltv [--app X] [--by source|campaign|adgroup|keyword|country] [--cohort week] [--range 12m] [--proceeds]   # LTV per install cohort: D0/D7/D30/D90/D180 per install
revflare ltv --summary [--by campaign] [--range 90d]   # per group, pooled over installs old enough per horizon (payback / ROAS)
revflare sdk-key <app>                             # the app's RevflareKit SDK key (also: revflare app <app> --sdk-key)
revflare acquisition [--by source|referrer|campaign|day|app] [--range 28d] [--app X]   # App Store funnel by source (Apple App Analytics)
revflare acquisition campaigns | status | requests [--retry] | import
revflare meta <app>                                # Meta Ads integration: settings (never the token), event names, sent / pending / skipped / failed
revflare meta <app> log [--limit 30]               # last deliveries: sent, skipped (with the reason), failed (Meta's answer, fbtrace_id)
revflare meta <app> set [--dataset-id ID] [--token -] [--test-code CODE] [--enable|--disable] [--sandbox on|off] [--without-att on|off] [--event renewal=Subscribe] [--event-off trial_started]
revflare meta <app> test | backfill                # one test event (needs the test code) | queue the last 7 days again
revflare refunds <app>                             # Apple refund requests: settings, consent attestation, answered / skipped / failed / expired
revflare refunds <app> log [--limit 30]            # last requests: Apple's HTTP status (202 = accepted), the preference sent, skip reason
revflare refunds <app> set [--attest-consent] [--enable|--disable] [--policy none|decline-after|prorated|full] [--days N] [--sample on|off] [--consumed PCT|none]
revflare refunds <app> consent <customer-id> on|off   # a customer withdraws (off) / restores consent: their requests are skipped
revflare offers <app>                              # promotional offers RevflareKit may get signed (allowlist), strict mode, key / bundle id status
revflare offers <app> add <product> <offer> [--label T] [--win-back] | remove <product> <offer> | set --strict on|off | import
revflare offers <app> lapsed [--days 90]           # expired with auto-renew off (not grace / billing retry): by product + latest 200, total paid
revflare offers <app> stats [--range 90d]          # promotional (offerType 2) and win-back (4) redemptions, customers, revenue per offer
revflare offers <app> log [--limit 30]             # signature requests: signed / not_allowed / not_configured / not_subscribed
revflare offerings <app>                           # paywall offerings (packages → App Store products), the current one, placements
revflare offerings <app> show <offering>           # one offering: metadata JSON and packages in order
revflare offerings <app> export > offerings.json   # the whole config as JSON (what apply takes)
revflare offerings <app> apply <file.json|->       # replace the whole config (manage); prints warnings (unknown products)
revflare offerings <app> current <offering>        # make an offering the current one
revflare offerings <app> placements [set <placement> <offering|current>] [rm <placement>]
revflare entitlements <app>                        # server entitlements (→ product ids) and non-renewing durations
revflare entitlements <app> set <ent> <productIds…> # set an entitlement's products (add-product / remove-product / rm <ent>)
revflare entitlements <app> duration <productId> <3d|1w|1m|1y|none>  # a pass's duration (recomputes stored sales)
revflare config <app>                              # remote config: parameters (type, default, values per condition) and conditions in priority order
revflare config <app> eval [--country CN] [--app-version 2.1] [--locale zh_CN] [--install-id ID] [--os-version 18.1] [--source apple_ads|google_ads|referral|organic|unknown] [--campaign ID] [--ad-group ID] [--keyword ID] [--environment production|sandbox|xcode|debug]   # the values that device gets, and from which condition
revflare config <app> attribution-options [--days 30]   # Apple Ads campaign / ad group / keyword ids seen in the app's installs (for apple_ads_* rules)
revflare config <app> export > config.json         # the whole config as JSON (what apply takes)
revflare config <app> apply <file.json|->          # replace the whole config (manage)
revflare config <app> import-firebase <template.json|-> [--dry-run] [--merge]   # from `firebase remoteconfig:get -o template.json`
revflare config <app> set <key> <value> [--type string|number|boolean|json] [--condition <name>] [--in-app-default]
revflare config <app> rm <key> [--condition <name>]
revflare experiments <app>                         # A/B experiments on remote config parameters: id, name, status, parameters, variants, metric
revflare experiments <app> show <id>               # parameters, variants (a = control) and their values, targeting, traffic, dates
revflare experiments <app> results <id> [--refresh] # per variant: exposed installs, trial %, paid %, revenue / install, P(best), lift vs control (95% interval)
revflare experiments <app> create --file exp.json  # a draft: { name, keys, variants: [{ name?, weight?, values }], targeting?, traffic?, primaryMetric?, hypothesis? } (manage)
revflare experiments <app> start|stop|archive <id> # lifecycle (manage); stop keeps devices on their variant
revflare experiments <app> rollout <id> <variant>  # the variant's values become the parameters' defaults; the experiment ends (manage)
revflare events <app> [--range 7d] [--include-test]   # app events (RevflareKit Revflare.track): top events, counts, unique installs, per-day sparkline
revflare events <app> key-events [--add <pattern>] [--rm <pattern>] [--daily-cap N] [--retention DAYS]   # events stored exactly: patterns, cap, retention, exact since, today's count (changes need manage)
revflare funnels <app>                             # funnels: id, name, window, order, steps
revflare funnels <app> show <funnel> [--range 30d | --from D --to D] [--breakdown app_version|os_version|country|locale|placement|offering|product|step|screen|variant] [--include-test]
revflare funnels <app> create --name N --step event:onboarding_step:step=1 --step event:paywall_view --step revenue:trial_started [--window 7d] [--unordered]
revflare funnels <app> delete <funnel>             # funnels by id or name; create / delete need manage
revflare funnels <app> alerts <funnel> [on|off] [--sensitivity high|normal|low]   # daily funnel drop / release regression alerts (changes need manage)
```

Goals: money targets (revenue, proceeds, MRR) are in the workspace currency, the others are counts (sales = new
subscriptions + renewals + one-time purchases). Rolling periods (week Monday–Sunday, month, quarter, year; UTC days)
start over; a custom period (`--from/--to`) ends. Apps: all (default), `--apps` (one combined target for those apps) or
`--exclude-apps` (every app but those; apps added later count). MRR and active subscriptions are levels: `current` is
today's value and `startValue` the value when the period began. Progress never depends on an `--app` filter of the
overview. New goals push once per period when reached (iOS app builds that know goal pushes); `--no-notify` turns it off.

Apple Ads attribution: RevflareKit in the app sends Apple's attribution token; Revflare joins each attributed install's
revenue to its Apple Ads campaign / ad group / keyword. `attribution` sums the per-day rows client-side: revenue,
proceeds, transactions, trials, installs, payers and revenue per install per group, plus coverage (installs that
reported to RevflareKit and the share Apple attributed to Apple Ads, plus test installs hidden). `--json` gives the
aggregated groups, `--json --raw` the API's per-day rows. Groups show names as "Name (id)" when Revflare knows them (a
connected Adsflare fills them; `attribution names import <file>` imports `kind,id,name` lines), else the bare id; spend
(for ROAS) is in Adsflare — use the `adsflare` CLI if it is available. Apple's **test attribution** (AdServices test
payload, campaign 1234567890: development / TestFlight builds) is left out of totals, coverage, LTV and Meta like
sandbox data; `--include-test` counts it (groups flagged `[test]`); remote config still treats such installs as Apple
Ads. Every transaction carries `attribution` (`source` apple_ads / google_ads / referral / organic / unknown = no RevflareKit install linked,
campaign / ad group / keyword ids and names); `transactions --source apple_ads` filters the feed (a page looks at 500
transactions at most, so it can be short: follow `--cursor`). No rows and 0 installs reporting → RevflareKit is not set up: the app needs
`Revflare.configure(sdkKey:server:)` at launch and `.appAccountToken(Revflare.installId)` on StoreKit 2 purchases (apps on
RevenueCat only need `configure`). `sdk-key <app> --rotate --yes` replaces the key and the old one stops working at
once (shipped app versions stop reporting): never rotate unless the user explicitly asks.

Google Play (Android apps): apps with platform `android` (`bundleId` = package name; an iOS app and its Android app can
share it: select one with `ios:<id>` / `android:<id>` or the app id). Their sales come from Play's real-time developer
notifications completed with the Play Developer API: `store` `play_store` in the feed, exact proceeds from the Orders
API, test purchases as Sandbox, refunds from voided purchases (polled daily too). `google-play <app>` shows the setup:
service account key, RTDN push URL (secret: don't paste it in public places), push authentication, last notification /
check (the error says what to fix, e.g. the service account lacks "View financial data" in Play Console), last refunds
poll. No history before setup (no import yet). Apple-only features (Apple Ads, refund requests, offers, acquisition,
App Store imports) do not apply to Android apps. Setup steps: `docs/google-play.md` in the Revflare repo.

Polar (web apps): apps with platform `web` sell through Polar (web checkout, merchant of record). Polar webhooks
(`order.paid` / `order.refunded` / `subscription.*`) store transactions with store `polar`: price = net amount (before
tax), proceeds = net − Polar's fee; the checkout metadata's `revflare_install_id` links the sale to the install. They
count in revenue, MRR, the overview and the feed like store sales. `polar <app>` shows the setup (webhook URL, secret /
token set, product map, last webhook / import); `set-token -` lets Revflare create the webhook itself and `sync` import
past orders. Apple-only features do not apply to web apps. Setup steps: `docs/polar.md` in the Revflare repo.

LTV by acquisition source (`ltv`): installs that reported to RevflareKit grouped by install week (`--cohort day|month`)
and source (`apple_ads` / `organic`), Apple Ads campaign / ad group / keyword (organic installs are one `organic` group)
or country (Apple's, else the country of the install's first report). Values are revenue (or `--proceeds`) per install in
the first 24 hours (D0) and 7, 30, 90, 180 days after install and to date; refunds excluded, prorated ones in part;
`·` / `immature: true` = the cohort is not that old yet (never read it as zero). `--summary` pools each group over the
installs old enough for each horizon (`installs` per horizon = sample size): what Adsflare uses for payback and ROAS
(D90 needs `--range 180d` or more). Coverage = the apps' paying customers linked to a reporting install: low coverage
means the values are a floor (installs from app versions without RevflareKit, purchases never linked). Installs whose
purchases all started more than 48 hours before the install (users who had the app before) are left out of installs and
values (`coverage.preexisting`). Cohorts are UTC days, values are cached for the UTC day (today's sales show tomorrow).
Definitions: `docs/ltv.md`.

Meta Ads: Revflare sends each app's purchases server-side to Meta's Conversions API as app events, so Meta optimizes
campaigns on real trials, conversions and renewals (renewals included, even while the app is closed). Event types and
default Meta names: `trial_started` StartTrial (value 0), `initial_purchase` Subscribe, `trial_converted` Subscribe,
`renewal` Subscribe, `non_subscription_purchase` Purchase; values are USD (gross). Refunds, cancellations and expirations
are not sent. Matching needs RevflareKit in the app reporting the install's identifiers (Facebook SDK anonymous id, IDFA
when the user allowed tracking) and purchases linked to the install (`appAccountToken = Revflare.installId`, or
RevflareKit's transaction reports). By default only Production purchases of installs with ATT authorized are sent
(`--sandbox on`, `--without-att on` change that). Events wait up to 24 h for the install's identifiers, then are
skipped; Meta refuses events older than 7 days. "Why didn't Meta get my sale?" → `meta <app> log` and read the reason
(no install linked, ATT not authorized, Sandbox, older than 7 days, no anon_id / IDFA) or Meta's error. Changing settings
needs `manage` and the user's explicit request; the access token is write-only (`--token -` reads it from stdin: never
put it in the chat or the command line). After fixing a token or setting, `meta <app> backfill` queues the last 7 days
again (sent events are never sent twice).

Refund requests: when a customer asks Apple for a refund, Apple sends a CONSUMPTION_REQUEST and accepts consumption
information for 12 hours. Revflare answers (off by default) with `customerConsented: true`, `deliveryStatus: DELIVERED`
(it cannot know about delivery problems), `sampleContentProvided`, an optional consumed percentage (never for
auto-renewable subscriptions) and the app's refund preference: `none` (default, Apple decides), `decline` (DECLINE at
any age), `decline-after` N days
(DECLINE when the purchase, or the subscription's first purchase, is at least N days old), `prorated`, `full`.
Requests reaching Revflare's URL are answered also when forwarded to RevenueCat (which only answers when set up to),
and requests polled from Notification History are answered while Apple's 12 hours last. Workspace defaults
(`refunds defaults [set ...]`) apply to every app without its own settings (`refunds <app> set --use-defaults` goes
back to them). An unanswered production request raises a `refund_request_unanswered` alert. Turning it on needs `--attest-consent`: the user confirms they
obtained their customers' consent to share consumption data with Apple (Apple requires it; recorded with their name) —
never set it, enable answers or change the policy unless the user explicitly asks. A customer can withdraw consent
(`refunds <app> consent <customer> off`). "Why wasn't this refund request answered?" → `refunds <app> log` (skipped:
off / no attestation / consent withdrawn; expired: past 12 hours; failed: Apple's error). Prorated refunds
(Apple's revocationPercentage) only take their share out of revenue; transactions show `refundPercentage`.

Offers: promotional offers need a signature made with the workspace's In-App Purchase key; RevflareKit asks Revflare
(`POST /sdk/v1/offers/sign`), which signs only the app's allowlisted (product, offer) pairs, rate limited (10 / hour per
install, 1000 / hour per app), and in strict mode only for installs linked to a subscription of the product's group.
Win-back offers need no signature (allowlist entries of kind win_back only label them). "Why did the app get
not_configured?" → no In-App Purchase key or no bundle id (`offers <app>` shows both). Transactions carry `offerType`
(1 intro, 2 promotional, 3 offer code, 4 win-back) and `offerId`. Who to target → `offers <app> lapsed`; did the offer
work → `offers <app> stats`. Changing the allowlist or strict mode only on the user's explicit request (`manage`).
MCP: `get_offers`, `get_lapsed_subscribers` (read-only).

Offerings (paywalls, like RevenueCat offerings): each app has offerings (identifier, display name, metadata JSON for
the paywall, ordered packages such as `$annual` / `$monthly` / `$lifetime` or custom ids, each → an App Store product id),
at most one **current** offering, and placements (paywall locations such as `onboarding` → an offering, or the current
one). RevflareKit loads them at app launch (`GET /sdk/v1/offerings`), so changes reach apps within about a minute and
need no app update. Identifiers: letters, digits, `_ . $ -`, at most 64; limits 50 offerings, 20 packages each, 50
placements, 8 KB per metadata. To change several things: `export` to a file, edit it, `apply` it (atomic; invalid
configs are refused with the reason and change nothing; products not among the app's known products only warn —
check the product id against `revflare app <app>`). Changing offerings changes what paying users see: only with the
user's explicit request (`manage` permission). Deleting an offering that placements use is refused in the web app /
API unless forced (they fall back to the current offering).

Entitlements (RevflareKit 1.9+): per app, entitlement → product ids served with the offerings; the SDK adds them to the
app's own map (union) and loads those products, so a new product unlocks e.g. `pro` without an app update. Non-renewing
products (passes such as a 3-day pass) need a **duration** (day / week / month / year × count): without one StoreKit
gives no expiry and the SDK treats them as lifetime. With it, the SDK expires passes (repeat purchases stack) and
Revflare stores purchase + duration as each pass's expiry (also recomputed for past sales; large month / year changes
continue in the background, `truncated`); passes stay one-time revenue, never MRR. Durations are only for non-renewing
passes: Revflare refuses them for products known as non-consumable or auto-renewable, and Google Play one-time products
are ambiguous (never give a lifetime product a duration). The SDK ignores a Revflare duration for products the app
declares itself unless the app sets a local duration too, so server durations are for products added after the app
shipped. Changing them changes who gets access: only on the user's explicit request (`manage`). MCP:
`get_entitlements`, `set_entitlements`.

Remote config (like Firebase Remote Config): each app has typed parameters (`string`, `number`, `boolean`, `json`;
keys: letters, digits, `_ . -`) with a default value (or "in-app default": the key is left out and the app's own default
applies) and values per condition. Conditions are ordered: for each parameter the first matching condition (in that
order) that has a value wins, else the default. A condition matches when all its rules match: `country` (the App Store
storefront the app reports, else the request's country), `ip_country`, `storefront`, `language` (zh matches zh_CN),
`locale`, `app_version` / `app_build` / `os_version` / `sdk_version` comparisons (semantic: 2.10 > 2.9), `percent`
(stable bucket per install: from <= bucket < to), `install_id` (testers), `source` (`apple_ads` / `google_ads` /
`referral` / `organic` / `unknown`: how the install was acquired; `unknown` until Apple answers, e.g. on the first launch;
`google_ads` (gclid) and `referral` (utm_source) come from Android installs' Play Install Referrer), `apple_ads_campaign`
/ `apple_ads_ad_group` / `apple_ads_keyword` (Apple Ads ids; `config <app> attribution-options` lists the ids seen) and
`environment` (`production` App Store / Google Play, `sandbox` TestFlight / development / Play test track, `xcode`,
`debug` debuggable Android build). "Hard paywall for Apple Ads users"
→ a condition `source in [apple_ads]` with the paywall value. RevflareKit fetches the device's values at
launch (`GET /sdk/v1/config`); changes reach apps within about a minute plus the app's fetch interval. "What does a user
in China on 2.1 get?" → `config <app> eval --country CN --app-version 2.1`. Firebase import: conditions Revflare cannot
evaluate (user properties, audiences, dates, `||`) are imported as conditions that never match, with a warning — run
`--dry-run` first and tell the user about the warnings. Changing the config changes what users see: only on the user's
explicit request (`manage`); `set` edits one value, `export` / edit / `apply` for bigger changes (atomic, invalid configs
are refused with the reason).

Events and funnels: RevflareKit sends app events (`Revflare.track("paywall_view", ["placement": "onboarding"])`) to
Revflare, which stores them in Cloudflare Workers Analytics Engine (3 months; it samples apps that send a lot). Key
events (`first_open`, `purchase_*`, `restore_*`, `paywall_view`, `paywall_close`, `onboarding_*`, `experiment_exposure`
plus up to 20 patterns per app, `events <app> key-events`) are also stored exactly in the database: funnels whose event
steps are all key events, experiment exposures, alerts and the digest read them once they cover the range
(`source: "exact"`, no sampling). A report starting before the app's "exact since" day, or including an incomplete day
(capped, out of background budget or a failed write), uses Analytics Engine for the whole range (`source: "sampled"`, a
note says why; the events page's `notes` too). `events` lists the top events with counts
and unique installs (SOURCE exact or sampled per event); `funnels <app> show` answers "where do users drop off": per step the
installs that reached it, conversion from the previous and the first step, drop-off and the median time from the
previous step. Steps are events (names: letters, digits, `_ . : -`; optional property filters, `key=value`) or revenue
steps from Revflare's own sales of the install (`trial_started`, `paid`, `any_purchase`; purchases linked to the install
with `appAccountToken = Revflare.installId`); the first step is always an event and defines who enters (by entry day,
UTC). An install counts at a step when it happens after the previous step (ordered, default; `--unordered`: any order
after the first) and within the window of the first step (default 7d). `--breakdown` splits by the first step's app
version, OS version, country, locale or a promoted property (placement, offering, product, step, screen, variant): top
10 values plus "(other)". `approximate: true` (with `notes`) means Analytics Engine sampled the events (counts are lower
bounds, rates stay close), a step had more than 50,000 installs, or a step time was inferred — say so (exact reports
have none of the sampling caveats). Error "Event
queries are not configured" → the server needs `CF_ACCOUNT_ID` and the secret `CF_ANALYTICS_TOKEN` (README, Events and
funnels). Creating or deleting funnels only when the user asks (`manage`).

Test data: RevflareKit tells which build sent the data (`production`, `sandbox` = TestFlight / development, `xcode`).
Events, funnels, experiments, alerts, the digest, LTV, attributed revenue and Meta sending count production data only,
without the app's test devices (`apps <app> test-devices`, install ids). `events` and `funnels <app> show` take
`--include-test` to count sandbox / Xcode builds and test devices too (the output says "test data included"); answer
with production numbers unless the user asks about their own testing. Installs reported before RevflareKit sent its
build count as production.

Funnel alerts (`revflare alerts`, kinds): `events_silent` (an app that usually sends events stopped for 3 / 6 / 12+
hours), `funnel_anomaly` (yesterday's conversion at a step dropped significantly against both the 14 days before and the
same weekday: two-proportion tests p < 0.01 and a relative drop of at least 15 / 20 / 30 % for high / normal / low
sensitivity, ≥ 100 installs entering yesterday) and `release_regression` (the newest app version with ≥ 200 installs
converts worse at a step than the most used other version over the same days; resolved when a later check finds none),
`key_events_capped` (an app reached its daily key-event cap — default min(50,000, the instance's background writes a day
/ 6), 9,166 on the Free plan defaults — or the instance's background budget, or a store failed: the rest of that day is
sampled; raise it with `events <app> key-events --daily-cap N` (`default` for the instance's default) only when the
user asks, and mention that a cap above half the background write budget can starve imports and syncs). `funnelId` in `--json` names the funnel: follow up with `funnels <app>
show <funnel> --breakdown app_version`. Each funnel has `alerts: { enabled, sensitivity }` (on, normal by default);
change it only when the user asks (`funnels <app> alerts <funnel> off`, `--sensitivity low` for fewer alerts).

Experiments (`experiments <app> results <id>`): devices are assigned to variants in a stable way (install id + experiment
id) and RevflareKit 1.7+ logs `experiment_exposure` when the app reads one of the experiment's parameters; results count
each variant's exposed installs and what they began after their first exposure: trials, paid conversions (first paid
period or one-time purchase, refunds subtracted) and revenue (renewals of subscriptions bought before the exposure do
not count). Results are stored and recomputed by the server every few hours (`generatedAt`); `--refresh` recomputes now
(at most once an hour per experiment). **Do not call a winner while `enoughData` is false** (the `reasons` say what is missing: 7 days, 100 exposed
installs per variant, 10 conversions on the primary metric). P(best) is the Bayesian probability (Beta posteriors) that a
variant has the highest rate; lift is against the control (a) with a 95% credible interval: an interval that crosses 0 is
not a clear difference. `confident` = P(best) ≥ 95% on the primary metric with the guardrails met (also an
`experiment_result` alert with `experimentId`). Revenue per install is a point estimate. `approximate` / notes: sampled
events or exposures from the daily snapshot (no conversions) — say so. Results are final after the stop. Start, stop, roll out or archive only when the user asks: rollout writes the variant's values as the
parameters' defaults for every device; a running experiment stops by itself after 90 days.

App Store acquisition (Apple's App Analytics reports) answers where App Store visitors, first-time downloads and App
Store purchases come from: impressions → product page views → downloads, conversion rate (downloads / unique page
views), redownloads, purchases and proceeds (Apple's estimate) per source type (App Store search — Apple Ads taps count
here —, App Store browse, App referrer, Web referrer, App Clip...), referrer (app or website), campaign token, day or app.
`--by` takes several dimensions (`--by day,source`). Source / day / app come from Apple's **Standard** reports
(complete); referrer and campaign from the **Detailed** reports (`level: "detailed"`): Apple leaves out rows with fewer
than 5 users and adds noise, so rows sum to less than the totals — say so when reporting them. `(none)` = no referrer /
campaign. Campaign links: `https://apps.apple.com/app/id<APPID>?pt=<provider token>&ct=<campaign>` (pt from App Store
Connect → Analytics → Campaigns); `acquisition campaigns` lists every token seen (first / last seen, page views,
downloads, proceeds). No data (`firstDay` null) → the reports were not requested: `revflare acquisition requests`
(needs an App Store Connect key with the **Admin** role; reading them works with **Sales**; an optional
`appstore_reports` credential, e.g. a Sales key, is used for Sales and Trends and App Analytics before the main key),
then Apple produces them **1–2 days later** and Revflare imports them on its own (`acquisition import` starts a full
import job now). Data always lags 1–2 days. `acquisition status` shows each app's request state and errors.

Workspace (needs the `members` permission; `usage` needs an instance admin):
```bash
revflare invite --role viewer|admin|owner [--email a@b.c]   # prints a one-time invitation link (valid 7 days)
revflare invitations                                       # pending invitations
revflare invitations revoke <id>
revflare usage                                             # database size, today's background budget, Free plan limits
```
Instance admins (signed in with `revflare login --email`; read-only, user and workspace changes are made in the web
app under Admin):
```bash
revflare admin overview      # users, workspaces, apps, purchases, jobs, cron, database usage, version / update available
revflare admin users         # every user: admin, status, last sign-in, workspaces and roles
revflare admin workspaces    # every workspace: owners, members, apps
```
Apps can be named by id, bundle id, App Store id or exact name (`--app` repeatable or comma separated).
Chart metrics: `revenue, proceeds, mrr, mrr_proceeds, arr, active_subscriptions, active_trials, new_subscriptions,
renewals, one_time_purchases, trials_started, trial_conversions, trial_conversion_rate, refunds, refunds_amount,
refund_rate, churn_rate, churned_subscriptions, new_customers, arppu`.

Question → command:
- "How much did I make today / this month?" → `overview` (today) or `chart revenue --range mtd` (total line).
- "Revenue last year by month" → `chart revenue --range 12m --interval month`.
- "What's my MRR / how is it trending?" → `chart mrr --range 12m --interval month` and `mrr-movement`.
- "Top countries / apps / products" → `breakdown --by country|app|product --range 28d`.
- "Churn / trial conversion / refunds" → `chart churn_rate|trial_conversion_rate|refund_rate --range 90d --interval week`.
- "Who's about to churn?" → `at-risk`. "What will renew next month?" → `forecast --days 30`.
- "Show recent sales" → `transactions --limit 20`; live feed → `transactions --follow` (runs until stopped).
- "Who bought / cancelled within 5 minutes?" → `transactions --quick` (first purchase / trial within 5 minutes of the
  RevflareKit install, or auto-renew turned off within 5 minutes of the purchase; a page looks at 500 rows at most,
  follow `--cursor`) and `transactions --cancellations --quick`; "who cancelled recently?" → `transactions
  --cancellations`. Per customer: `customer <id>` (Install→buy, Buy→cancel, Quick lines). Install times need
  RevflareKit; without it only the cancellation side is known.
- "Which Apple Ads campaigns / keywords make money?" → `attribution --range 90d --by campaign|keyword --json`.
- "Which recent sales came from Apple Ads? / where did this customer come from?" → `transactions --source apple_ads` /
  `customer <id>` (Acquisition line).
- "What is an install worth / D30 LTV per campaign / do Apple Ads users pay more than organic?" → `ltv --summary --by
  campaign --range 180d` (or `--by source`), cohorts over time → `ltv --by source --cohort month --range 12m`.
- "Where do my downloads come from? / App Store conversion rate / impressions" → `acquisition --range 28d` (then
  `--by referrer`, `--by campaign`, `--by day,source`).
- "How did my App Store campaign link do?" → `acquisition campaigns` and `acquisition --by campaign --range 90d`.
- "Is Meta getting my purchases? / why was this sale not sent to Facebook?" → `meta <app>` then `meta <app> log`.
- "Did we answer Apple's refund requests? / what did we tell Apple?" → `refunds <app>` then `refunds <app> log`.
- "Why did I get a funnel alert? / did the new version break the paywall?" → `alerts --json` (kind, `funnelId`), then
  `funnels <app> show <funnel> --range 14d --breakdown app_version`.
- "Where do users drop off in onboarding? / how many paywall viewers start a trial?" → `funnels <app>`, then
  `funnels <app> show <funnel> --range 30d` (`--breakdown app_version` to compare versions); no funnel yet → `events
  <app>` for the event names, then (when asked) `funnels <app> create ...`.
- "Which products does my paywall show? / switch the onboarding paywall to the sale offering" → `offerings <app>`, then
  (when asked) `offerings <app> placements set onboarding sale` or `offerings <app> current sale`.
- "I added a 3-day pass, make it unlock pro without an app update" → `entitlements <app>`, then (when asked)
  `entitlements <app> add-product pro <pass id>` and `entitlements <app> duration <pass id> 3d` (and add it to an offering).
- "What do users in China get? / turn on the new onboarding for 20% / move my Firebase Remote Config" → `config <app>`,
  `config <app> eval --country CN`; (when asked) `config <app> set <key> <value> [--condition <name>]` or
  `config <app> import-firebase template.json --dry-run`, then without `--dry-run`.

## 3. Metrics glossary

- **Revenue**: what customers paid (gross, before Apple's commission, after refunds). **Proceeds**: what the developer
  receives after Apple's 15%/30% commission (and taxes Apple withholds). Say which one you report.
- **MRR**: active paid subscriptions normalized to a month (annual / 12, weekly × 4.33); trials and one-time purchases
  are excluded. **ARR** = MRR × 12. `mrr_proceeds` is MRR after commission.
- **MRR movement**: new (first paid period), expansion (upgrade), reactivation (came back), contraction (downgrade),
  churn (expired / refunded); net = sum. MRR(end) ≈ MRR(start) + net.
- **Active subscriptions / trials**: snapshot at the end of each day. **Churn rate**: churned subscriptions / actives
  at the start of the period. **Trial conversion rate**: conversions / trials that ended.
- **At risk**: MRR of subscriptions in billing retry or grace period, or with auto-renew off — it will not renew
  unless the customer acts.
- **Forecast**: renewals due in the next N days × the renewal rate observed per subscription period.
- **Cohorts**: customers grouped by the month of their first payment; retention = still paying N months later;
  LTV = cumulative revenue per customer.
- Charts mark days that come from imported history (RevenueCat Charts) with `*` (`importedUntil` in JSON): those
  values are RevenueCat's, before Revflare's own transaction history of the app starts.

## 4. Imports and setup

```bash
revflare import apple [--app X]                 # Apple backfill: 180 days of notifications + customers' transaction history (jobs)
revflare import revenuecat --credential <id>    # server-side: finds App Store transaction ids in a RevenueCat project
revflare import revenuecat-charts [--project <id>] [--metric mrr,revenue] [--dry-run]
revflare import sales-reports [--days 30]       # Apple Sales and Trends (reconciliation)
revflare import fx [--from 2019-01-01]          # exchange rates
revflare jobs | revflare jobs show <id> | revflare jobs cancel <id>
revflare mcp                                    # MCP server config (<url>/mcp) for Claude / other agents
```
`import revenuecat-charts` reads the RevenueCat dashboard's charts through the user's local `revenuecat` CLI (OAuth:
`revenuecat auth login`), maps each RevenueCat project to Revflare apps by the bundle ids of its App Store apps, and
stores daily revenue, proceeds, MRR, actives, trials, new subscriptions, refunds and churned subscriptions (USD) for the
days before Revflare's own history. It is idempotent: metrics already imported up to the last day are skipped
(`--force` sends them anyway) and the server only rewrites changed values. Run with `--dry-run` first and show the user
what will be imported. When the daily import budget is used up it stops cleanly (exit code 3), prints how far it got,
and re-running the same command after 00:00 UTC continues. Long-running imports are jobs: check them with `revflare jobs`.

## 5. Reporting

- Lead with the number the user asked for, then the comparison (change vs previous period is in `chart` totals and
  `overview` KPIs). Name the currency and whether it is revenue or proceeds.
- Use `--json` and compute from it rather than reading tables when summing or comparing.
- If numbers look empty for an app, check `revflare app <app>` (notifications "none", history not synced yet) and
  `revflare alerts`; suggest `revflare import apple --app <app>`.
