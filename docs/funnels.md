# Events and funnels

RevflareKit sends app events; Revflare stores them in Cloudflare Workers Analytics Engine (WAE) and builds funnels from
them and from its own sales. Setup: README, *Events and funnels*. API: [api.md](api.md#events-and-funnels-revflarekit-events-workers-analytics-engine).

## How it works

```
app (Revflare.track) ──POST /sdk/v1/events──▶ Worker ──writeDataPoint──▶ WAE dataset "revflare_events" (3 months)
web / CLI / MCP ──/api/v1/apps/:id/events, /funnels──▶ Worker ──SQL API (CF_ACCOUNT_ID + CF_ANALYTICS_TOKEN)──▶ WAE
                                                         └── revenue steps: install_links → transactions (database)
```

- **Ingest** touches the database only for key events (see [Exact key events](#exact-key-events)): the SDK key → app
  lookup is cached in the Worker isolate (5 minutes, unknown keys 1 minute), rate limits are in-isolate token buckets,
  and the "last event received" note (Events page) is written at most every 10 minutes per isolate and app. One data point per event, `index1` = app id (WAE samples per index
  value, so each app is sampled on its own). Layout in [api.md](api.md) and `worker/lib/events.ts`.
- **Queries** go to the WAE SQL API, always scoped by `index1 = <app id>`. The SQL API has no bind parameters, so every
  value placed in a query passes a strict allowlist (event names, property keys and filter values have limited
  alphabets without quotes or backslashes; times are integers). Results are cached 5 minutes per query text (and reports
  per funnel and range), with time ranges rounded to 5 minutes so repeated reads cost nothing.

## Exact key events

WAE samples at write time, per index value (the app id): even small apps can lose rows (one app kept ~45% of its rows
over a day, `_sample_interval` up to 10), and a funnel loses an install whenever one of its steps' rows was dropped.
So **key events** are also stored exactly in the database (`app_events`, migration 0021) and the readers that need
per-install data use them whenever the stored data covers their range:

- **Allowlist** (case-insensitive): `first_open`, names starting with `purchase_` or `restore_`, `paywall_view`,
  `paywall_close`, names starting with `onboarding_`, `experiment_exposure`, plus up to 20 patterns per app (web app →
  app → *Key events*, `revflare events <app> key-events --add '*_paywall_view'`, `PUT /apps/:id/key-events`): exact
  names or one `*` at the start or the end. Everything else (screen views, taps...) stays in WAE only.
- **Ingest**: every event still goes to WAE. After the response, one database call stores the batch's key events with
  `INSERT OR IGNORE` on the primary key `(app_id, id)` (the client event id: SDK retries never double-write), 5 rows per
  statement (17 columns, at most 100 bound parameters), with the build's environment and the promoted properties in
  their own columns, and adds the names actually inserted (`RETURNING`) to a per-name daily rollup (`app_event_counts`).
A failure never fails the request: the call is retried once; if it fails again, the isolate remembers the app and day
and the app's next call flags that day incomplete (`capped = 3`, alert "Key events incomplete for <app> on <day>"), so
reads including it use WAE; a write failing inside the database object flags the day at once. (A failure followed by
no other key event of the app in the same isolate goes unflagged: best effort.) A batch without key events costs nothing. Like every event, key events need the `EVENTS` binding (without it nothing is stored).
- **Caps**: at most 500 key events per install and UTC day — an anti-abuse limit, approximate: counted in the database
  object's memory per UTC day of reception, and an install it has not seen today (or after a restart) is counted once
  through the `(app_id, install_id, ts)` index by event time, so events from an offline queue can count against the
  wrong day; at most the app's **daily cap** per UTC day (`0` stores none; default min(50,000, background writes a
  day / 3 / 2): 9,166 on the Free plan defaults, so key events use at most about half the background write budget; the
  settings show the cap in effect and the web app warns when a cap would use more). Over the cap, the rest of the day is WAE only, the
  day is flagged and one `key_events_capped` alert is raised ("Key events capped for <app> today"). Key events are
  background work for the [daily database budget](../README.md#how-it-runs-on-the-free-plan): they are metered with backfills and imports, and when
  the instance's background budget is used up the day is flagged the same way (same alert).
- **Cost**: about 3 rows written per stored event (the row and its two indexes: `(app_id, name, ts)` and
  `(app_id, install_id, ts)`) plus, per request, the day counter, one rollup row per distinct name and the budget
  counter; a retried batch writes only the budget counter. On the Free plan (100,000 rows written a day, 55,000 for
  background work by default) that is roughly 18,000 key events a day for the whole instance: raise
  `BACKGROUND_WRITES_PER_DAY` on Workers Paid (the default cap follows it). Reads (`test/workers/sdk-key-events.test.ts`, "exact key-event read cost"): an
  exact funnel, the funnel alerts and experiment exposures read about 3 rows per stored event of their steps in the
  range; the events page reads the rollup (names × days) and the names' rows once (unique installs).
- **Retention**: the cron deletes stored key events older than the app's retention (default 180 days, 7 to 365), at
  most 5,000 rows per tick through the `(app_id, name, ts)` index, once a day (and their day and rollup rows).

**Coverage**: an app's exact data starts on its first full UTC day of stored key events (`since` in the settings: the
day after its first stored key event + 5 minutes, since other isolates keep the previous settings that long); an extra
pattern covers its events from the day after (added + 5 minutes); turning storage back on (daily cap from 0) starts
over. A read is **exact** when every event it needs is covered from the first day of its range, no day in the range is
incomplete (capped, out of budget or a failed write), and the range
holds at most 1,000,000 stored key events. Otherwise it uses WAE for the **whole** range, with a note such as "Exact
data starts 2026-10-24; earlier days are sampled": mixing exact and sampled days in one funnel would mix per-install
histories of different quality (an install entering on a sampled day and converting on an exact one), so a report is
either exact or sampled.

Readers:

- **Funnels**: when every event step is a key event covered for the range (and the breakdown is not `os_version` or
  `locale`, which only WAE has), the event steps come from the database: the same per-install first / last time, count
  and first-step breakdown value as the WAE query, so the funnel computation is unchanged. The report says
  `source: "exact"` and has no sampling note. Revenue steps are unchanged. Same 5-minute cache, same 50,000-install cap
  per step.
- **Experiments**: exposures come from `experiment_exposure` key events when they cover the experiment since its start.
- **Funnel alerts and the digest**: the anomaly / regression checks (15 days) and the digest's installs and paywall
  views (8 days) use the stored key events when they cover those days.
- **Events page** (`revflare events`, MCP `get_event_summary`): key events covered for the range show exact counts,
  unique installs and per-day counts (UTC days of reception, like WAE) with `source: "exact"`, counts from the rollup
  and unique installs from one `COUNT(DISTINCT install_id)`; other events come from WAE (`source: "sampled"`). Over
  150,000 stored key events in the range (plus the 7 days before it, which the scan goes through) or with an
  incomplete day, every event comes from WAE and `notes` says why. If WAE's daily query hits its 10,000-row limit,
  `notes` says the daily breakdown is incomplete. The query service is still needed (the page reads WAE for the rest).
- Test data is stored too (the environment column) and filtered like WAE: production data from other devices than the
  app's test devices, unless `includeTest`. The rollup counts production and sandbox / Xcode builds apart
  (`includeTest` adds both); the default view subtracts the test devices' production rows, read through the
  `(app_id, install_id, ts)` index (a few devices, at most 500 rows a day each), so it stays exact.

## Naming events

- Names: letters, digits, `_ . : -`, at most 64 characters, e.g. `onboarding_step`, `paywall_view`, `paywall_close`,
  `signup_completed`. Prefer a few stable names with properties over many names (`onboarding_step` with `step=3`, not
  `onboarding_step_3`).
- Properties: at most 10 per event, keys `^[A-Za-z0-9_.-]{1,40}$`, values ≤ 100 characters (numbers and booleans become
  strings). These six are **promoted** to their own column, so filtering and breakdowns on them are fast and exact:
  `placement`, `offering`, `product`, `step`, `screen`, `variant`. Other keys stay in a props JSON column (filters on them
  match the `"key":"value"` pair).
- Events older than 7 days or more than 1 hour ahead of the server are dropped (an offline queue should flush sooner).

## Funnel semantics

A funnel has 2 to 10 steps:

- **Event steps**: an event name, optionally with property filters (equality).
- **Revenue steps** come from Revflare's own sales, linked to installs through `install_links` (purchases made with
  `appAccountToken = Revflare.installId`, or reported by RevflareKit): `trial_started` (a free trial), `paid` (any paid
  transaction: intro offer, first purchase, renewal, one-time purchase), `any_purchase` (either). All environments count
  (Sandbox / TestFlight too, so funnels work while testing). A revenue step is never the first step.

