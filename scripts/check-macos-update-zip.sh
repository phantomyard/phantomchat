#!/usr/bin/env bash
# Verify the macOS update zip — the artifact Squirrel.Mac installs (issue #169).
#
# The DMG is what a human downloads and scripts/check-macos-package.sh already
# proves it out. The zip is a SEPARATE container built from the same .app, and
# it is the one every existing macOS install will silently swap itself to. If
# it is unsigned, unstapled, or the wrong version, nothing fails until an
# update lands on a user's machine — so it gets the same proof here.
set -euo pipefail

ZIP="${1:?usage: check-macos-update-zip.sh <zip> [version]}"
EXPECTED_VERSION="${2:-}"

[[ "$(uname -s)" == "Darwin" ]] || { echo "macOS required" >&2; exit 1; }
[[ -f "$ZIP" ]] || { echo "update zip not found: $ZIP" >&2; exit 1; }

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# ditto, not unzip: the zip was written with --sequesterRsrc, and only ditto
# restores the extended attributes and symlinks a signed bundle depends on.
# Extracting with unzip can break the signature and make this check lie.
ditto -x -k "$ZIP" "$WORKDIR" || { echo "could not extract $ZIP" >&2; exit 1; }

APP="$WORKDIR/PhantomChat.app"
# --keepParent means the archive contains PhantomChat.app at its root. Anything
# else means the zip was built differently from what electron-updater expects.
[[ -d "$APP" ]] || { echo "zip does not contain PhantomChat.app at its root: $(ls -A "$WORKDIR")" >&2; exit 1; }

PLIST="$APP/Contents/Info.plist"
[[ -x "$APP/Contents/MacOS/PhantomChat" ]] || { echo "packaged executable missing in zip" >&2; exit 1; }

if [[ -n "$EXPECTED_VERSION" ]]; then
  [[ "$(defaults read "$PLIST" CFBundleShortVersionString)" == "$EXPECTED_VERSION" ]] \
    || { echo "zip contains version $(defaults read "$PLIST" CFBundleShortVersionString), expected $EXPECTED_VERSION" >&2; exit 1; }
fi

# EXPECT_SIGNED=1 is set by the release workflow only; PR CI builds the same
# zip without the Developer ID certificate.
EXPECT_SIGNED="${EXPECT_SIGNED:-0}"
if [[ "$EXPECT_SIGNED" == "1" ]]; then
  codesign --verify --deep --strict --verbose=2 "$APP" \
    || { echo "app in the update zip failed codesign verification" >&2; exit 1; }
  codesign --display --verbose=4 "$APP" 2>&1 | grep -q "Authority=Developer ID Application: Andrew Hodges (644GWVQQ4P)" \
    || { echo "app in the update zip is not signed by the expected Developer ID" >&2; exit 1; }
  # The ticket is the whole point of re-zipping after stapling: an updated
  # install must validate offline, without calling home to Apple.
  xcrun stapler validate "$APP" \
    || { echo "app in the update zip carries no stapled notarization ticket" >&2; exit 1; }
  spctl --assess --type execute --verbose=4 "$APP" \
    || { echo "Gatekeeper rejected the app in the update zip" >&2; exit 1; }
  echo "Verified signed + stapled PhantomChat.app ${EXPECTED_VERSION:-unversioned} in $(basename "$ZIP")."
else
  echo "Verified PhantomChat.app ${EXPECTED_VERSION:-unversioned} in $(basename "$ZIP") (signing not asserted)."
fi
