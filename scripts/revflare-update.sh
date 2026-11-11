#!/usr/bin/env bash
# Updates a copy of Revflare (e.g. the repository the "Deploy to Cloudflare" button created) to the newest upstream
# release. Used by .github/workflows/revflare-update.yml; runnable by hand from the root of your copy.
#
#   scripts/revflare-update.sh check                 prints current=, latest=, tag=, update=true|false
#                                                     (also appended to $GITHUB_OUTPUT when set)
#   scripts/revflare-update.sh apply <tag> [body]    copies the upstream <tag> tree over the working tree and writes
#                                                     a pull request description to [body] (default: stdout)
#
# Environment: UPSTREAM_REPO (owner/name, default FerdiKT/revflare), UPSTREAM_URL (git URL, default the GitHub URL
# of UPSTREAM_REPO; tests point it at a local repository).
#
# Never copied (they are yours, or GitHub refuses workflow changes pushed with the Actions token):
#   wrangler.jsonc, wrangler.local*.jsonc (except the wrangler.local.example.jsonc template), .dev.vars*,
#   .github/workflows/
# Files deleted upstream between your version and <tag> are deleted too; other files you added are left alone.

set -euo pipefail

UPSTREAM_REPO="${UPSTREAM_REPO:-FerdiKT/revflare}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/${UPSTREAM_REPO}.git}"

die() {
  echo "revflare-update: $*" >&2
  exit 1
}