Who enters: installs whose **first** occurrence of step 1 is within the date range (UTC days). Then, per install:

- **Ordered** (default): step *k* counts when it happens at or after the time of step *k−1* and within the **window**
  after step 1 (e.g. 7 days). The time of step *k* is its first occurrence at or after step *k−1*.
- **Unordered**: steps 2..n may happen in any order, each at or after step 1 and within the window.
- An install that misses a step leaves the funnel (it does not count at later steps).

Per step the report gives the installs that reached it, conversion from the previous and from the first step, drop-off
(installs of the previous step that did not reach it) and the median time from the previous step (from step 1 in
unordered funnels). A breakdown splits everything by a value of the install's **first step** event (app version, OS
version, country, locale or a promoted property): the 10 largest groups plus `(other)`.

## Approximation

The report says `approximate: true` with a note when:

- **Sampling**: WAE keeps every event of small apps but samples apps that write a lot (each stored row then stands for
  `_sample_interval` events). Event counts in the Events page are weighted, so they stay right on average; funnel user
  counts are counts of installs whose events were kept, so they are lower bounds. Conversion rates stay close because
  sampling applies to all steps alike.
- **Caps**: a step query returns at most 50,000 installs (the earliest ones); revenue steps look up at most 20,000
  installs (≤ 90 per database statement, indexed reads only).
