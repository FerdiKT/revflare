#!/usr/bin/env bash
# Publishes sdk/ios as the RevflareKit Swift package repository (read-only mirror: changes go to this repo).
# Splits the sdk/ios history with `git subtree split`, pushes it to the mirror's main branch and tags it with
# Revflare.version when that tag doesn't exist yet. Idempotent.
#
#   scripts/publish-revflarekit.sh                      # mirror = $REVFLAREKIT_REMOTE or git@github.com:FerdiKT/RevflareKit.git
#   REVFLAREKIT_REMOTE=https://github.com/<you>/RevflareKit.git scripts/publish-revflarekit.sh
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE=${REVFLAREKIT_REMOTE:-git@github.com:FerdiKT/RevflareKit.git}
VERSION=$(sed -n 's/.*public static let version = "\([0-9][0-9.]*\)".*/\1/p' sdk/ios/Sources/RevflareKit/Revflare.swift)
[[ -n "$VERSION" ]] || { echo "Revflare.version not found" >&2; exit 1; }

SPLIT=$(git subtree split --prefix=sdk/ios HEAD)
echo "sdk/ios at $SPLIT, RevflareKit $VERSION -> $REMOTE"
# The mirror's history may not contain the split (this repository's history was restarted at the public release):
# then a commit with the split's tree goes on top of the mirror's main, so the mirror is never force-pushed and its
# existing tags stay valid.
PUBLISH=$SPLIT
if git fetch -q "$REMOTE" main 2>/dev/null; then
  MIRROR=$(git rev-parse FETCH_HEAD)
  if [[ "$(git rev-parse "$MIRROR^{tree}")" == "$(git rev-parse "$SPLIT^{tree}")" ]]; then
    PUBLISH=$MIRROR
  elif ! git merge-base --is-ancestor "$MIRROR" "$SPLIT"; then
    PUBLISH=$(GIT_AUTHOR_NAME=${GIT_AUTHOR_NAME:-revflare-publish} GIT_AUTHOR_EMAIL=${GIT_AUTHOR_EMAIL:-noreply@github.com} \
      GIT_COMMITTER_NAME=${GIT_COMMITTER_NAME:-revflare-publish} GIT_COMMITTER_EMAIL=${GIT_COMMITTER_EMAIL:-noreply@github.com} \
      git commit-tree "$SPLIT^{tree}" -p "$MIRROR" -m "RevflareKit $VERSION" -m "From FerdiKT/revflare $(git rev-parse --short HEAD).")
  fi
fi
SPLIT=$PUBLISH
git push "$REMOTE" "$SPLIT:refs/heads/main"
if git ls-remote --tags "$REMOTE" "refs/tags/$VERSION" | grep -q .; then
  echo "Tag $VERSION already exists on the mirror (bump Revflare.version to release a new version)."
else
  git push "$REMOTE" "$SPLIT:refs/tags/$VERSION"
  echo "Tagged $VERSION."
fi
