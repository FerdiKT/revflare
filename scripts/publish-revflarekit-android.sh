#!/usr/bin/env bash
# Publishes sdk/android as the RevflareKit-Android repository (read-only mirror: changes go to this repo).
# Splits the sdk/android history with `git subtree split`, pushes it to the mirror's main branch and tags it with the
# library version when that tag doesn't exist yet; the mirror's publish workflow then publishes the tag to GitHub
# Packages. Idempotent.
#
#   scripts/publish-revflarekit-android.sh   # mirror = $REVFLAREKIT_ANDROID_REMOTE or git@github.com:FerdiKT/RevflareKit-Android.git
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE=${REVFLAREKIT_ANDROID_REMOTE:-git@github.com:FerdiKT/RevflareKit-Android.git}
VERSION=$(sed -n 's/^version = "\([0-9][0-9.]*\)".*/\1/p' sdk/android/revflarekit/build.gradle.kts)
[[ -n "$VERSION" ]] || { echo "version not found in sdk/android/revflarekit/build.gradle.kts" >&2; exit 1; }

SPLIT=$(git subtree split --prefix=sdk/android HEAD)
echo "sdk/android at $SPLIT, RevflareKit Android $VERSION -> $REMOTE"
git push "$REMOTE" "$SPLIT:refs/heads/main"
if git ls-remote --tags "$REMOTE" "refs/tags/$VERSION" | grep -q .; then
  echo "Tag $VERSION already exists on the mirror (bump the version to release a new one)."
else
  git push "$REMOTE" "$SPLIT:refs/tags/$VERSION"
  echo "Tagged $VERSION."
fi