- **Inferred times**: WAE returns, per install and step, the first and last time and how many times it happened. When a
  step happened before *and* after the previous step and more than twice, the step time is taken as its last occurrence
  (an upper bound); an install whose last occurrence falls outside the window is counted as not converted.

Unique installs in the Events page are exact only without sampling. None of this applies to exact reads of
[key events](#exact-key-events) (`source: "exact"`), except the 50,000-install cap and inferred times.

## Test data

RevflareKit sends the build it runs in (`environment`, top level of the events body): `production` (App Store),
`sandbox` (TestFlight, development builds) or `xcode` (StoreKit configuration file); missing or invalid is
`production` (older SDKs). It is stored in `blob18` (data point layout version 2, `double3 = 2`).

- Every query is built on one scope (`appScope` in `worker/lib/wae.ts`): by default it keeps `(blob18 = 'production'
  OR double3 < 2)`: events stored before layout 2 (`double3` 1) have no environment and count as production.
- **Test devices**: each app can list up to 50 install ids (web app → app → Events → *Test devices*, `revflare apps
  <app> test-devices add <id>`, `PUT /apps/:id/test-devices`); their events are left out with `blob2 NOT IN (...)`.
- `includeTest=true` (web: *Include test data* on the Events and Funnels pages, CLI `--include-test`, MCP
  `includeTest`) removes both filters for the events summary and funnel reports.
- Experiments always count production data from other devices (no `includeTest`). Funnel alerts, release regressions,
  the daily digest and insights use production data only. The event-silence alert reads the "last event" note of
  production builds; events from sandbox / Xcode builds update a separate note that the setup status shows.

## Alerts

Revflare watches app events and funnels on its own and raises alerts in the web app (Alerts, Overview) and as pushes
(push kind `funnel`: the iOS app's **Funnel alerts** setting, globally and per app; a muted app gets none; only iOS app
builds that know these pushes' texts get them, `pushVersion` ≥ 1 in the device preferences). Code:
`worker/lib/insights.ts` (rules in `worker/lib/stats.ts`).

| Kind | When | Key (one alert per key) |
| --- | --- | --- |
| `events_silent` | hourly | `events_silent:<app>:<day of the last event>` |
| `funnel_anomaly` | once a day per funnel, from 10:00 UTC | `funnel_anomaly:<funnel>:<yesterday>` |
| `release_regression` | once a day per funnel, from 10:00 UTC | `release_regression:<funnel>:<version>` |

Settings, per funnel (`PATCH /apps/:id/funnels/:fid { alerts: { enabled, sensitivity } }`, the funnel page in the web
app, `revflare funnels <app> alerts <funnel> on|off --sensitivity high|normal|low`): on by default, sensitivity
`normal`. There are no free-form thresholds:

| Sensitivity | Funnel / release drop | Event silence |
| --- | --- | --- |
| high | ≥ 15 % | 3 hours |
| normal | ≥ 20 % | 6 hours |
| low | ≥ 30 % | 12 hours |

- **Events stopped** (`events_silent`, no Analytics Engine query): the hourly alert check reads each app's "last event
  received" note and keeps a small state per app (settings `events_seen:<app>`: in how many hourly checks per UTC day the
  note had moved, a cheap measure of the app's volume). An app that received events on at least 4 of the last 7 days and
  has been silent longer than its threshold gets an alert; the threshold is the sensitivity's hours, or twice the app's
  usual gap between active hours when that is longer (at most 48 hours). It resolves itself as soon as events return
  (an event newer than the alert, or a silence back under the threshold), even if the app has no baseline any more. The
  sensitivity is the most sensitive among the app's funnels with alerts on (normal without funnels); an app whose funnels
  all have alerts off gets no silence alert. Needs a few days of history after setup.
- **Funnel anomaly**: yesterday's step-to-step conversions (by entry day, UTC) against two baselines: the pooled
  conversions of the 14 days before, and those of the same weekday in them (7 and 14 days before yesterday), so a
  weekly pattern (a weekend dip) does not alert. Each step *k* is tested on the installs that reached step *k−1*, with
  a one-sided two-proportion z-test against each baseline (both are samples too). An alert needs both tests at p < 0.01
  and a relative drop at least the sensitivity's against both, at least 100 installs entering step 1 yesterday, at
  least 30 installs at the step before, a 14-day baseline of at least max(300, 5 × yesterday's) installs at the step
  before and a weekday baseline of at least max(30, yesterday's); with smaller baselines the step is skipped. It names
  the step with the largest drop ("Paywall → purchase dropped 34% in Party Games"). Installs entering in the last 3 hours
  of a day (21:00–24:00 UTC) are left out on every day alike: events queued offline on devices arrive late, and the
  check runs at 10:00 UTC. Conversions count within the funnel's window capped at the time since yesterday ended
  (yesterday's installs had no longer), for all periods alike. Drops only, no spikes. The open anomaly of a funnel is
  resolved by a later check that finds none (or that has too few installs to test).
- **Release regression**: app versions first seen (by the step-1 event's app version) within the last 14 days are
  tried newest first, and the first with at least 200 step-1 installs over its window is tested, so a TestFlight / beta
  build with a few testers does not hide the real rollout. It is compared with the most used other version over the
  same days (from the new version's first install, at most 7 days), per step, with a one-sided two-proportion z-test
  (p < 0.01, drop at least the sensitivity's, at least 200 step-1 installs per version and 30 at the step before).
  Conversions count within the funnel's window capped at 24 hours, and only installs that entered at least that long
  ago. One alert per version ("… (2.0.5 vs 2.0.2)"); a later daily check that finds no regression (or no version new
  any more) resolves the funnel's open regression alerts.

Cost: the checks run in a database call of their own on every cron tick (`cronInsights`), at most 10 funnels per tick
(round-robin, settings `funnel_alerts_cursor`) and one budget of at most 40 outbound requests per tick shared by
Analytics Engine SQL API queries (each event step is one query over 15 days of entries, step 1 broken down by app
version; revenue steps are indexed database reads), the APNs pushes of the alerts raised (one per receiving device; a
funnel is only started when there is room for its queries and two alerts' pushes) and digest emails (at most 10 per
tick, never on a tick that checked funnels). Each funnel is checked once a day (`funnels.alerts_checked`); funnels
with alerts off, apps without events for two days, and funnels starting at `first_open` whose app had fewer than 100
installs yesterday and fewer than 400 over 8 days (from the daily digest) cost no query. The hourly silence check reads
the open `events_silent` alerts once and only writes for apps that have one. Without `CF_ACCOUNT_ID` /
`CF_ANALYTICS_TOKEN` / the `EVENTS` binding the funnel checks are skipped.

## Daily digest

Once per workspace and UTC day Revflare computes a digest of yesterday (settings `digest:<workspace>:<day>`, kept 8
days; `worker/lib/digest.ts`) in two passes: right after 00:00 UTC the ledger part (per app revenue, proceeds, new paid
subscriptions, trials and trial conversions from the daily rollups; no Analytics Engine query), then from 00:30 UTC,
with app events, installs (`first_open` events) and paywall views (`paywall_view`) — one Analytics Engine query per
workspace (up to 50 apps), counted against the same per-tick budget — plus the top movers (apps whose revenue or
installs moved most against their 7-day average). All days are UTC days, event metrics included: a device's
"yesterday" in another time zone covers a different 24 hours.

- The 09:00 daily summary push gets one more line from it ("Installs 1.2K (+8%) · trials 46") when the digest of the
  device's yesterday has event metrics. When it has none yet (devices east of UTC: 09:00 at UTC+9 is 00:00 UTC, before
  the event pass; from UTC+10 the day has not even ended in UTC), the line comes from the latest digest with event
  metrics of the 3 days before, labelled with its day ("Oct 21: Installs 1.2K …"). Every device reads the same stored
  digests; a finished UTC day without a digest yet gets its ledger part computed on the spot. Only iOS builds that know
  the line's texts (`pushVersion` ≥ 1) get it; older ones keep the plain summary.
- **Email** (optional): users who turn on *Daily digest email* (web: Settings → Account; `PATCH /me
  { dailyDigestEmail: true }`) get the full digest (HTML with a plain-text part) once a day after 09:00 in the time zone
  of their newest iOS device (UTC without one), after both passes. Only when Email Sending is configured (`EMAIL`
  binding and `EMAIL_FROM`). `digest_mail_done:<day>` stops the day's checks once everyone had theirs.
