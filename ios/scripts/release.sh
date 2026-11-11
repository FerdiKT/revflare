#!/bin/zsh
# Archives Revflare (Release), exports it for App Store Connect, uploads it with `asc`, waits for processing and adds
# it to the internal TestFlight group (the first internal group, or "Internal", created if missing).
#
#   scripts/release.sh            # build number = latest uploaded build + 1 (1 for the first upload)
#   BUILD=7 scripts/release.sh    # explicit build number (CFBundleVersion)
#
# Needs: xcodegen, jq, the asc CLI authenticated with an API key (`asc auth login`), the "iPhone Distribution"
# identity, Local.xcconfig with your bundle id, team and the names of the two App Store profiles (app and widgets),
# and the App Store Connect app record (created once by hand with scripts/create-app-record.sh: it needs a 2FA web
# session).
set -euo pipefail
cd "$(dirname "$0")/.."

# Build settings from Config.xcconfig and the git-ignored Local.xcconfig (later lines win); env vars override.
setting() { cat Config.xcconfig Local.xcconfig 2>/dev/null | sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" | tail -n 1 | sed 's/[[:space:]]*$//'; }
BUNDLE_ID=${REVFLARE_BUNDLE_ID:-$(setting REVFLARE_BUNDLE_ID)}
TEAM_ID=${DEVELOPMENT_TEAM:-$(setting DEVELOPMENT_TEAM)}
APP_PROFILE=${REVFLARE_APP_PROFILE:-$(setting REVFLARE_APP_PROFILE)}
WIDGETS_PROFILE=${REVFLARE_WIDGETS_PROFILE:-$(setting REVFLARE_WIDGETS_PROFILE)}
OUT=build
[[ -n "$TEAM_ID" && "$BUNDLE_ID" != com.example.* ]] || {
  echo "Set REVFLARE_BUNDLE_ID and DEVELOPMENT_TEAM in Local.xcconfig (cp Local.example.xcconfig Local.xcconfig)." >&2
  exit 1
}

for tool in xcodegen jq asc; do
  command -v $tool >/dev/null || { echo "$tool is not installed." >&2; exit 1; }
done

# Fail fast (before a long archive) when the app record does not exist yet.
APP_ID=$(asc apps list --bundle-id "$BUNDLE_ID" --output json | jq -r '.data[0].id // empty')
if [[ -z "$APP_ID" ]]; then
  echo "No App Store Connect app for $BUNDLE_ID yet: run scripts/create-app-record.sh first (2FA web session)." >&2
  exit 1
fi

if [[ -z "${BUILD:-}" ]]; then
  LAST=$(asc builds list --app "$APP_ID" --sort -uploadedDate --limit 1 --output json | jq -r '.data[0].attributes.version // "0"')
  BUILD=$(( ${LAST%%.*} + 1 ))
fi
echo "Revflare build $BUILD for app $APP_ID"

xcodegen generate
rm -rf "$OUT/Revflare.xcarchive" "$OUT/export"
xcodebuild -project Revflare.xcodeproj -scheme Revflare -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$OUT/Revflare.xcarchive" -derivedDataPath "$OUT/DerivedDataRelease" \
  CURRENT_PROJECT_VERSION="$BUILD" archive -quiet
test -d "$OUT/Revflare.xcarchive" || { echo "archive failed" >&2; exit 1; }
# Export options for App Store Connect (generated: they contain your team and bundle ids).
cat > "$OUT/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>destination</key><string>export</string>
	<key>manageAppVersionAndBuildNumber</key><false/>
	<key>method</key><string>app-store-connect</string>
	<key>provisioningProfiles</key>
	<dict>
		<key>$BUNDLE_ID</key><string>$APP_PROFILE</string>
		<key>$BUNDLE_ID.widgets</key><string>$WIDGETS_PROFILE</string>
	</dict>
	<key>signingCertificate</key><string>iPhone Distribution</string>
	<key>signingStyle</key><string>manual</string>
	<key>teamID</key><string>$TEAM_ID</string>
	<key>uploadSymbols</key><true/>
</dict>
</plist>
PLIST
xcodebuild -exportArchive -archivePath "$OUT/Revflare.xcarchive" -exportOptionsPlist "$OUT/ExportOptions.plist" -exportPath "$OUT/export"
test -f "$OUT/export/Revflare.ipa" || { echo "export failed" >&2; exit 1; }

asc builds upload --app "$APP_ID" --ipa "$OUT/export/Revflare.ipa" --wait --output json | tee "$OUT/upload.json"
BUILD_ID=$(asc builds list --app "$APP_ID" --build-number "$BUILD" --sort -uploadedDate --limit 1 --output json | jq -r '.data[0].id // empty')
[[ -n "$BUILD_ID" ]] || { echo "Uploaded build $BUILD not found yet; add it to the internal group in App Store Connect later."; exit 0; }

GROUP=$(asc testflight groups list --app "$APP_ID" --internal --output json | jq -c '.data[0] // empty')
GROUP_ID=$(jq -r '.id // empty' <<<"${GROUP:-"{}"}")
if [[ -z "$GROUP_ID" ]]; then
  GROUP_ID=$(asc testflight groups create --app "$APP_ID" --name "Internal" --internal --access-all-builds --output json | jq -r '.data.id')
  ALL_BUILDS=true
else
  ALL_BUILDS=$(jq -r '.attributes.hasAccessToAllBuilds // false' <<<"$GROUP")
fi
if [[ "$ALL_BUILDS" == true ]]; then
  # Apple refuses to assign builds to groups with access to all builds: they get every build anyway.
  echo "Build $BUILD ($BUILD_ID) is in internal TestFlight group $GROUP_ID (it gets every build)."
elif asc builds add-groups --build-id "$BUILD_ID" --group "$GROUP_ID" --output json >/dev/null; then
  echo "Build $BUILD ($BUILD_ID) is in internal TestFlight group $GROUP_ID."
else
  echo "Could not add build $BUILD to group $GROUP_ID; check TestFlight." >&2
fi
