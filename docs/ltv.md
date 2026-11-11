# LTV by acquisition source

What an install is worth, per source: Apple Ads or organic, Apple Ads campaign, ad group or keyword, or country. Web:
**LTV** page; API: `GET /api/v1/ltv` and `GET /api/v1/ltv/summary` ([api.md](api.md)); CLI: `revflare ltv`; MCP:
`get_ltv`. Computed at read time (`worker/lib/ltv.ts`): one aggregation per workspace, app selection and range,
grouped by install day and every dimension at once, kept for the UTC day; every grouping, cohort size and the summary
come from it. LTV is not a live metric: sales and installs of today show from the next UTC day.

## Installs

- An **install** is a RevflareKit install (one keychain `installId`) that reported to `/sdk/v1/report`. Apps without
  RevflareKit, and app versions before it, have no installs.
- The **install time** is the time RevflareKit persisted on the device at its first launch (`installedAt`, RevflareKit
  1.5.1 and later; kept when at most 30 days before the first report), else the install's first report
  (`attributions.created_at`). Cohorts are **UTC days** (Apple Ads reports use the campaign's time zone).
- **Pre-existing users**: an install whose linked purchases all started more than 48 hours before its install time (a
  user who had the app before RevflareKit was added, or a reinstall) is not counted in `installs` or in any value;
  `coverage.preexisting` reports how many there are. Installs without any purchase always count.
- **Cohort**: installs of the same day, week (Monday to Sunday, the default) or month.
- **Source**: `apple_ads` when Apple attributed the install to Apple Ads (AdServices), else `organic` (including installs
  whose token could not be resolved). Campaign, ad group and keyword exist only for Apple Ads installs; organic installs
  are one `organic` group there. **Country**: Apple's country for Apple Ads installs, else the country the install first
  reported from (Cloudflare), else `unknown`.
- **Test data** is left out: installs that reported from a `sandbox` (TestFlight, development) or `xcode`
  (StoreKit configuration) build and never from a `production` one (an install moves to production once, never back),
  and the app's test devices (`revflare apps <app> test-devices`). Installs reported
  before RevflareKit sent its environment count as production. Xcode installs link no purchases and are never sent to
  Apple. The same applies to attributed revenue (`/revenue/attributed`) and its coverage.

## What counts

- Revenue of an install = the App Store transactions it owns: its original transaction ids (`install_links`, from
  `Transaction.all` or `appAccountToken = installId`), all their renewals and upgrades. Production only.
- **Revenue** is the customer price; **proceeds** what Apple pays out (after commission and taxes, Apple's figure once
  reconciled). Both in USD at the transaction's day rate, shown in the chosen currency at today's rate.
- **Refunds** are excluded: a refunded transaction counts 0, a prorated refund (Apple's `revocationPercentage`) counts
  the kept share, whenever the refund happened. Trials count 0 and as `trials`.
- **Payers**: installs with at least one paid transaction not fully refunded.
- Subscriptions and purchases that started more than **48 hours** before the install time belong to an earlier install
  (reinstall, new device) and are not counted, renewals included. The grace covers a first report that arrives late
  (offline first launch) from an SDK that does not send its install time.

## Horizons

- **D0** = the first 24 hours after the install, **D7**, **D30**, **D90**, **D180** = the first 7, 30, 90, 180 days
  (`purchased_at < install time + N days`), **to date** = everything until now. Values are per install: cohort total /
  cohort installs (installs that never paid included).
- **Immature**: a horizon the cohort has not reached for all its installs (cohort end + N days after today) has no value
  (`immature: true`, grey in the web table). The current week is immature everywhere but to date.
- **Summary** (`/ltv/summary`, `--summary`): per group, pooled over the install days old enough for each horizon; each
  horizon reports how many installs it is based on. D90 needs installs at least 91 days old: use a range of 180 days or
  more for it.
- Cohorts go back about 13 months: `from` is at most 396 days back, then moves to the start of its week or month.

## Coverage

`coverage.share` = the apps' customers whose first payment falls in the range (or later) that are linked to a reporting
install by a purchase that counts (one that passes the 48-hour rule), out of all of them. Below 100 %, revenue is missing from the installs: purchases made in app versions without
RevflareKit, on other devices, or never reported by the SDK. Read the values as a floor when coverage is low, and compare
sources with the same coverage. `installs` / `attributed` are the reporting installs in the range (pre-existing ones excluded) and how
many Apple attributed to Apple Ads; `preexisting` the installs left out.
