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

Promotion is a reviewed PR changing stableRef and stableVersion together. Neither
merging a feature PR nor publishing Preview changes the Stable source pin. The
normal Pages deployment still publishes the combined site; do not manually deploy
a feature branch as a substitute for the channel pipeline. Andrew owns deployment.

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

The selector is intentionally available to end users: volunteers opt into Preview
on their existing identity. The Stable SHA pins the frontend only; both frontend
channels run inside the candidate Electron shell, controlled by the existing
independent desktop binary update ring. Native shell changes require compatibility
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
