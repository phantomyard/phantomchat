# Same-origin release channels

`pnpm build` produces a complete pinned Stable app at `/` and a full candidate
app at `/preview/index.html`. Both retain the current origin, database names,
identity, localStorage and Electron profile. The small shared selector remembers
the choice; selecting Stable explicitly overrides the remembered Preview choice.
The canonical root manifest preserves the installed PWA identity. Electron ships
both bundles under the existing `app://localhost` origin; its binary update ring
remains independent of this frontend selector.

## Release contract

`scripts/channels/config.json` pins Stable to an immutable commit and its original
PWA version. Preview is the committed candidate HEAD. Every packaging/deploy path
uses `pnpm build`, including desktop CI. Checkout full history: Stable must be
available locally. Dependency-lock changes require exact-content compatibility approval too;
when locks differ, the pinned source receives an independent frozen install
without package lifecycle scripts. Stable never uses Preview’s dependency graph.

PWA promotion uses the manual artifact workflow described below. The source pin
still controls the independent frontend embedded in new Electron binaries.
Neither merging a feature PR nor publishing Preview promotes either product.
Andrew owns publication and promotion.

The build refuses non-presentation changes between Stable and Preview unless an
explicit compatibility approval records BOTH exact file SHA-256 hashes. This
covers all src/public JS, TS, JSON, HTML and deletions, not just known DB modules.
An approval is an engineering decision in the reviewed PR, never an automatically
generated baseline update. Before approving state-related code: exercise existing
data, writes in Preview followed by reads/writes in Stable, identities, groups,
read cursors, tombstones, folders/settings, encrypted keys and stored sync formats.
A changed schema version needs older-code reopening proof; otherwise it cannot
ship with shared state. The gate is conservative and cannot prove semantic safety.

Initial approvals cover the CSP builder, package build commands and the standalone channel selector: it writes a new
release-choice localStorage key and does not rewrite existing app state.
The packaging script applies a deliberately narrow shared infrastructure patch
to both source trees: independent asset caches, SW unregister filtering and
channel-local hard reload and Preview’s own version-yield marker. Upstream shape changes fail the patch, requiring review.
Media CacheStorage and all user databases remain shared. The old cachedAssets
bucket is left alone (no indiscriminate cache deletion).

## Verification

`pnpm check:channels` verifies committed candidates. Unit tests exercise the gate
and selector. Browser checks must use the combined production output, including
root → Preview → Stable, reload and remembered PWA launch. Desktop checks must use
the packaged app origin/profile on each supported OS; source-level tests alone do
not establish native runtime readiness. Do not call a release verified while those
checks remain outstanding.

`node scripts/channels/browser-smoke.mjs` checks desktop/mobile switching against
the combined output. After `node electron/build.mjs`, run
`xvfb-run -a node scripts/channels/electron-smoke.mjs` on Linux (omit xvfb on
native desktop runners). Both use disposable data and block live connections.
The build also runs real Stable/Preview MessageStore code against the same
IndexedDB fixture, including writes and cursor changes followed by Stable reopen.

The gate scans src/, public/, electron/, index.html, package.json and the
dependency lock. Root scripts/ and workflow files implement the gate/build itself
and require normal PR review; they are not self-approved by this content check.
Direct builder execution must use `pnpm build`. Without APP_VERSION, local Preview
is explicitly labelled with the pinned version plus `-preview-local`. Release and
CI builds supply the candidate version.

The selector is intentionally available to end users inside Settings → Updates (no floating
control over messaging), using the same Row/RadioField/RadioForm components as
the Electron updater: volunteers opt into Preview
on their existing identity. The Stable SHA pins the frontend only; both frontend
channels run inside the candidate Electron shell, controlled by the existing
independent desktop binary update ring, available through Updates → Desktop updates. Native shell changes require compatibility
review and native tests, but do not create a second pinned Electron executable.
Stable SHA/version must resolve to the same `phantomchat-v<version>` release tag.

The divergent dependency-lock install path is not exercised by this initial
release (both locks match). A future reviewed dependency change exercises the
independent install and all native build/runtime gates before it can deploy;
packages requiring postinstall work may fail that build and need an explicit
toolchain change. No successful build or compatibility guarantee is inferred
from merely approving the lock hash.

The runtime smokes now create a disposable identity through the real UI, decrypt
its real IndexedDB record with its non-exportable browser key after both switches,
and verify actual ChatAPI offline sends persisted by each channel remain readable
after returning to Stable. They do not claim relay delivery or bilateral messaging.

The shared application Updates tab is copied from the candidate into both build
trees, and the builder redirects the existing Updates row to it on web and desktop.
This deliberately updates channel navigation on pinned Stable without promoting
Preview app styling. The shell exposes routing only; it no longer injects a select
control into the main Settings page. Cosmetic compatibility entries cover only
colours/wallpapers, generated avatar palettes and filled-control contrast; no
schema, state version or stored-row format changes are approved by those entries.

Existing saved stock themes are rendered through a presentation-only palette
substitution in Preview. Custom accents, outgoing colours and wallpapers are
preserved; no saved preferences are rewritten. Returning to Stable restores its
original stock palette. The browser/native round trips assert both appearances
on the same identity, in addition to encrypted-key and message durability.

## Manual publication and promotion (replaces automatic releases)

Pushes and merges trigger no builds or publication. Pull requests run typechecks,
unit tests and archive/promotion regression tests only. Four Actions buttons own
publication; use Run workflow's branch picker to select any reviewed branch:

- `deploy.yml`: **PWA — build and publish Preview**. Builds the candidate and a
  separate promotion-ready candidate with Stable's asset-cache/build-marker
  namespace. Checks existing-data round trips, desktop/mobile browser switching,
  and both the original and promotion-ready combinations before Pages publication.
- `pwa-promote.yml`: **PWA — promote to Stable**. Optional `release` is a
  `pwa-v1.0.<PWA workflow run_number>` archive identifier. Empty selects the newest
  successfully published Preview by publication time, across all branches.
  Downloads and verifies the archive and publishes the prebuilt Stable variant;
  it never recompiles application code. Current Preview bytes are preserved.
- `app-release.yml`: **Electron — build and publish Preview**. Builds, verifies,
  signs/notarizes and publishes installers using the selected branch commit.
  Desktop versions are independently `1.1.<Electron workflow run_number>`;
  the minor bump prevents downgrade from the previous shared PWA counter.
  The candidate embedded frontend shares the binary version. No PWA workflow
  run is needed. Existing native packaging/signature/feed verification remains.
- `app-promote.yml`: **Electron — promote to Stable**. Optional `tag` selects a
  desktop Preview release. Empty selects the newest published, non-draft
  `phantomchat-v*` Preview across all branches. Existing checksum/artifact gates
  run before the same release becomes stable/latest; no rebuild or signing.

Each build button always builds **and publishes to Preview**. Promotion is a
separate explicit action. Merely merging this change does not dispatch anything.
The workflow files must exist on the default branch before GitHub offers their
manual buttons; the chosen branch must also contain the workflow implementation.
Only dispatch trusted, reviewed branches: release jobs have publication/signing
credentials and intentionally execute the selected branch's code.

PWA archives are durable GitHub **draft releases**, with `bundle.tar.gz` and
`SHA256SUMS.txt`, not expiring Actions artifacts. They remain drafts permanently:
normal published PWA releases/tags would pollute Electron's `releases.atom` feed.
A draft's JSON body records source/version, Stable source/version, Preview release,
operation and successful Pages publication time. Unpublished/failed candidates
are excluded from default selection. Never publish these drafts manually.
The archive includes the full site snapshot plus the already-built Stable
candidate, so promotion uses exact verified assets without path rewriting.
Preview publication preserves the last published Stable files byte-for-byte;
the initial publication bootstraps Stable from the reviewed source pin.

PWA publication and promotion share a non-cancelling concurrency group; desktop
publication and promotion share a separate one. GitHub may replace an older
pending dispatch when another is queued; inspect Actions before retrying.
If Pages succeeds but recording publication fails, the workflow fails visibly:
reconcile that successful deployment's archive record before another publication.
There is no automatic recovery deploy and no inference that a failed run shipped.

After a PWA promotion, the next Preview build checks compatibility against the
**actually deployed Stable source**, loaded from the last successful archive.
Exact-content compatibility approvals must be refreshed in a reviewed PR when
that baseline changes; stale approvals fail closed. Explicit older PWA promotion
also checks the selected Stable source against current Preview using the chosen
branch's reviewed exact-content approvals, then runs artifact browser round trips.
It never silently rolls Preview back. Archives with missing/corrupt assets or
unsafe paths/links fail before Pages publication. The original source pin remains
Electron's independent embedded Stable frontend baseline; changing PWA Stable
never changes an installed Electron binary.

Default Electron promotion never falls back to an older Preview when the newest
published desktop release is already Stable; it stops with an explicit message.
