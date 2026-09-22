#!/usr/bin/env bash
# Publish a desktop-app preview release (issue #150 PR#1).
#
# Contract:
#  - Release tags are immutable: an existing release aborts the run; tags are
#    never deleted, recreated or moved.
#  - Tag-triggered runs: the pushed tag must resolve to exactly the commit
#    that was built — a tag pointing anywhere else is a hard failure.
#  - Manual runs: the synthesized desktop-v1.0.<run_number> tag does not exist
#    remotely yet. This script creates it pinned to the built commit — but
#    only when the tag is absent. If a tag of that name already exists it
#    must resolve to the same commit, otherwise the run fails closed.
#  - After this script's tag step, the tag provably exists and points at the
#    built commit, so `gh release create --verify-tag --target` can never
#    silently re-tag from the default branch on either trigger path.
#
# Usage:
#   scripts/publish-release.sh <tag> <version> <commit-sha> <tag|manual> \
#     <artifacts-dir> [owner/repo]
set -euo pipefail

TAG="${1:?usage: publish-release.sh <tag> <version> <commit-sha> <tag|manual> <artifacts-dir> [owner/repo]}"
VERSION="${2:?missing version}"
COMMIT="${3:?missing commit sha}"
TRIGGER="${4:?missing trigger (tag|manual)}"
ARTIFACTS_DIR="${5:?missing artifacts dir}"
REPO="${6:-${GITHUB_REPOSITORY:-phantomyard/phantomchat}}"

fail() { echo "PUBLISH FAILED: $*" >&2; exit 1; }

command -v gh >/dev/null || fail "gh CLI not available"
[[ "$TRIGGER" == "tag" || "$TRIGGER" == "manual" ]] || fail "unknown trigger '${TRIGGER}' (expected tag|manual)"

# Resolve a remote tag to the commit it points at. Follows annotated tags
# (object.type == "tag" → one extra hop to the underlying commit).
resolve_tag_commit() {
  local obj_sha obj_type
  obj_sha="$(gh api "repos/$REPO/git/ref/tags/$1" --jq '.object.sha' 2>/dev/null)" || return 1
  obj_type="$(gh api "repos/$REPO/git/ref/tags/$1" --jq '.object.type' 2>/dev/null)"
  if [[ "$obj_type" == "tag" ]]; then
    gh api "repos/$REPO/git/tags/$obj_sha" --jq '.object.sha' 2>/dev/null
  else
    printf '%s\n' "$obj_sha"
  fi
}

# --- the release must not exist (releases/tags are immutable) ---------------
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  fail "release ${TAG} already exists — release tags are immutable and are never deleted or recreated. Use a new desktop-v* tag."
fi

# --- the tag must exist and point at the built commit before publishing -----
if remote_commit="$(resolve_tag_commit "$TAG")"; then
  [[ "$remote_commit" == "$COMMIT" ]] || fail "tag ${TAG} points at ${remote_commit}, not the built commit ${COMMIT} — refusing to publish (tag drift)."
else
  if [[ "$TRIGGER" == "tag" ]]; then
    fail "tag ${TAG} not found on the remote — a tag-triggered run must have its tag present."
  fi
  # Manual run: the synthesized tag doesn't exist yet. Create it pinned to
  # the built commit. The create call itself fails if the ref appeared in
  # the meantime, so an existing tag is never silently moved.
  echo "Creating tag ${TAG} at ${COMMIT}..."
  gh api "repos/$REPO/git/refs" -f "ref=refs/tags/$TAG" -f "sha=$COMMIT" >/dev/null 2>&1 \
    || fail "failed to create tag ${TAG} (does the ref already exist?)"
  created_commit="$(resolve_tag_commit "$TAG")" || fail "tag ${TAG} not readable after creation"
  [[ "$created_commit" == "$COMMIT" ]] || fail "tag ${TAG} resolved to ${created_commit} after creation, expected ${COMMIT}"
fi

cd "$ARTIFACTS_DIR" || fail "artifacts dir not found: ${ARTIFACTS_DIR}"

# Artifact list mirrors REQUIRED_ARTIFACTS in scripts/promote-release.sh —
# the Windows and macOS PRs grow both places together.
gh release create "$TAG" \
  --repo "$REPO" \
  --verify-tag \
  --target "$COMMIT" \
  --prerelease \
  --title "PhantomChat Desktop ${VERSION} (preview)" \
  --notes "Desktop preview build ${VERSION} (Linux x64: AppImage + .deb, unsigned — SHA-256 checksums published).

Install and channel docs: docs/ELECTRON-DESKTOP.md.

**Preview channel:** this prerelease does not affect stable users.
Promote it with the **app-promote** workflow once tested." \
  "PhantomChat-${VERSION}.AppImage" "phantomchat_${VERSION}_amd64.deb" "SHA256SUMS.txt" \
  || fail "gh release create failed for ${TAG}"
