#!/bin/zsh
# Creates the App Store Connect app record for Revflare (once, by hand). Apple only allows creating apps through a
# web session, so run it yourself in a terminal: `asc web apps create` asks for the Apple ID password (unless it is
# cached) and the two-factor code. Everything else (scripts/release.sh) uses the asc API key.
#
#   scripts/create-app-record.sh                      # bundle id and Apple ID from Local.xcconfig
#   ASC_WEB_APPLE_ID=me@example.com scripts/create-app-record.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# Build settings from Config.xcconfig and the git-ignored Local.xcconfig (later lines win); env vars override.
setting() { cat Config.xcconfig Local.xcconfig 2>/dev/null | sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" | tail -n 1 | sed 's/[[:space:]]*$//'; }
BUNDLE_ID=${REVFLARE_BUNDLE_ID:-$(setting REVFLARE_BUNDLE_ID)}
APPLE_ID=${ASC_WEB_APPLE_ID:-$(setting ASC_WEB_APPLE_ID)}
[[ -n "$APPLE_ID" ]] || { echo "Set ASC_WEB_APPLE_ID (env or Local.xcconfig) to your Apple ID." >&2; exit 1; }
[[ "$BUNDLE_ID" != com.example.* ]] || { echo "Set REVFLARE_BUNDLE_ID in Local.xcconfig to your own bundle id." >&2; exit 1; }

app_id() { asc apps list --bundle-id "$BUNDLE_ID" --output json | jq -r '.data[0].id // empty'; }

if [[ -n "$(app_id)" ]]; then
  echo "App Store Connect already has $BUNDLE_ID ($(app_id)); nothing to do."
  exit 0
fi

create() {
  asc web apps create --name "$1" --bundle-id "$BUNDLE_ID" --sku revflare --primary-locale en-US --platform IOS \
    --apple-id "$APPLE_ID" --if-exists skip --auto-rename=false
}
# The App Store name must be unique: fall back to a longer one if "Revflare" is taken.
create "Revflare" || create "Revflare: Revenue Dashboard"

ID=$(app_id)
[[ -n "$ID" ]] || { echo "The app record was not found through the API yet; check App Store Connect." >&2; exit 1; }
echo "Created $BUNDLE_ID ($ID). Next: scripts/release.sh"
