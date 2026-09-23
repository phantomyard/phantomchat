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

file "$EXECUTABLE" | grep -q "$FILE_ARCH" \
  || { echo "executable is not $FILE_ARCH: $(file "$EXECUTABLE")" >&2; exit 1; }

# Run the packaged Electron executable itself in Node mode. This proves the
# mounted app launches natively on the runner without requiring a logged-in
# WindowServer session, which GitHub-hosted runners do not guarantee.
ACTUAL_ARCH="$(ELECTRON_RUN_AS_NODE=1 "$EXECUTABLE" -e 'process.stdout.write(process.arch)')"
[[ "$ACTUAL_ARCH" == "$EXPECTED_ARCH" ]] \
  || { echo "packaged runtime reports $ACTUAL_ARCH, expected $EXPECTED_ARCH" >&2; exit 1; }

echo "Verified PhantomChat.app ${EXPECTED_VERSION:-unversioned} ($EXPECTED_ARCH) from $(basename "$DMG")."
