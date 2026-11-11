#!/usr/bin/env bash
# Checks are eval'd strings, so single-quoted expansions and "unused" variables are intended.
# shellcheck disable=SC2016,SC2034

# Tests scripts/revflare-update.sh against two fake repositories in a temp dir: an "upstream" with releases and a
# "copy" with unrelated history and its own wrangler.jsonc (like a Deploy to Cloudflare copy). Run: bash scripts/test-revflare-update.sh

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/revflare-update.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
unset GITHUB_OUTPUT
export LC_ALL=C

fails=0
ok() { echo "ok   $1"; }
fail() {
  echo "FAIL $1" >&2
  fails=$((fails + 1))
}
check() { if eval "$2"; then ok "$1"; else fail "$1"; fi; }

pkg() { printf '{\n  "name": "revflare",\n  "version": "%s"\n}\n' "$1" >package.json; }

# --- upstream: v0.1.0, v0.2.0 (+ a CLI tag and a prerelease that must be ignored) ---
UP="$WORK/upstream"
mkdir -p "$UP" && cd "$UP" && git init -q -b main
pkg 0.1.0
printf '{ "name": "revflare", "r2_buckets": [{ "binding": "RAW", "bucket_name": "revflare-raw" }] }\n' >wrangler.jsonc
mkdir -p src scripts .github/workflows "docs/with space"
echo "a v1" >src/a.ts
echo "old" >src/old.ts
echo "name: CI v1" >.github/workflows/ci.yml
echo "name: update" >.github/workflows/revflare-update.yml
printf '#!/bin/sh\necho hi\n' >scripts/run.sh && chmod +x scripts/run.sh
echo "spaced" >"docs/with space/file.md"
git add -A && git commit -qm "v0.1.0" && git tag v0.1.0

pkg 0.2.0
printf '{ "name": "revflare", "r2_buckets": [{ "binding": "RAW", "bucket_name": "revflare-raw" }], "durable_objects": { "bindings": [{ "name": "DATABASE", "class_name": "RevflareDatabase" }] } }\n' >wrangler.jsonc
echo "a v2" >src/a.ts
git rm -q src/old.ts
echo "new" >src/new.ts
echo "name: CI v2" >.github/workflows/ci.yml
echo "DEMO_MODE=true" >.dev.vars.example
echo "// template v2" >wrangler.local.example.jsonc
echo "spaced v2" >"docs/with space/file.md"
git add -A && git commit -qm "v0.2.0" && git tag v0.2.0
git commit -q --allow-empty -m "cli" && git tag cli-v5.0.0
git commit -q --allow-empty -m "rc" && git tag v0.3.0-rc.1
git commit -q --allow-empty -m "unreleased work on main"
export UPSTREAM_URL="file://$UP" UPSTREAM_REPO="example/revflare"

# --- copy of v0.1.0 with unrelated history, its own wrangler.jsonc and files ---
COPY="$WORK/copy"
mkdir -p "$COPY" && cd "$COPY" && git init -q -b main
git -C "$UP" archive v0.1.0 | tar -x -C "$COPY"
printf '{ "name": "my-revflare", "r2_buckets": [{ "binding": "RAW", "bucket_name": "my-raw" }] }\n' >wrangler.jsonc
echo '{ "routes": ["revenue.example.com"] }' >wrangler.local.jsonc
echo "SECRET=1" >.dev.vars
echo "mine" >my-notes.md
git add -A && git commit -qm "Initial commit from Cloudflare"
MY_WRANGLER="$(cat wrangler.jsonc)"

echo "# check"
out="$("$SCRIPT" check)"
check "finds the newest server release (ignores cli-v*, prereleases)" '[[ "$out" == *"tag=v0.2.0"* ]]'
check "reports the current version" '[[ "$out" == *"current=0.1.0"* ]]'
check "an update is available" '[[ "$out" == *"update=true"* ]]'
GITHUB_OUTPUT="$WORK/gh-output" "$SCRIPT" check >/dev/null
check "writes step outputs to \$GITHUB_OUTPUT" 'grep -qx "tag=v0.2.0" "$WORK/gh-output"'

