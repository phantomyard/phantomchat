#!/usr/bin/env bash
# Promote a desktop release candidate from preview to stable (issue #150).
#
# Contract:
#  - Takes an existing GitHub release (tag), verifies EVERY required platform
#    artifact and its SHA-256 checksum is present, then flips the release to
#    the stable latest: prerelease flag cleared, marked latest.
#  - Never rebuilds, re-signs, retags or re-uploads anything. The exact
#    artifacts and checksums tested on preview become stable.
#  - Promoting an older known-good tag by name is the rollback path.
#  - Fails closed: any missing artifact or checksum mismatch aborts before
#    the release metadata is touched.
#
# Usage: scripts/promote-release.sh <tag> [owner/repo]
set -euo pipefail

TAG="${1:?usage: promote-release.sh <tag> [owner/repo]}"
REPO="${2:-${GITHUB_REPOSITORY:-phantomyard/phantomchat}}"

# Required artifacts per release ring. Architectures are deliberately
# explicit: promotion must see both macOS DMGs and both Windows installers.
# The update feeds are required too (issue #164): promoting a release whose
# latest.yml is missing would make the stable ring invisible to every
# installed client — they would check, get a 404 and stay on the old build
# forever. Fail closed here rather than discover it in the field.
REQUIRED_ARTIFACTS=(
  "PhantomChat-*.AppImage"
  "phantomchat_*_amd64.deb"
  "PhantomChat-*-x64.dmg"
  "PhantomChat-*-arm64.dmg"
  "PhantomChat-*-x64.zip"
  "PhantomChat-*-arm64.zip"
  "PhantomChat-*-windows-x64.exe"
  "PhantomChat-*-windows-arm64.exe"
  "latest.yml"
  "latest-mac.yml"
  "latest-linux.yml"
  "SHA256SUMS.txt"
)

fail() { echo "PROMOTE FAILED: $*" >&2; exit 1; }

command -v gh >/dev/null || fail "gh CLI not available"

# --- the release must exist and be a prerelease candidate -------------------
STATE_JSON="$(gh release view "$TAG" --repo "$REPO" --json isPrerelease,isDraft,assets 2>/dev/null)" \
  || fail "release ${TAG} not found in ${REPO}"

IS_PRERELEASE="$(echo "$STATE_JSON" | jq -r .isPrerelease)"
IS_DRAFT="$(echo "$STATE_JSON" | jq -r .isDraft)"
[[ "$IS_DRAFT" == "false" ]] || fail "release ${TAG} is a draft"
[[ "$IS_PRERELEASE" == "true" ]] || fail "release ${TAG} is already stable (not a prerelease) — nothing to promote"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
cd "$WORKDIR"

echo "Downloading all assets of ${TAG} for verification..."
gh release download "$TAG" --repo "$REPO" --dir . || fail "asset download failed"

# --- every required artifact must exist -------------------------------------
# NOTE: a plain `matches=( $pattern )` fails open — with nullglob disabled an
# unmatched glob stays a literal string and the length check passes even when
# nothing was downloaded. nullglob keeps the check honest.
shopt -s nullglob
for pattern in "${REQUIRED_ARTIFACTS[@]}"; do
  matches=( $pattern )
  # nullglob only drops patterns that CONTAIN a wildcard. A literal entry
  # (latest.yml, SHA256SUMS.txt) survives as itself whether or not the file
  # exists, so an existence check is what makes those honest — otherwise a
  # missing feed reported as "matched a non-regular file", which reads like a
  # packaging bug rather than a missing asset.
  if [[ ${#matches[@]} -eq 0 || ! -e "${matches[0]}" ]]; then
    fail "required artifact missing on ${TAG}: ${pattern}"
  fi
  for match in "${matches[@]}"; do
    [[ -f "$match" ]] || fail "required artifact pattern ${pattern} matched a non-regular file: ${match}"
  done
done
shopt -u nullglob

# --- checksums must verify ---------------------------------------------------
[[ -f "SHA256SUMS.txt" ]] || fail "SHA256SUMS.txt missing"
# Every file referenced by SHA256SUMS.txt must exist and match.
sha256sum --check --strict SHA256SUMS.txt || fail "checksum verification failed"

# Cross-check: every artifact on the release (except the checksum file itself)
# must be covered by SHA256SUMS.txt — no unchecksummed payload sneaks in.
EXPECTED_LIST="$(awk '{print $2}' SHA256SUMS.txt | sort)"
ACTUAL_LIST="$(find . -maxdepth 1 -type f ! -name 'SHA256SUMS.txt' -printf '%f\n' | sort)"
[[ "$EXPECTED_LIST" == "$ACTUAL_LIST" ]] || fail "asset list differs from SHA256SUMS.txt (missing or extra artifacts)

expected: ${EXPECTED_LIST//$'\n'/, }
actual:   ${ACTUAL_LIST//$'\n'/, }"

# --- the feed must describe THIS release ---------------------------------------
# A stale latest.yml (e.g. re-uploaded from an earlier run) would point stable
# users at artifacts that are not on this release. The version line is a plain
# YAML scalar written by electron-builder, so grep is sufficient and avoids a
# node/yq dependency in the promotion path.
FEED_VERSION="${TAG#phantomchat-v}"
for feed in latest.yml latest-mac.yml latest-linux.yml; do
  grep -qx "version: ${FEED_VERSION}" "$feed" \
    || fail "${feed} does not declare version ${FEED_VERSION} (got: $(grep -m1 '^version:' "$feed" || echo 'no version line'))"
done
echo "Update feeds declare version ${FEED_VERSION}."

echo "All required artifacts present and checksums verified."
echo "Promoting ${TAG} to stable latest (metadata only — artifacts are untouched)..."

# --- promotion: metadata-only change ----------------------------------------
gh release edit "$TAG" --repo "$REPO" --prerelease=false --latest=true \
  || fail "gh release edit failed"

echo "Promoted ${TAG} to stable latest."

# --- postcondition: the promotion actually took effect -----------------------
# gh release view has no isLatest JSON field, so verify through the REST
# endpoint that serves the current latest stable release.
LATEST_TAG="$(gh api "repos/${REPO}/releases/latest" --jq .tag_name 2>/dev/null)" \
  || fail "postcondition check failed: could not verify the latest release (the promotion itself already succeeded — inspect ${TAG} manually)"
[[ "$LATEST_TAG" == "$TAG" ]] \
  || fail "postcondition failed: latest release is ${LATEST_TAG}, expected ${TAG} (the promotion metadata was applied — inspect the release before retrying)"
echo "Verified: ${TAG} is the stable latest."
