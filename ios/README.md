# Revflare for iOS

Mobile revenue dashboard for a Revflare server (SwiftUI, Swift Charts, Liquid Glass; iOS 26+). Talks to the REST
API v1 (`docs/api.md`); the models in `Revflare/Core/Models.swift` mirror `shared/types.ts`.

## Build

The Xcode project is generated (and git-ignored):

```sh
cd ios
cp Local.example.xcconfig Local.xcconfig   # once: your bundle id and team (git-ignored)
xcodegen generate          # after adding/removing files or changing project.yml / the xcconfig files
open Revflare.xcodeproj
```

A fresh clone needs only Xcode 26+ and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).

### Your bundle id and team

`Config.xcconfig` (tracked) holds neutral defaults: bundle id `com.example.revflare`, no team (simulator builds only).
Put your own values in the git-ignored `Local.xcconfig`, which `Config.xcconfig` includes:

| Setting | What |
| --- | --- |
| `REVFLARE_BUNDLE_ID` | The app's bundle id. The widget extension is `<id>.widgets`, the shared keychain group `<team>.<id>.shared`, widget kinds `<id>.today`... Set the server's `APNS_TOPIC` to the same value. |
| `DEVELOPMENT_TEAM` | Your Apple Developer team id. |
| `REVFLARE_APP_PROFILE`, `REVFLARE_WIDGETS_PROFILE` | Names of the App Store provisioning profiles for Release builds. |
| `ASC_WEB_APPLE_ID` | Your Apple ID, only for `scripts/create-app-record.sh`. |

Every value can also be given as an environment variable to the scripts (`REVFLARE_BUNDLE_ID=... scripts/release.sh`).

Command line (simulator):

```sh
xcodebuild -project Revflare.xcodeproj -scheme Revflare \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath build/DerivedData build
```

## Layout

| Path | What |
| --- | --- |
| `Revflare/Core/` | Compiled into the app **and** the widget extension: API client, models, formatting, keychain + shared settings, response cache, Live Activity attributes, widget snapshot, shared App Intents (app entity, widget configuration, control/interactive intents). |
| `Revflare/App/` | App entry, `AppModel` (session, routing, deep links), push registration, Live Activity manager. |
| `Revflare/Features/` | Overview, Charts, Feed (+ customer/transaction, source filter), Apps (+ app detail, Apple Ads attributed revenue), Goals (list, detail, editor), Settings (+ notifications), onboarding with QR scanner. |
| `Revflare/Intents/` | Siri / Shortcuts ("How much did I make today?", MRR with an optional app). |
| `Revflare/Resources/` | Assets, `cash.caf`, `en.lproj` / `tr.lproj` (`Localizable.strings` incl. push `loc-key`s, `InfoPlist.strings`, `AppShortcuts.strings`). |
| `RevflareWidgets/` | Home/Lock Screen/StandBy widgets, interactive "App spotlight", Goals, Live Activity UI, Control Center control, WidgetKit push handler. |
| `scripts/` | `make-cash-sound.py`, `create-app-record.sh`, `release.sh`. |

The app icon (`AppIcon.png`) is `docs/brand/revflare-app-icon.svg` rendered at 1024×1024; the in-app mark (`BrandGlyph`) and `public/favicon.svg` use the same glyph.

Sharing between the app and the widget extension goes through the keychain access group
`<team>.<bundle id>.shared` (device token, server, workspace, display settings; the app reads it from the
`RevflareKeychainGroup` Info.plist key). Every provisioning profile of the team allows it, so no App Group has to be
registered. Each process keeps its own response cache.

## Sign-in

- QR code / link: `revflare://pair?server=<url-encoded>&code=<CODE>` (web app → Settings → iOS app). Opening the link
  also signs in.
- Email + password against your server (there is no default server: enter its address, e.g.
  `https://revflare.example.com`; plain `http://` only on the local network).

## Signing a computer in

The signed-in app can sign a browser in (`docs/app-login-spec.md`, `/api/v1/auth/app-login`): on the web sign-in page
choose **Sign in with the iPhone app**, then scan the QR code in Settings → **Sign in on a computer** (the same scanner
also takes pairing codes) or with the Camera app (`revflare://web-login?s=<server>&r=<id>&k=<nonce>` opens the app).
Codes for a server other than the configured one are refused. With push, the browser sends a request instead
(`WEB_LOGIN` category, `{ type: "web_login", id }`) and the app shows three numbers: pick the one on the computer's
screen. `WebLoginSheet` (`Features/Settings/WebLoginView.swift`) shows the browser, location, IP and time, and approves
with Face ID / Touch ID or the passcode (LocalAuthentication).