echo "# apply"
"$SCRIPT" apply v0.2.0 "$WORK/body.md"
check "package.json updated" 'grep -q "\"version\": \"0.2.0\"" package.json'
check "changed files updated" '[ "$(cat src/a.ts)" = "a v2" ]'
check "new files added" '[ -f src/new.ts ]'
check "files deleted upstream are deleted" '[ ! -e src/old.ts ]'
check "paths with spaces" '[ "$(cat "docs/with space/file.md")" = "spaced v2" ]'
check "executable bit kept" '[ -x scripts/run.sh ]'
check "wrangler.jsonc untouched" '[ "$(cat wrangler.jsonc)" = "$MY_WRANGLER" ]'
check "wrangler.local.jsonc untouched" '[ "$(cat wrangler.local.jsonc)" = "{ \"routes\": [\"revenue.example.com\"] }" ]'
check ".dev.vars untouched, .dev.vars.example not copied" '[ "$(cat .dev.vars)" = "SECRET=1" ] && [ ! -e .dev.vars.example ]'
check "workflows not copied" '[ "$(cat .github/workflows/ci.yml)" = "name: CI v1" ]'
check "the wrangler.local.example.jsonc template is copied" '[ "$(cat wrangler.local.example.jsonc)" = "// template v2" ]'
check "own files kept" '[ -f my-notes.md ]'
check "nothing else changed" '[ "$(git status --porcelain | sort | tr "\n" " ")" = " D src/old.ts  M \"docs/with space/file.md\"  M package.json  M src/a.ts ?? src/new.ts ?? wrangler.local.example.jsonc " ]'
body="$(cat "$WORK/body.md")"
check "body links the release notes" '[[ "$body" == *"https://github.com/example/revflare/releases/tag/v0.2.0"* ]]'
check "body links the compare view" '[[ "$body" == *"compare/v0.1.0...v0.2.0"* ]]'
check "body shows the upstream wrangler.jsonc diff" '[[ "$body" == *"wrangler.jsonc\` changed upstream"* && "$body" == *"+{ \"name\": \"revflare\", \"r2_buckets\""*"durable_objects"* ]]'
check "body lists changed workflows" '[[ "$body" == *"- M	.github/workflows/ci.yml"* ]]'
check "body lists deleted files" '[[ "$body" == *"- src/old.ts"* ]]'
git add -A && git commit -qm "chore: update Revflare to v0.2.0"
out="$("$SCRIPT" check)"
check "up to date after merging" '[[ "$out" == *"update=false"* ]]'

echo "# apply without the current version's tag upstream"
COPY2="$WORK/copy2"
mkdir -p "$COPY2" && cd "$COPY2" && git init -q -b main
git -C "$UP" archive v0.1.0 | tar -x -C "$COPY2"
pkg 0.0.9
printf '{ "name": "mine" }\n' >wrangler.jsonc
"$SCRIPT" apply v0.2.0 "$WORK/body2.md"
body="$(cat "$WORK/body2.md")"
check "unknown deletions are kept and reported" '[ -f src/old.ts ] && [[ "$body" == *"could not be detected"* ]]'
check "falls back to diffing your wrangler.jsonc against upstream" '[[ "$body" == *"yours vs. upstream v0.2.0"* && "$body" == *"-{ \"name\": \"mine\" }"* ]]'

echo "# unreachable upstream (private repository)"
out="$(cd "$COPY2" && UPSTREAM_URL="file://$WORK/missing" "$SCRIPT" check 2>"$WORK/err")"
check "no update and no failure when the upstream cannot be listed" '[[ "$out" == *"update=false"* && "$out" == *"tag="* ]]'
check "explains why" 'grep -q "private or missing" "$WORK/err"'

echo "# guards"
check "rejects a bad tag" '! "$SCRIPT" apply "v1; rm -rf /" /dev/null 2>/dev/null'
check "prereleases are older than their release" '(cd "$COPY2" && pkg 0.2.0-rc.1 && "$SCRIPT" check | grep -qx "update=true")'

if [ "$fails" -gt 0 ]; then
  echo "$fails check(s) failed" >&2
  exit 1
fi
echo "all checks passed"
