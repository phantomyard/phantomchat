#!/usr/bin/env bash
# Mount and exercise a PhantomChat DMG on its native macOS architecture.
set -euo pipefail

DMG="${1:?usage: check-macos-package.sh <dmg> <x64|arm64> [version]}"
EXPECTED_ARCH="${2:?missing expected architecture (x64 or arm64)}"
EXPECTED_VERSION="${3:-}"

[[ "$(uname -s)" == "Darwin" ]] || { echo "macOS required" >&2; exit 1; }
[[ -f "$DMG" ]] || { echo "DMG not found: $DMG" >&2; exit 1; }

case "$EXPECTED_ARCH" in
  x64) FILE_ARCH="x86_64" ;;
  arm64) FILE_ARCH="arm64" ;;
  *) echo "unsupported architecture: $EXPECTED_ARCH" >&2; exit 1 ;;
esac

MOUNT_POINT="$(mktemp -d)"
cleanup() {
  hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1 || true
  rmdir "$MOUNT_POINT" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# EXPECT_SIGNED=1 is set by the release workflow only. PR CI packages the same
# DMG without the Developer ID certificate (electron-builder skips signing when
# CSC_IDENTITY_AUTO_DISCOVERY=false and no CSC_LINK is present), so the signing
# assertions below must not run there — but a release that somehow loses its
# signature has to fail here rather than reach users.
EXPECT_SIGNED="${EXPECT_SIGNED:-0}"

if [[ "$EXPECT_SIGNED" == "1" ]]; then
  # The DMG must carry a stapled notarization ticket: that is what lets a
  # quarantined download launch on a user's Mac, and offline. `stapler
  # validate` fails if the ticket is missing, stale, or for different bits.
  xcrun stapler validate "$DMG" \
    || { echo "DMG is not notarized/stapled: $DMG" >&2; exit 1; }
fi

hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT_POINT" -quiet
APP="$MOUNT_POINT/PhantomChat.app"
EXECUTABLE="$APP/Contents/MacOS/PhantomChat"
PLIST="$APP/Contents/Info.plist"

[[ -x "$EXECUTABLE" ]] || { echo "packaged executable missing: $EXECUTABLE" >&2; exit 1; }
[[ -f "$APP/Contents/Resources/app.asar" ]] || { echo "app.asar missing" >&2; exit 1; }
[[ "$(defaults read "$PLIST" CFBundleIdentifier)" == "ai.phantomyard.chat" ]] \
  || { echo "unexpected bundle identifier" >&2; exit 1; }
[[ "$(defaults read "$PLIST" NSMicrophoneUsageDescription)" == *microphone* ]] \
  || { echo "microphone usage description missing" >&2; exit 1; }
[[ "$(defaults read "$PLIST" NSCameraUsageDescription)" == *camera* ]] \
  || { echo "camera usage description missing" >&2; exit 1; }

if [[ -n "$EXPECTED_VERSION" ]]; then
  [[ "$(defaults read "$PLIST" CFBundleShortVersionString)" == "$EXPECTED_VERSION" ]] \
    || { echo "unexpected bundle version" >&2; exit 1; }
fi

if [[ "$EXPECT_SIGNED" == "1" ]]; then
  # Signed by our Developer ID, with the hardened runtime, and accepted by
  # Gatekeeper's own policy engine. `spctl` is the closest CI gets to what a
  # user's Mac does on first launch.
  codesign --verify --deep --strict --verbose=2 "$APP" \
    || { echo "app failed codesign verification" >&2; exit 1; }
  codesign --display --verbose=4 "$APP" 2>&1 | grep -q "Authority=Developer ID Application: Andrew Hodges (644GWVQQ4P)" \
    || { echo "app is not signed by the expected Developer ID" >&2; exit 1; }
  codesign --display --verbose=4 "$APP" 2>&1 | grep -q "flags=.*runtime" \
    || { echo "app is missing the hardened runtime flag" >&2; exit 1; }
  spctl --assess --type execute --verbose=4 "$APP" \
    || { echo "Gatekeeper rejected the app" >&2; exit 1; }
fi

file "$EXECUTABLE" | grep -q "$FILE_ARCH" \
  || { echo "executable is not $FILE_ARCH: $(file "$EXECUTABLE")" >&2; exit 1; }

# Run the packaged Electron executable itself in Node mode. This proves the
# mounted app launches natively on the runner without requiring a logged-in
# WindowServer session, which GitHub-hosted runners do not guarantee.
ACTUAL_ARCH="$(ELECTRON_RUN_AS_NODE=1 "$EXECUTABLE" -e 'process.stdout.write(process.arch)')"
[[ "$ACTUAL_ARCH" == "$EXPECTED_ARCH" ]] \
  || { echo "packaged runtime reports $ACTUAL_ARCH, expected $EXPECTED_ARCH" >&2; exit 1; }

if [[ "$EXPECT_SIGNED" == "1" ]]; then
  echo "Verified signed + notarized PhantomChat.app ${EXPECTED_VERSION:-unversioned} ($EXPECTED_ARCH) from $(basename "$DMG")."
else
  echo "Verified PhantomChat.app ${EXPECTED_VERSION:-unversioned} ($EXPECTED_ARCH) from $(basename "$DMG") (signing not asserted)."
fi
