# Remote config

Revflare's remote config works like Firebase Remote Config: each app has **parameters** that the app reads at launch
(RevflareKit, `GET /sdk/v1/config`), with a default value and values per **condition** (country, language, app version,
percent rollout, testers...). Changing a value needs no app update. Edit it in the web app (app page → **Remote
config**), with the CLI (`revflare config <app> ...`) or the API (`docs/api.md`, section Remote config).

## Model

```json
{
  "conditions": [
    { "name": "china", "color": "blue", "rules": [{ "type": "country", "values": ["CN", "HK"] }] },
    { "name": "new onboarding 20%", "rules": [{ "type": "app_version", "op": ">=", "value": "2.1" }, { "type": "percent", "from": 0, "to": 20 }] }
  ],
  "parameters": [
    { "key": "onboarding_version", "type": "string", "defaultValue": "v2",
      "conditionalValues": { "china": "v1", "new onboarding 20%": "v3" } },
    { "key": "max_free_accounts", "type": "number", "defaultValue": 1 },
    { "key": "show_discounted_paywall", "type": "boolean", "useInAppDefault": true, "conditionalValues": { "china": true } },
    { "key": "paywall", "type": "json", "defaultValue": { "title": "Go Pro" }, "description": "Paywall texts" }
  ]
}
```

- **Parameters**: `key` (letters, digits, `_ . -`, at most 128), `type` `string` | `number` | `boolean` | `json`, a typed
  `defaultValue` or `useInAppDefault: true`, and `conditionalValues` (condition name → typed value, or
  `{ "useInAppDefault": true }`). "In-app default" means the key is left out of the device's values, so the app's own
  default applies (as in Firebase). JSON values can be any JSON (objects, arrays...), at most 32 KB each.
- **Conditions** are ordered: for each parameter, the **first** condition in the list that matches the device **and**
  has a value for that parameter wins; otherwise the default applies. Reorder conditions to change priorities.
- A condition matches when **all** its rules match (AND). No rules: always matches. Conditions imported from Firebase
  with targeting Revflare cannot evaluate are kept with `unsupported: true` and their original `expression`: they never
  match until you replace them with rules.
- Limits per app: 300 parameters, 50 conditions, 20 rules per condition, 512 KB for the whole config.

## Rules

