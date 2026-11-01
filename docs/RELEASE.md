# Release & Deployment

PhantomChat's PWA and Electron apps have independent publication pipelines.
The full artifact/storage contract is in [RELEASE-CHANNELS.md](RELEASE-CHANNELS.md).

## Pipeline

The Actions sidebar lists five pipelines, each named for what it does and how
it starts:

- **PR checks — automatic on every PR** (`ci.yml`). PRs targeting `main` run `typecheck` and `test`, including
  release regression checks.
- **PWA 1. Build + deploy to Preview — automatic on merge** (`deploy.yml`). Builds/validates Preview
  and its promotion-ready Stable variant. Publishes the combined site to GitHub
  Pages while preserving the last published Stable bytes. Also has Run workflow
  for a reviewed branch.
- **PWA 2. Promote Preview to Stable — manual** (`pwa-promote.yml`). Optional `release`; blank
  selects newest successfully published PWA Preview. Verifies checksummed assets,
  publishes the prepared Stable variant and preserves current Preview. No rebuild.
- **Electron 1. Build + deploy to Preview — manual** (`app-release.yml`). Run workflow from `main`;
  no push or merge ever starts it, and other branches skip every job. Builds native
  apps, verifies runtime/packages, signs/notarizes and publishes a prerelease.
  It does not require or dispatch a PWA workflow.
- **Electron 2. Promote Preview to Stable — manual** (`app-promote.yml`). Optional `tag`; blank
  selects newest published Electron Preview. Verifies every required platform
  artifact and checksum before changing stable/latest metadata. No rebuild.

First merge the workflow definitions onto the default branch so GitHub offers
these buttons. The selected branch must contain the updated workflow. Dispatch
only reviewed branches: the selected code runs with publication/signing access.
Andrew owns publication and promotion; merging a PR publishes PWA Preview only.

## Versioning

PWA uses `1.0.<deploy workflow run_number>`; Electron independently uses
`1.1.<app-release workflow run_number>`. The minor bump prevents desktop version
regression from the previous PWA-shared counter. The embedded candidate frontend
and binary share the desktop release version; embedded Stable retains its source
pin's version. Do not hand-edit package.json or tags to ship.

Vite embeds APP_VERSION and emits `/version` and `/version.json` (separately
under `/preview/`). The installed PWA refreshes through its service worker and
in-app update prompt after a Pages publication. Local Preview builds
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

Default Electron promotion never falls back to an older Preview when the newest
published desktop release is already Stable; it stops with an explicit message.
