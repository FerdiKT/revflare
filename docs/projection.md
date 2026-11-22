# Revenue projection

Expected proceeds and MRR for the next 30 / 90 / 365 days, per app or for every app together: web app **Projection**
(`/forecast`), `GET /api/v1/projection` ([api.md](api.md)), `revflare projection`, MCP `get_projection`. Code: the model
in `worker/lib/projection-model.ts` (pure, unit tested in `test/projection.test.ts`), loading and serving in
`worker/lib/projection.ts`.

Money is **proceeds** (what the developer receives: after refunds and the store's commission) in the workspace currency,
unless a field says gross. `/forecast` (renewals due × renewal rate per period, the overview's `forecast30`) stays as the
quick estimate.

## Model

1. **Subscriptions as of a day.** Every auto-renewable subscription is rebuilt from its Production transactions. The
   stage of its current transaction says what its next payment is: `trial` (trial → paid), `intro` (full price after a
   paid introductory offer), `r1` / `r2` / `r3` (the 1st, 2nd, 3rd-and-later renewal: the number of paid periods so
   far). Live states come from `subscriptions`: expired / revoked / refunded ones are left out; **auto-renew off**,
   **billing retry** and **grace period** get a fixed weight for their next payment (5 %, 25 %, 60 %: assumptions, shown
   in the response); the other subscriptions of the same segment get a raised rate (at most 95 %) so the segment's
   expected next payments still match its measured rate (the measured rate includes the people who turned auto-renew
   off).
2. **Renewal rates** per app × billing period × stage, measured on periods that ended in the lookback (90 days for
   weekly, 180 for monthly, 400 for longer periods; the last 3 days are left out: billing retry, late notifications) —
   did the same subscription pay again? Refunded, revoked and upgraded periods are not counted. Each rate is a Beta
   posterior shrunk towards the **portfolio** (all apps of the workspace, same period and stage), itself shrunk towards
   the stage over every period, then a fixed default (trial 30 %, intro 50 %, 1st 55 %, 2nd 70 %, 3rd+ 80 %). A parent
   never lends more precision than it has evidence (at most 30 pseudo-observations, and no more than the parent
   observed; the stage over every period counts as 4), so a segment with no history gets a wide interval, not a
   made-up precise rate. Segments with fewer than **30** observed renewals are marked `lowData` (with their `source`:
   `app`, `portfolio` or `default`).
3. **Walk.** Each subscription is walked over the horizon: payment *j* happens at its renewal date (current expiry +
   *j* billing periods) with the chained probability of every payment before it. Its amount is the product's **full
   price in the buyer's currency at today's exchange rate** (the last full-price transaction of that product and
   currency, else its last USD price), × (1 − the app's **refund share**: refunded gross / gross of the last 180 days'
   paid transactions), × the app's **proceeds share**: measured proceeds / gross in the first year of paid service, and
   after a year (Apple's commission drops from 30 % to 15 %: measured with 30+ such transactions, else derived from the
   first-year share; an app already at 15 % keeps it). MRR: the subscription's monthly price × its probability to be
   still paying, day by day (trials count 0).
4. **New subscribers** (`withNew` only): the starts of the last 28 days per app, product, start kind (trial, intro,
   paid at once) and currency, walked the same way from their start (a trial converts at its app's measured trial rate
   after its average length), spread as `starts / 28` a day. **One-time purchases** (lifetimes, passes, consumables):
   the last 28 days' daily average of proceeds, refunds subtracted. They are separate lines (`components`,
   `newSubscribers`, `oneTime`); `existing` is today's subscriptions only.
5. **Bands.** 300 seeded draws of every rate from its posterior, and of the new-start and one-time counts (Gamma): the
   5th and 95th percentiles per day, per week and of the cumulative totals (`low`, `high`; `expected` uses the
   posterior means). They cover the uncertainty of the measured rates and volumes only — not seasonality, price changes,
   launches or a change in acquisition — which is what the backtest is for.

## Backtest

The same model is run **as of 30 and 60 days ago** (only transactions bought and refunds known by then; every
subscription counts as renewing, as auto-renew history is not kept) and its prediction for the days until today is
compared with the proceeds that really came in (refunds as known today): `existing` against the payments of the
subscriptions that were active then, `withNew` against everything. `error` = (predicted − actual) / actual, `inBand`
whether the actual fell inside the band; `backtestError` is the mean absolute error, shown next to the projection. A
backtest needs 30 days of history before its start. Small apps have large errors (a few sales a week, launches): the
web app marks the projection as rough above 15 %.

## Cost and caching

One computation reads the workspace's Production transactions of the last ~2 years (at most 500,000; more is noted)
and its live subscriptions, inside the database object, and runs the model three times (today and two backtests). It
is computed at most **once per UTC day and scope** (workspace or app set, currency) and kept in the database object's
memory, so the page, the CLI and the overview line share it. Not recurring work: nothing runs until someone asks.

## Overview line

`GET /projection/summary` → `{ next30, next30Band, next30Previous, next30Change, mrrNow, backtestError, currency,
generatedAt }`: the expected proceeds of the next 30 days with new subscribers and one-time purchases, and its change
against the value computed the day before (one value a day per scope is kept in `settings`, the last 14 days;
`next30Previous` / `next30Change` are `null` on the first day). A daily summary can print it as one line, e.g. "Next 30
days: $7,015 expected ($6,667 – $7,374), +$120 since yesterday".
