#!/bin/bash
# Install the built .deb on the CI runner and prove the maintainer scripts did
# their job: `phantomchat` on PATH, chrome-sandbox usable, AppArmor profile in
# place where AppArmor is on, and a clean removal. Guards against a custom
# afterInstall/afterRemove silently replacing electron-builder's stock ones.
# Usage: scripts/check-deb-install.sh path/to/phantomchat_<ver>_amd64.deb
set -euo pipefail

deb="$(realpath "${1:?usage: $0 <path-to-deb>}")"
fail() { echo "FAIL: $*" >&2; exit 1; }

sudo apt-get install -y "$deb"

# 1. Command on PATH, resolving to the bundled binary.
command -v phantomchat >/dev/null || fail "phantomchat is not on PATH"
[ "$(readlink -f "$(command -v phantomchat)")" = /opt/PhantomChat/phantomchat ] \
  || fail "phantomchat resolves to $(readlink -f "$(command -v phantomchat)")"

# 2. chrome-sandbox: root-owned, and either setuid (no user namespaces) or
#    0755 backed by the AppArmor profile (user namespaces available).
sandbox=/opt/PhantomChat/chrome-sandbox
[ "$(stat -c %U "$sandbox")" = root ] || fail "chrome-sandbox not owned by root"
mode="$(stat -c %a "$sandbox")"
case "$mode" in 4755|755) ;; *) fail "chrome-sandbox mode is $mode" ;; esac

# 3. AppArmor profile installed AND loaded whenever AppArmor is enabled on the
#    host (installed-but-not-loaded still blocks user namespaces).
aa_loaded() { sudo cat /sys/kernel/security/apparmor/profiles 2>/dev/null | grep -q '^phantomchat '; }
aa_enabled=0
if sudo apparmor_status --enabled >/dev/null 2>&1; then
  aa_enabled=1
  [ -f /etc/apparmor.d/phantomchat ] || fail "AppArmor enabled but profile not installed"
  aa_loaded || fail "AppArmor profile installed but not loaded"
fi

# 4. Removal cleans up after itself.
sudo apt-get remove -y phantomchat
[ ! -e /usr/bin/phantomchat ] || fail "/usr/bin/phantomchat left behind after remove"
[ ! -e /etc/apparmor.d/phantomchat ] || fail "AppArmor profile left behind after remove"
if [ "$aa_enabled" = 1 ] && aa_loaded; then fail "AppArmor profile still loaded after remove"; fi

echo "deb install check OK (chrome-sandbox mode $mode, apparmor enabled=$aa_enabled)"
