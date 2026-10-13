#!/usr/bin/env bash
# Notarize already-signed macOS release artifacts without rebuilding them.
set -euo pipefail

DMG="${1:?usage: notarize-macos-artifacts.sh <dmg> <zip>}"
ZIP="${2:?usage: notarize-macos-artifacts.sh <dmg> <zip>}"

[[ "$(uname -s)" == "Darwin" ]] || { echo "macOS required" >&2; exit 1; }
[[ -f "$DMG" ]] || { echo "DMG not found: $DMG" >&2; exit 1; }
[[ -f "$ZIP" ]] || { echo "update zip not found: $ZIP" >&2; exit 1; }
: "${APPLE_ID:?APPLE_ID is required}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD is required}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"

retry() {
  local max_attempts="${RETRY_MAX_ATTEMPTS:-5}"
  local delay="${RETRY_INITIAL_DELAY_SECONDS:-5}"
  local attempt=1
  until "$@"; do
    local status=$?
    if (( attempt >= max_attempts )); then
      echo "command failed after ${attempt} attempts (exit ${status}): $*" >&2
      return "$status"
    fi
    echo "command failed (attempt ${attempt}/${max_attempts}); retrying in ${delay}s: $*" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

notarize() {
  local artifact="$1"
  local response submission_id

  # Submit once and retry only the wait by id. A lost wait connection must not
  # create a duplicate notarization submission for bytes Apple already has.
  response="$(retry xcrun notarytool submit "$artifact" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --output-format json)"
  submission_id="$(jq -er '.id' <<<"$response")" \
    || { echo "notarytool returned no submission id: $response" >&2; return 1; }
  retry xcrun notarytool wait "$submission_id" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --timeout 30m
}

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# Recover the signed app from electron-builder's update zip. `ditto` preserves
# the resource forks, extended attributes, executable bits and symlinks that
# are part of the Developer ID signature.
ditto -x -k "$ZIP" "$workdir"
APP="$workdir/PhantomChat.app"
[[ -d "$APP" ]] || { echo "update zip does not contain PhantomChat.app at its root" >&2; exit 1; }

notarize "$DMG"
retry xcrun stapler staple "$DMG"

# The DMG submission normally covers the identical app cdhash. If Apple does
# not expose that ticket, submit the original signed zip once, then retry only
# the ticket lookup/staple operation.
if ! retry xcrun stapler staple "$APP"; then
  echo "DMG ticket did not staple to the app; notarizing the signed zip"
  notarize "$ZIP"
  retry xcrun stapler staple "$APP"
fi
retry xcrun stapler validate "$DMG"
retry xcrun stapler validate "$APP"

rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
[[ -s "$ZIP" ]] || { echo "re-zipping the stapled app produced no artifact" >&2; exit 1; }