is_excluded() {
  case "$1" in
    wrangler.local.example.jsonc) return 1 ;; # upstream's template, not your config
    wrangler.jsonc | wrangler.local*.jsonc | .dev.vars* | .github/workflows/*) return 0 ;;
    *) return 1 ;;
  esac
}

current_version() {
  [ -f package.json ] || die "run from the root of your Revflare copy (no package.json here)"
  node -p 'require("./package.json").version'
}

# Highest vX.Y.Z tag upstream (no prereleases, no cli-v* tags).
# Prints nothing (no update) when the upstream cannot be listed, e.g. while it is private.
latest_tag() {
  local refs
  if ! refs="$(GIT_TERMINAL_PROMPT=0 git ls-remote --tags --refs "$UPSTREAM_URL" 'v*' 2>/dev/null)"; then
    echo "revflare-update: cannot list the tags of $UPSTREAM_URL (private or missing repository?)" >&2
    return 0
  fi
  printf '%s\n' "$refs" |
    sed -n 's#^.*refs/tags/\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$#\1#p' |
    sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 | sed 's/^./v&/'
}

# True when version $1 > version $2 (X.Y.Z; a prerelease suffix on $2 counts as older than its release).
newer() {
  local a="$1" b="${2%%-*}" pre=""
  [ "$b" != "$2" ] && pre=1
  local IFS=.
  # shellcheck disable=SC2206
  local x=($a) y=($b)
  for i in 0 1 2; do
    [ "${x[$i]:-0}" -gt "${y[$i]:-0}" ] && return 0
    [ "${x[$i]:-0}" -lt "${y[$i]:-0}" ] && return 1
  done
  [ -n "$pre" ]
}

cmd_check() {
  local current tag latest update=false
  current="$(current_version)"
  tag="$(latest_tag)"
  latest="${tag#v}"
  if [ -n "$tag" ] && newer "$latest" "$current"; then update=true; fi
  local out="current=$current
latest=$latest
tag=$tag
update=$update"
  echo "$out"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$out" >>"$GITHUB_OUTPUT"; fi
}

cmd_apply() {
  local tag="${1:-}" body="${2:-/dev/stdout}"
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: $0 apply vX.Y.Z [body-file]"
  local current old
  current="$(current_version)"
  old="v${current%%-*}"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  local tmp="$TMP_DIR"

  git -C "$tmp" init -q
  git -C "$tmp" fetch -q --depth 1 "$UPSTREAM_URL" "refs/tags/$tag:refs/tags/$tag" || die "cannot fetch $tag from $UPSTREAM_URL"
  local have_old=true
  git -C "$tmp" fetch -q --depth 1 "$UPSTREAM_URL" "refs/tags/$old:refs/tags/$old" 2>/dev/null || have_old=false
  mkdir "$tmp/tree"
  git -C "$tmp" archive "$tag" | tar -x -C "$tmp/tree"

  # Copy the new release over the working tree.
  local f
  (cd "$tmp/tree" && find . -type f ! -path './.git/*' | sed 's#^\./##') | while IFS= read -r f; do
    is_excluded "$f" && continue
    mkdir -p "$(dirname "$f")"
    cp -p "$tmp/tree/$f" "$f"
  done

  # Delete what upstream deleted since your version.
  local deleted=""
  if $have_old; then
    deleted="$(git -C "$tmp" diff --no-renames --name-only --diff-filter=D "$old" "$tag")"
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      is_excluded "$f" && continue
      rm -f "$f"
    done <<<"$deleted"
  fi

  # Pull request description.
  local base="https://github.com/$UPSTREAM_REPO"
  {
    echo "Updates Revflare from **v$current** to **$tag**."
    echo
    echo "- Release notes: $base/releases/tag/$tag"
    if $have_old; then echo "- All changes: $base/compare/$old...$tag"; fi
    echo "- Database migrations run automatically after the deploy. Read the release notes for breaking changes first."
    echo
    echo "Merging deploys the update (Workers Builds deploys every push to your production branch)."
    echo
    echo "Not copied, so your settings stay as they are: \`wrangler.jsonc\`, \`wrangler.local*.jsonc\`, \`.dev.vars*\`, \`.github/workflows/\`."
    if $have_old; then
      if ! git -C "$tmp" diff --quiet "$old" "$tag" -- wrangler.jsonc; then
        echo
        echo "### ⚠️ \`wrangler.jsonc\` changed upstream"
        echo
        echo "Apply these changes to your own \`wrangler.jsonc\` by hand (new bindings, Durable Object migrations, compatibility date...), keeping your resource names and ids:"
        echo
        echo '```diff'
        git -C "$tmp" diff "$old" "$tag" -- wrangler.jsonc
        echo '```'
      fi
      if ! git -C "$tmp" diff --quiet "$old" "$tag" -- .github/workflows; then
        echo
        echo "### GitHub workflows changed upstream"
        echo
        echo "The Actions token cannot change workflow files: copy these from $base/tree/$tag/.github/workflows if you use them:"
        echo
        git -C "$tmp" diff --name-status "$old" "$tag" -- .github/workflows | sed 's/^/- /'
      fi
      if [ -n "$deleted" ]; then
        echo
        echo "<details><summary>Files removed upstream (deleted here too)</summary>"
        echo
        # shellcheck disable=SC2001
        sed 's/^/- /' <<<"$deleted"
        echo
        echo "</details>"
      fi
    else
      echo
      echo "Upstream has no tag $old (your current version), so files removed upstream since then could not be detected and are kept."
      if [ -f wrangler.jsonc ] && ! diff -q wrangler.jsonc "$tmp/tree/wrangler.jsonc" >/dev/null 2>&1; then
        echo
        echo "### \`wrangler.jsonc\`: yours vs. upstream $tag"
        echo
        echo "Check for new bindings or Durable Object migrations to add by hand (resource names and ids are expected to differ):"
        echo
        echo '```diff'
        diff -u wrangler.jsonc "$tmp/tree/wrangler.jsonc" --label "wrangler.jsonc (yours)" --label "wrangler.jsonc ($tag)" || true
        echo '```'
      fi
    fi
    echo
    echo "_Opened by the \`revflare-update\` workflow (scripts/revflare-update.sh)._"
  } >"$body"
}

case "${1:-}" in
  check) cmd_check ;;
  apply)
    shift
    cmd_apply "$@"
    ;;
  *) die "usage: $0 check | apply vX.Y.Z [body-file]" ;;
esac
