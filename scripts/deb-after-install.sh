#!/bin/bash
# deb post-install: fix ownership of the browser link handler and refresh the
# desktop database. electron-builder already installed the .desktop file.
set -e

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi

if command -v update-mime-database >/dev/null 2>&1; then
  update-mime-database /usr/share/mime || true
fi

exit 0
