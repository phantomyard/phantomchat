#!/bin/bash
# PhantomChat maintainer script — used by BOTH the .deb and the .rpm.
#
# This is electron-builder 26.16's stock after-install template with ONE
# deliberate change: chrome-sandbox is ALWAYS installed setuid root (4755),
# instead of only when a root-run `unshare --user` probe fails.
#
# Why: maintainer scripts run as ROOT under dpkg/rpm, and root passes
# `unshare --user true` on every kernel (it holds CAP_SYS_ADMIN, so the
# unprivileged-userns AppArmor restriction does not apply). The stock probe
# therefore always takes the "user namespaces available" branch and strips
# the setuid bit — but that branch is only correct for the UNPRIVILEGED user
# the app actually runs as. On Ubuntu 24+ with
# kernel.apparmor_restrict_unprivileged_userns=1 the app may only create user
# namespaces while its own AppArmor profile is loaded, so a launch that races
# the profile load (or any distro that restricts unprivileged userns without
# our profile) finds NO usable sandbox and aborts with
#   FATAL: SUID sandbox helper not configured correctly
# The setuid helper is exactly the fallback Chromium uses in that case, and
# it is inert when the namespace sandbox is available. Installing it
# unconditionally makes the result independent of who runs this script, when
# the AppArmor profile lands, and which kernel knobs the distro ships.
#
# Everything else mirrors the stock template so the PATH link, MIME/desktop
# databases and the AppArmor profile keep working; CI asserts all of it in
# scripts/check-deb-install.sh.

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/phantomchat' -a -e '/usr/bin/phantomchat' -a "`readlink '/usr/bin/phantomchat'`" != '/etc/alternatives/phantomchat' ]; then
        rm -f '/usr/bin/phantomchat'
    fi
    update-alternatives --install '/usr/bin/phantomchat' 'phantomchat' '/opt/PhantomChat/phantomchat' 100 || ln -sf '/opt/PhantomChat/phantomchat' '/usr/bin/phantomchat'
else
    ln -sf '/opt/PhantomChat/phantomchat' '/usr/bin/phantomchat'
fi

# SUID chrome-sandbox, unconditionally — see the header. || true so a
# read-only filesystem cannot fail the whole package install over this.
chmod 4755 '/opt/PhantomChat/chrome-sandbox' || true

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install apparmor profile. (Ubuntu 24+)
# First check if the version of AppArmor running on the device supports our profile.
# This is in order to keep backwards compatibility with Ubuntu 22.04 which does not support abi/4.0.
# In that case, we just skip installing the profile since the app runs fine without it on 22.04.
#
# Those apparmor_parser flags are akin to performing a dry run of loading a profile.
# https://wiki.debian.org/AppArmor/HowToUse#Dumping_profiles
#
# Unfortunately, at the moment AppArmor doesn't have a good story for backwards compatibility.
# https://askubuntu.com/questions/1517272/writing-a-backwards-compatible-apparmor-profile
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/PhantomChat/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/phantomchat'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    # Updating the current AppArmor profile is not possible and probably not meaningful in a chroot'ed environment.
    # Use cases are for example environments where images for clients are maintained.
    # There, AppArmor might correctly be installed, but live updating makes no sense.
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      # Extra flags taken from dh_apparmor:
      # > By using '-W -T' we ensure that any abstraction updates are also pulled in.
      # https://wiki.debian.org/AppArmor/Contribute/FirstTimeProfileImport
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi
