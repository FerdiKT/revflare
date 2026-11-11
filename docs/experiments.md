# Experiments (A/B tests on remote config)

An experiment gives each of its variants its own values for some [remote config](remote-config.md) parameters, assigns
devices to the variants in a stable way and compares what the exposed installs did afterwards: trials, paid
conversions, revenue per install. Code: `worker/lib/experiments.ts` (model, lifecycle, results, cron),
`worker/lib/experiment-stats.ts` (statistics), assignment in `worker/lib/remote-config.ts`. REST:
[api.md](api.md#experiments-ab-tests-on-remote-config).

## Model

- **Parameters** (`keys`, 1 to 10): existing remote config parameters. A parameter is in at most one active (running or
  stopped) experiment at a time. While an experiment is active its parameters cannot be removed or change type, and its
  targeting condition cannot be removed or renamed (the config change is refused with the reason).
- **Variants** (2 to 5): ids `a`, `b`, `c`… in order; `a` is the control. Each has a name, a weight (all weights sum to
  100; left out on every variant: an even split) and typed values for the keys. The control may leave keys out: its
  devices keep the value they would get anyway (default or condition). Other variants set every key.
- **Targeting** (optional): the name of a remote config condition. Only devices matching it enroll; the others get the
  normal values and no experiment.
- **Traffic** (default 100): the percent of matching devices enrolled.
- **Primary metric**: `trial_started`, `paid` (default) or `revenue_per_install`. It decides the guardrail on
  conversions and which probability the confident-result alert looks at.
- **Lifecycle**: `draft` (editable) → `running` → `stopped` → `rolled_out`, or `archived` (from draft, running or
  stopped). Only drafts can be edited; running and stopped experiments cannot be deleted (archive them first). A running
  experiment is stopped automatically 90 days after its start (`endsAt`).

## Assignment

The app's running and stopped experiments are compiled into its remote config payload (`remote_configs.sdk_json`), so
`GET /sdk/v1/config` assigns devices in the Worker with no database work per request (the payload is cached like the
remote config itself, see remote-config.md). For each experiment, in start order:

1. No `installId`: not enrolled. A targeting condition the device does not match: not enrolled.
2. `b = percentBucket(installId, experimentId)`: the first 4 bytes of sha256(lowercase install id + experiment id),
   scaled to [0, 100) — the same function as percent rules, seeded by the experiment id, so experiments and percent
   conditions bucket independently.
3. `b >= traffic`: not enrolled. Else `u = b / traffic × 100` walks the cumulative weights: the first variant whose
   cumulative weight is above `u`.

An enrolled device gets its variant's values for the experiment's keys (over conditions and defaults) and the response
lists its assignments:

```json
{ "version": "…", "values": { "paywall_variant": "bold" }, "conditions": [], "country": "US",
  "experiments": [ { "id": "exp_paywall1", "variant": "b", "keys": ["paywall_variant"] } ] }
```

`experiments` is left out when the device is in no experiment (its response and version are then exactly what they
were without experiments). The assignment depends only on the install id, the experiment id, its traffic and weights
(fixed once started), so it never changes while the experiment is active. **Stopping does not flip devices back**: a
stopped experiment keeps serving its assignments until it is rolled out or archived. `POST /apps/:id/config/evaluate`
("Preview as" with an install id) shows the variant and which values come from it.

## Exposure

RevflareKit sends the event `experiment_exposure` when the app reads a parameter of an experiment it is enrolled in,
with props `{ "experiment": "<id>", "variant": "<id>:<variant>" }`, whatever the value's source: the control usually
keeps the app's default (the server sends no value for its keys) and must be exposed like the other variants, or the
split would look skewed (sample-ratio mismatch). `variant` is a promoted property (column `blob17`), so per-variant
queries are an equality on one column. An exposed install is one that sent this event for the variant, however often;
its first exposure is the earliest **event time** (`double1`, the device clock, checked against the server's at ingest)
within the window (5 minutes of slack before the start for device clocks), from events received up to 8 days after
the window (the SDK's offline queue).

## Daily snapshot

Analytics Engine keeps events 3 months. Once a day from 02:00 UTC (the insights cron, within its tick budget of
outbound requests) each running experiment gets one query: distinct exposed installs per variant and UTC day of the
last 3 days, upserted into `experiment_daily` (only changed rows are written). When Analytics Engine sampled a day's
events, the distinct-install count is scaled by the sample interval (stored in `sample_interval`; the results then say
the daily counts are approximate). An experiment is marked as snapshotted for the day even when its query failed: each
snapshot re-queries the last 3 days, so the next day's run fills the gap, and a failing query does not eat every tick's
budget. The results page draws it as the daily
exposure chart; it is also the fallback for exposures when Analytics Engine has no install lists (an experiment that
started more than 3 months ago, or event queries not configured): the sum of daily counts, which counts an install
once per day it was exposed (noted in the results).

## Metrics

Window: from the start to the stop (or now). Per variant:

- **Exposed**: unique installs in the window (one Analytics Engine query per variant: install and first exposure time,
  at most 20,000 installs per experiment spread evenly over the variants, the first by time; more, or sampled data,
  marks the results `approximate` with a note). `experiment_exposure` is a [key event](funnels.md#exact-key-events):
  when the stored key events cover the whole window (the experiment started on or after the app's "exact since" day,
  no capped day), the exposed installs come from the database instead, exactly (no sampling, one read).
- **Trials**: exposed installs with a free trial that started at or after their first exposure (5 minutes of grace for
  device clocks).
- **Paid**: exposed installs whose **first paid transaction** happened at or after their first exposure, not fully
  refunded: a subscription's first paid period (`kind` `new`, or `conversion` from a trial) or a non-subscription
  purchase (`one_time`: lifetime unlocks and consumables count as a conversion too, once per install). The
  subscription (or purchase) must also have **begun** after the exposure (its original purchase date): a trial started
  before the exposure that converts later is not counted, and renewals are never conversions.
- **Revenue / proceeds**: every transaction (renewals included) of the subscriptions and purchases that began at or
  after the install's first exposure, up to the window's end, refunds subtracted (prorated refunds count their kept
  share), in the workspace currency; renewals of a subscription bought before the exposure (an existing subscriber who
  opened the app) never count. **Per exposed install** = revenue / exposed.

Purchases come from Revflare's own sales: the exposed installs are looked up in `install_links` (RevflareKit links
purchases to installs with `appAccountToken`, or the SDK report), then their own transactions — Production only, at
most 90 ids per statement, inside the database object. The cost is bounded by the number of exposed installs and their
transactions (`test/workers/budget.test.ts`), never a scan of the app's transactions.

## Statistics

Trial and paid rates have Beta(1 + x, 1 + n − x) posteriors (uniform prior; x conversions of n exposed installs). A
Monte Carlo of 20,000 draws, seeded by the experiment id (the same data gives the same numbers), gives:

- **P(best)**: the share of draws in which a variant has the highest rate.
- **Lift vs control**: (p_variant − p_control) / p_control per draw: its mean and the 2.5 % / 97.5 % quantiles (95 %
  credible interval).

Revenue per install is a point estimate only (no probability).

## Guardrails

Results say **not enough data** (and the reasons) until the experiment has run at least 7 days, every variant has at
least 100 exposed installs and the primary metric has at least 10 conversions in total (paid conversions for
`revenue_per_install`). There is no peeking machinery: P(best) is a description of the data so far, read it once the
guardrails are met and decide on a fixed horizon rather than stopping at the first good-looking day.

A running experiment whose primary metric (`trial_started` or `paid`) reaches P(best) ≥ 95 % with the guardrails met
raises one alert of kind `experiment_result` (no push yet); a later computation that is no longer confident resolves it.

## Results caching

Results are stored on the experiment row and served from it; computing them costs one Analytics Engine query per
variant and database reads per exposed install, so they are not computed per request:

- **The cron** (insights tick, within its budget of outbound requests, at most 2 experiments a tick) recomputes each
  running experiment's results when they are older than 6 hours, and computes the final results of stopped, rolled out
  or archived experiments nobody opened, while Analytics Engine still has their exposures.
- **`GET …/results`** computes only when nothing is stored yet, or once more after the stop (that computation is final:
  `frozen`, the window ends at the stop, kept for good).
- **`POST …/results/refresh`** recomputes now, at most once an hour per experiment (`429` with `retryAfter` before).

Every computation runs inside the database object (the Analytics Engine queries too, so the install lists never cross
an RPC boundary) and is metered against the daily background budget (`worker/lib/budget.ts`, like backfills): once it
is used up, reads get the stored results with a note (or zeros and the reason when none are stored) and refreshes a
`429`, until 00:00 UTC.

## Rollout

`POST …/rollout { "variant": "b" }` (running or stopped): the variant's values become the parameters' **defaults**
(conditional values stay; a control rollout keeps the current defaults for keys it does not set), the experiment leaves
the payload and every device gets the new defaults. `archive` removes the experiment without changing the config.
