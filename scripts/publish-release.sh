#!/usr/bin/env bash
# Publish a desktop-app preview release (issue #150 PR#1).
#
# Mirrors phantombot's release.yml contract, kept as a script so the guards
# stay contract-tested (src/tests/publishReleaseScript.test.ts):
#
#  - The version/tag are synthesized by the app-release workflow from its
#    monotonic github.run_number (desktop-v1.0.<run_number>) — nobody pushes
#    a desktop-v* tag by hand and there is no dispatch input, so no
#    user-controlled text reaches this shell. The strict semver grammar
#    check below is defense in depth, not the primary control.
#  - Release tags are immutable: if the release OR the tag already exists,
#    the run fails closed — tags are never deleted, recreated or moved.
#  - `--target` pins the created tag to the exact commit that was built, so
#    `git checkout desktop-v1.0.N` can never lie about what code is in it.
#  - The release is ALWAYS a prerelease (preview channel). Stable is the
#    app-promote workflow's job, and it never rebuilds.
#
# Usage:
#   scripts/publish-release.sh <tag> <version> <commit-sha> <artifacts-dir> [owner/repo]
#
# Optional environment:
#   RELEASE_TITLE       release title (default: "PhantomChat Desktop <version> (preview)")
#   RELEASE_NOTES_FILE path to the release notes body (passed via --notes-file)
set -euo pipefail

TAG="${1:?usage: publish-release.sh <tag> <version> <commit-sha> <artifacts-dir> [owner/repo]}"
VERSION="${2:?missing version}"
COMMIT="${3:?missing commit sha}"
ARTIFACTS_DIR="${4:?missing artifacts dir}"
REPO="${5:-${GITHUB_REPOSITORY:-phantomyard/phantomchat}}"

fail() { echo "PUBLISH FAILED: $*" >&2; exit 1; }

command -v gh >/dev/null || fail "gh CLI not available"

# Defense in depth: the workflow derives the version from a numeric run
# counter, but this script consumes VERSION/TAG as arguments too — refuse
# anything that is not exact numeric semver before any gh call.
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail "unsupported version '${VERSION}' (expected numeric semver X.Y.Z)"
[[ "$TAG" == "desktop-v${VERSION}" ]] || fail "tag '${TAG}' must be desktop-v<version> (version ${VERSION})"

# --- the release must not exist (releases/tags are immutable) ---------------
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  fail "release ${TAG} already exists — release tags are immutable and are never deleted or recreated. A run-number tag colliding means a workflow replay or a hand-pushed tag; investigate before releasing again."
fi

# --- the synthesized tag must not exist either ------------------------------
# desktop-v1.0.<run_number> is unique per workflow run by construction. If the
# ref already exists it points at a commit we did not build (or a run is
# being replayed) — fail closed rather than publishing onto or moving it.
if gh api "repos/${REPO}/git/ref/tags/${TAG}" >/dev/null 2>&1; then
  fail "tag ${TAG} already exists on the remote — synthesized run-number tags must be unique; refusing to publish onto an existing ref"
fi

# --- release notes: resolved against the INVOCATION directory, not the ----
# artifacts dir. The app-release workflow writes release-notes.md at the
# repository root and passes a relative path, while this script cd's into the
# artifacts dir below — so anchor a relative path to the directory the script
# was invoked from (repo root in the workflow) BEFORE changing directory.
NOTES_ARGS=()
if [[ -n "${RELEASE_NOTES_FILE:-}" ]]; then
  NOTES_PATH="${RELEASE_NOTES_FILE}"
  if [[ "$NOTES_PATH" != /* ]]; then
    NOTES_PATH="${PWD}/${NOTES_PATH}"
  fi
  [[ -f "$NOTES_PATH" ]] || fail "RELEASE_NOTES_FILE not found: ${RELEASE_NOTES_FILE} (resolved to ${NOTES_PATH})"
  NOTES_ARGS=(--notes-file "$NOTES_PATH")
fi

cd "$ARTIFACTS_DIR" || fail "artifacts dir not found: ${ARTIFACTS_DIR}"

TITLE="${RELEASE_TITLE:-PhantomChat Desktop ${VERSION} (preview)}"

# Artifact list mirrors REQUIRED_ARTIFACTS in scripts/promote-release.sh —
# the Windows and macOS PRs grow both places together.
gh release create "$TAG" \
  --repo "$REPO" \
  --prerelease \
  --target "$COMMIT" \
  --title "$TITLE" \
  "${NOTES_ARGS[@]}" \
  "PhantomChat-${VERSION}.AppImage" "phantomchat_${VERSION}_amd64.deb" "SHA256SUMS.txt" \
  || fail "gh release create failed for ${TAG}"
