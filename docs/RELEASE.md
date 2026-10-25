# Release & Deployment

PhantomChat's PWA and Electron apps have independent manual publication pipelines.
The full artifact/storage contract is in [RELEASE-CHANNELS.md](RELEASE-CHANNELS.md).

## Pipeline

PRs targeting `main` run `typecheck` and `test`, including release regression
checks. Pushes and merges run no builds and publish nothing.

Use Actions → Run workflow and select the desired reviewed branch:

- **PWA — build and publish Preview** (`deploy.yml`). Builds/validates Preview
  and its promotion-ready Stable variant. Publishes the combined site to GitHub
  Pages while preserving the last published Stable bytes.
- **PWA — promote to Stable** (`pwa-promote.yml`). Optional `release`; blank
  selects newest successfully published PWA Preview. Verifies checksummed assets,
  publishes the prepared Stable variant and preserves current Preview. No rebuild.
- **Electron — build and publish Preview** (`app-release.yml`). Builds native
  apps, verifies runtime/packages, signs/notarizes and publishes a prerelease.
  It does not require or dispatch a PWA workflow.
- **Electron — promote to Stable** (`app-promote.yml`). Optional `tag`; blank
  selects newest published Electron Preview. Verifies every required platform
  artifact and checksum before changing stable/latest metadata. No rebuild.

First merge the workflow definitions onto the default branch so GitHub offers
these buttons. The selected branch must contain the updated workflow. Dispatch
only reviewed branches: the selected code runs with publication/signing access.
Andrew owns publication and promotion; preparing/merging a PR does not authorize it.

## Versioning

PWA uses `1.0.<deploy workflow run_number>`; Electron independently uses
`1.1.<app-release workflow run_number>`. The minor bump prevents desktop version
regression from the previous PWA-shared counter. The embedded candidate frontend
and binary share the desktop release version; embedded Stable retains its source
pin's version. Do not hand-edit package.json or tags to ship.

Vite embeds APP_VERSION and emits `/version` and `/version.json` (separately
under `/preview/`). The installed PWA refreshes through its service worker and
in-app update prompt after a manual Pages publication. Local Preview builds
without APP_VERSION use the pinned Stable version plus `-preview-local`.

## No bare tags

Electron Preview's updater consumes the public `releases.atom` feed. An entry
without every desktop update feed/payload can poison Preview with 404s.
Only real `phantomchat-v*` desktop releases belong in that public feed.

PWA archives use durable **draft releases**, not expiring Actions artifacts.
They contain checksummed full-site snapshots and prepared Stable bundles. Keep
these drafts unpublished forever; never create standalone PWA git tags or publish
PWA releases. Their JSON audit records become eligible for selection only after
successful Pages publication. Failed/unpublished candidates are ignored.

The release namespace tests guard workflow tag creation and PWA draft isolation;
`publish-release.sh` validates the desktop namespace. Missing/corrupt assets or
unsafe archive paths fail before publication. No promotion rebuilds app code.

## Hosting and concurrency

Pages source is GitHub Actions. The custom domain in public/CNAME remains
https://chat.phantomyard.ai with Stable `/` and Preview `/preview/index.html`.
Both share identity and local databases. PWA publication/promotion serialize in
one concurrency group; Electron operations serialize independently.

PWA jobs need `pages:write`, `id-token:write` and `contents:write` for private
archive management. Electron publication/promotion need release write access.
No repository settings or live deployments are changed by merging the workflows.
