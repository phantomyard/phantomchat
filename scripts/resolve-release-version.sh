#!/usr/bin/env bash
# Resolve VERSION / TAG / TRIGGER for the app-release workflow (issue #150).
#
# Emits `key=value` lines meant for $GITHUB_OUTPUT. Fails closed BEFORE any
# output is emitted: Git tag names may legally contain shell metacharacters
# (`$(…)`, backticks, `;`, `|` all pass git check-ref-format), so a tag-fed
# version is validated against the exact supported grammar — numeric semver
# `X.Y.Z` — before it can reach a shell or a published filename.
#
# Usage: resolve-release-version.sh <github-ref> <github-run-number>
set -euo pipefail

REF="${1:?usage: resolve-release-version.sh <github-ref> <run-number>}"
RUN_NUMBER="${2:?missing run number}"

if [[ "$REF" == refs/tags/desktop-v* ]]; then
  VERSION="${REF#refs/tags/desktop-v}"
  if ! [[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
    echo "REFUSED: unsupported desktop tag '${REF}' (expected desktop-vX.Y.Z with numeric semver)" >&2
    exit 1
  fi
  TAG="desktop-v${VERSION}"
  TRIGGER="tag"
else
  if ! [[ "$RUN_NUMBER" =~ ^[0-9]+$ ]]; then
    echo "REFUSED: non-numeric run number '${RUN_NUMBER}'" >&2
    exit 1
  fi
  VERSION="1.0.${RUN_NUMBER}"
  TAG="desktop-v1.0.${RUN_NUMBER}"
  TRIGGER="manual"
fi

printf 'version=%s\ntag=%s\ntrigger=%s\n' "$VERSION" "$TAG" "$TRIGGER"