| Rule | Matches when |
| --- | --- |
| `country in [CN, HK]` | the device's country: the App Store **storefront** RevflareKit sends, else the country of the request (Cloudflare) |
| `ip_country in [...]` | the country of the request (where the device is now, VPNs included) |
| `storefront in [...]` | the storefront RevflareKit sent (no fallback) |
| `language in [zh, tr]` | the language of the device locale (`zh` matches `zh_CN`, `zh-Hans_TW`); a value with a region (`en_US`) matches that locale |
| `locale in [zh_CN]` | the device locale (`zh-Hans_CN` matches `zh_CN` too; `-` and `_` are the same, case-insensitive) |
| `app_version >= 2.1` | semantic comparison, also `>`, `<=`, `<`, `==`, `!=`; numeric per part (2.10 > 2.9; 2.1 == 2.1.0). Also `app_build`, `os_version`, `sdk_version` (RevflareKit's version). A device that did not send the value never matches |
| `percent from A to B` | the install's bucket is in `[A, B)` (see below) |
| `install_id in [...]` | testers: RevflareKit install ids (the app shows its id with `Revflare.installId`) |
| `source in [apple_ads, organic, unknown]` | how the install was acquired, from RevflareKit's attribution report (see below) |
| `apple_ads_campaign in [...]` | the Apple Ads campaign id of an attributed install (digits, up to 20); also `apple_ads_ad_group`, `apple_ads_keyword` |
| `environment in [production, sandbox, xcode]` | the build: `production` (App Store), `sandbox` (TestFlight, development builds), `xcode` (StoreKit configuration file). Devices that send none (older RevflareKit) are `production` |

### Acquisition source

`POST /sdk/v1/report` answers each install's source: `apple_ads` (Apple attributed the install to Apple Ads, with the
campaign, ad group and keyword ids), `organic` (Apple did not attribute it, or no attribution could be had: no token,
failed, expired) or `unknown` (the token is waiting for Apple's answer). It is the same rule LTV uses for its
`source` dimension. RevflareKit keeps the last answer and sends it with every config fetch (`source`, `campaign`,
`adGroup`, `keyword`).

On the **first launch** the config is fetched before the report has been answered: the device is `unknown` (or sends no
source at all, which matches no `source` rule). Give `source in [unknown]` the value you want while it is not known
yet (e.g. the soft paywall), or let it fall to the default. Once Apple answers (seconds to a few minutes; the cron
retries pending tokens), the next fetch carries the source; the device's response, and so its `version` / ETag,
changes only if a rule it matches changes.

Values the device sends are checked like rule values: an unknown `source`, an id that is not digits or an unknown
`environment` is ignored (no source, no id, production). Experiments target acquisition through their targeting
condition (e.g. an experiment on `paywall` targeted at a `source in [apple_ads]` condition).

### Country source

The App Store storefront is the country of the user's App Store account: it is what prices and availability follow,
and it does not change with travel or VPNs. RevflareKit sends it (`storefront`, ISO alpha-2); when it is missing (the
SDK could not read it yet), `country` rules use the country Cloudflare saw for the request. Use `ip_country` to target
where the device is right now, `storefront` to require the storefront.

### Percent rollouts

Each install gets a stable bucket per seed: the first 4 bytes of `sha256(lowercase installId + seed)` scaled to
`[0, 100)`. The seed is the rule's `seed`, else the condition's name. So:

- the same install stays in or out of a rollout across launches (no flicker), and growing `to` from 20 to 50 keeps the
  first 20% in;
- two conditions with the **same seed** and ranges `0–50` / `50–100` split installs into two disjoint halves (A/B);
  different seeds give independent splits;
- renaming a condition without an explicit seed reshuffles its buckets: set `seed` to keep them.

Without an install id (old SDK versions) percent rules never match.

## Evaluation and the SDK response

`GET /sdk/v1/config?installId=…&appVersion=2.1&appBuild=12&osVersion=18.1&locale=zh_CN&storefront=CN&sdk=1.5.0&source=apple_ads&campaign=123&adGroup=456&keyword=789&environment=production`
(header `X-Revflare-Key`) answers:

```json
{ "version": "a1b2c3d4e5f6", "values": { "onboarding_version": "v1", "max_free_accounts": 1, "show_discounted_paywall": true, "paywall": { "title": "Go Pro" } },
  "conditions": ["china"], "country": "CN" }
```

`values` has the resolved value of every parameter except those resolving to the in-app default; `conditions` lists the
conditions the device matched, in priority order. `version` (also the `ETag`) is a hash of this response, so it changes
only when what **this** device gets changes: editing China's value does not invalidate the cache of devices elsewhere.
The app revalidates with `If-None-Match` and gets a `304` without a body when nothing changed for it.

The web app's **Preview as** (and `revflare config <app> eval`, MCP `evaluate_remote_config`, `POST
/apps/:id/config/evaluate`) runs the same evaluation for a device you describe and shows which condition each value
came from.

## Caching and how fast changes reach devices

- The config is one database row per app. The SDK endpoint keeps the app's compiled config in the Worker isolate's
  memory and in Cloudflare's Cache API for 60 s and evaluates the device's conditions in the Worker: launches cost no
  database read (at most one small indexed read per isolate and minute, unknown keys included).
- A change made through the API or the web app clears this data center's cache at once; other data centers and isolates
  pick it up within 60 s. Responses carry `Cache-Control: private, max-age=60`.
- RevflareKit fetches at launch and throttles by its own minimum fetch interval, so a change reaches a device within
  **about a minute plus the app's fetch interval** (or at the next launch).

## Importing from Firebase

Export the template with the Firebase CLI (`firebase remoteconfig:get -o template.json`) or the REST API, then import it
from the web app (**Import from Firebase**: paste or upload, preview, apply) or the CLI:

```sh
revflare config com.example.app import-firebase template.json --dry-run   # what would be imported, warnings
revflare config com.example.app import-firebase template.json             # replace the config
revflare config com.example.app import-firebase template.json --merge     # merge parameters by key, conditions by name
```

Conversion:

- `parameterGroups` are flattened into parameters (descriptions kept).
- `valueType` `STRING` / `NUMBER` / `BOOLEAN` / `JSON` → `string` / `number` / `boolean` / `json` (Firebase sends every
  value as a string: `"1"` becomes `1`, `"false"` becomes `false`, JSON strings are parsed). If a value does not parse
  for its type, the parameter is imported as a string (warning). A missing default or `useInAppDefault` → in-app default.
  Personalization and rollout values are not supported: the in-app default applies (warning).
- Conditions keep their order (priority), name and `tagColor`; names with other characters than letters, digits,
  space and `_ . -` (e.g. `20% rollout`) are renamed (`20_ rollout`, warning) and their values follow. Supported terms, combined with `&&`:
  `device.country in ['CN', 'HK']`, `device.language in ['zh', 'en-US']`, `app.version.>=(['2.1.0'])` and the other
  operators (`>`, `<=`, `<`, `==`, `!=`, `exactlyMatches` with one value), `app.build...` the same, `percent <= 20`,
  `percent > 50`, `percent between 10 and 20`, `percent('seed') ...`, `device.os == 'ios'` and `app.id == '…:ios:…'`
  (always true for an iOS app), `true`, `false`.
- Anything else (user properties, audiences, Firebase installation ids, dates, `||`, `!`, version regexes, other
  platforms) makes the condition **unsupported**: it is imported with its original expression and never matches, and
  the import lists it in `warnings` instead of failing. Edit it in the web app to replace it with rules.
- Percent buckets differ from Firebase's (different hash and install ids): a rollout's members change once when you
  move from Firebase to Revflare.

## Export, apply and single edits

`revflare config <app> export > config.json` prints the whole config in the shape `apply` and `PUT /apps/:id/config`
take; `apply` replaces it atomically (invalid configs are refused with the reason and change nothing). For one value:
`revflare config <app> set onboarding_version v1 --condition china` (reads the config, changes the value, writes the
whole config back). The web app's **Export JSON** downloads the same file.