## Deep links

`revflare://overview`, `charts[/metric]`, `feed`, `apps`, `app/<id>`, `customer/<id>`, `transaction/<transactionId>`,
`settings`, `notifications`, `goals` (`goals/<id>`: one goal), `at-risk`, `forecast`, `pair?...`, `web-login?...`.

Debug builds accept `-RFOpenURL <url>` (open a deep link at launch), `-RFSkipPushPrompt YES` and
`-RFStartLiveActivity YES` for simulator automation, e.g.
`xcrun simctl launch booted com.example.revflare -RFOpenURL revflare://feed -RFSkipPushPrompt YES`.

## Push

`POST /api/v1/devices` with the APNs token (`sandbox` in Debug, `production` in Release builds), preferences via
`PATCH /api/v1/devices/:id`. Alert texts are localized on the device with the `PUSH_*` keys in
`Resources/*.lproj/Localizable.strings`; `cash.caf` is the cash register sound (`scripts/make-cash-sound.py`, then
`afconvert -f caff -d LEI16@44100 -c 1 cash.wav Revflare/Resources/cash.caf`). The Live Activity push token goes to
`PATCH /devices/:id { activityToken }`.

The WidgetKit push token (iOS 26, `RevflareWidgetPushHandler`) goes to `PATCH /devices/:id { widgetToken }` (`null`
when the system revokes it); the server sends `apns-push-type: widgets` refreshes only to that token.
`Core/WidgetPushToken.swift` reports it from the widget extension when it changes and from the app on launch, on
foreground and after the device registration (`WidgetCenter.currentPushInfo`); it remembers the last reported
`deviceId:token`, so it does not send the same value twice.

## Server limits

On the Cloudflare Workers Free plan the server can run out of its daily database budget. It then answers
`503 { code: "quota" }` (`APIError.quota`) until 00:00 UTC. `AppModel.handle` turns that into `quotaResetAt`. Screens
keep their cached responses (with the offline icon) and show one `QuotaBanner` under the navigation bar with the
reset time and a countdown, instead of error banners. Everything reloads at the reset or after the next successful
request. Widgets keep their cached snapshot and do not refresh again until just after the reset.
`429 { code: "budget" }` (imports) shows the server's message.

## Release (TestFlight)

1. **App record (once, by hand).** Apple creates new apps only through a web session, so run
   `scripts/create-app-record.sh` yourself in a terminal. It skips if your bundle id already exists. Otherwise it
   runs `asc web apps create` (name "Revflare", falling back to "Revflare: Revenue Dashboard" if the name is taken;
   SKU `revflare`; en-US), which asks for the Apple ID password and the **two-factor code**
   (`ASC_WEB_APPLE_ID` in `Local.xcconfig` or the environment).
2. **Each build.** `scripts/release.sh` uses the asc API key (`asc auth login`) and stops early if the app record is
   missing. It then archives (Release, `generic/platform=iOS`), exports (it writes `build/ExportOptions.plist` from `Local.xcconfig`), uploads with
   `asc builds upload --wait`, and adds the build to the app's internal TestFlight group (creates "Internal" if there
   is none). The build number is the latest uploaded one + 1, or `BUILD=n scripts/release.sh`. It never changes the
   app's versions or metadata in App Store Connect. Needs `xcodegen`, `jq` and `asc`.

Signing: Debug uses automatic signing; Release uses the App Store profiles named in `REVFLARE_APP_PROFILE` and
`REVFLARE_WIDGETS_PROFILE` (created with `asc profiles create --profile-type IOS_APP_STORE`, certificate
`iPhone Distribution`). Both bundle ids (`<id>` and `<id>.widgets`) need Push Notifications.

```sh
scripts/create-app-record.sh   # once, by you: Apple web session (asks for the 2FA code)
scripts/release.sh             # archive, export, upload, wait for processing, add to the internal TestFlight group
```

Export compliance: `ITSAppUsesNonExemptEncryption = NO` is in the Info.plist.

Screenshots go to `ios/screenshots/` (git-ignored: they show real revenue).
