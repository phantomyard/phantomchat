#!/bin/bash
# deb post-remove: refresh the desktop database. The package's own files are
# removed by dpkg; nothing else to clean.
set -e

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi

exit 0
