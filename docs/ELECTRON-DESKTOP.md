# PhantomChat Desktop (Electron)

Reference for the Electron desktop app — development, packaging, releases,
channels and installation. Part of issue #150; the web/PWA build is
unaffected and continues to deploy via GitHub Pages (`docs/RELEASE.md`).

## Architecture

- `electron/main.ts` — main process. Serves the packaged frontend through a
  private `app://` protocol (standard + secure, so the renderer gets a real
  origin and the immutable bundle never loads from a remote origin).
- `electron/preload.ts` — contextIsolation preload exposing exactly one
  narrow typed API, `window.phantomchatDesktop` (version, platform,
  https-only `openExternal`). No other IPC surface exists.
- `electron/desktopIntegration.ts` — AppImage menu integration
  (`phantomchat --install` / `--uninstall`).
- `electron/build.mjs` — esbuild bundling of main/preload + strict CSP
  generation (inline boot-splash scripts are pinned by sha256 hash at build
  time; no `unsafe-inline` for scripts).
- `electron-builder.yml` — Linux x64 AppImage/`.deb`, separate macOS Apple
  Silicon and Intel DMGs, and separate Windows x64 and ARM64 installers.

Security posture: `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`, permissions default-deny (only microphone, camera and
notifications are granted, and only to the app's own `app://` pages; see
`electron/permissions.ts`), navigation away from `app://`
blocked, window creation denied, https links handed to the OS browser, CSP
enforced on every `app://` response.

## Development

```bash
pnpm install
pnpm run app:dev          # vite dev server + electron window (hot reload)
pnpm run app:start        # production build loaded in electron, unpackaged
pnpm run typecheck:electron
```

## Packaging

### Linux

```bash
pnpm run app:build        # PWA build + electron bundle + AppImage/.deb into release/<version>/
pnpm run app:pack         # same but unpacked dir only (faster iteration)
```

Targets per issue #150: x64 **AppImage** and **.deb**. RPM, Snap and
Flatpak are deliberately out of scope for the first release. Artifacts are
unsigned (acceptable on Linux) and always ship with `SHA256SUMS.txt`.

**Local builds need `APP_VERSION`.** Without it the bundle bakes build 0.
A profile that has already run a release stores its build number, sees a
"newer" build was there before, and deactivates itself (the "another tab is
running a newer version" popup). Build local test packages with a version
at least as high as the installed one:
`APP_VERSION=1.0.<n> pnpm run app:build`.

The packaged UI is served from `app://localhost`. That scheme is registered
with `allowServiceWorkers` (see `electron/scheme.ts`), and the Cache API
store keys use a synthetic `https://phantomchat.invalid/` base there,
because Chromium's Cache API rejects `app://` request URLs.

### .deb install

```bash
sudo apt install ./phantomchat_<version>_amd64.deb
phantomchat
```

The package installs to `/opt/PhantomChat/` and uses electron-builder's
stock maintainer scripts, which put `phantomchat` on PATH
(`/usr/bin/phantomchat` via update-alternatives), set the `chrome-sandbox`
permissions, install and load the bundled AppArmor profile on Ubuntu 24+,
and undo all of it on `sudo apt remove phantomchat`. Do not add a custom
`afterInstall`/`afterRemove` in `electron-builder.yml`: it replaces the
stock scripts entirely (1.0.1 shipped with no command on PATH and a FATAL
sandbox abort on launch). CI installs the built `.deb` and checks all of
this via `scripts/check-deb-install.sh`.

If an already-installed 1.0.1 aborts on launch, either upgrade to a fixed
release or run once:
`sudo chmod 4755 /opt/PhantomChat/chrome-sandbox && sudo ln -sf /opt/PhantomChat/phantomchat /usr/bin/phantomchat`.

### AppImage menu integration

The AppImage runs without installation. To create an application-menu entry
(installs the icon to `~/.local/share/icons/hicolor/512x512/apps/` and a
launcher to `~/.local/share/applications/phantomchat.desktop`):

```bash
./PhantomChat-<version>.AppImage --install
```

`--uninstall` removes both files again. The `.deb` needs none of this — it
installs its own menu entry and is removed cleanly with
`sudo apt remove phantomchat`.

### macOS

Build on macOS so Electron Builder can create the DMG:

```bash
APP_VERSION=1.0.<n> pnpm run app:build:mac
APP_VERSION=1.0.<n> pnpm run app:pack:mac  # unpacked app, faster iteration
```

CI builds `PhantomChat-<version>-arm64.dmg` natively on Apple Silicon and
`PhantomChat-<version>-x64.dmg` natively on Intel. Each job mounts its DMG,
checks the bundle metadata and resources, and runs the packaged Electron
executable on the matching architecture before publication.

To install, open the DMG and drag **PhantomChat** to **Applications**. Remove
it by quitting the app and moving `/Applications/PhantomChat.app` to Trash;
user data remains under `~/Library/Application Support/PhantomChat` unless
removed separately.

Both DMGs are Developer ID signed, notarized by Apple and stapled, so a
quarantined download opens normally — no `xattr` dance. The CI package check
refuses to publish a DMG that fails `stapler validate`, `codesign --verify` or
`spctl --assess`.

### Windows

Build on Windows so Electron Builder can create the NSIS installers:

```powershell
$env:APP_VERSION = '1.0.<n>'
pnpm run app:build:win
pnpm run app:pack:win  # unpacked app, faster iteration
```

CI builds `PhantomChat-<version>-windows-x64.exe` on native x64 Windows and
`PhantomChat-<version>-windows-arm64.exe` on native Windows ARM64. On a fresh
host, each job silently installs its matching package, verifies the Start Menu
shortcut, launches the installed Electron runtime natively, and uninstalls it
cleanly before publication.

Run the matching installer and start **PhantomChat** from the Start Menu.
Uninstall it from **Settings → Apps → Installed apps**. User data remains under
`%APPDATA%\PhantomChat` unless removed separately.

These installers are Authenticode signed as **Andrew Hodges** (SSL.com
code-signing certificate, cloud HSM). Check it with
`Get-AuthenticodeSignature .\PhantomChat-<version>-windows-x64.exe`.
SmartScreen may still warn until the certificate accumulates reputation;
verify the published SHA-256 checksum before choosing **More info → Run
anyway**.

## Release channels (preview / stable)

Same release-ring model as PhantomBot — including the naming: releases
are cut automatically and tagged with the release workflow's own monotonic
run counter, never by hand.

1. **Every merge to main cuts a preview release.** The **app-release**
   workflow fires on each push to main (except docs-only merges) and
   publishes `phantomchat-v1.0.<N>`, where `<N>` is the run number of the
   PWA **deploy** run for the same commit, so the desktop app and the PWA
   from one merge show the same version. Run numbers never regress (PR
   numbers can); desktop versions skip numbers when a docs-only merge or a
   manual branch deploy bumps the PWA without a desktop release. The workflow builds
   from a clean checkout and publishes the artifacts + `SHA256SUMS.txt` as
   a GitHub **prerelease** — the preview channel. Stable users see
   nothing; `/releases/latest` does not return prereleases. The originating
   PR is preserved in the release title and notes.
2. **Promote to stable** via the **app-promote** workflow (tag optional —
   defaults to the newest prerelease; pressing the button is the human act
   that makes it stable). Promotion:
   - verifies every required artifact is present on the release,
   - re-verifies every checksum (`sha256sum --strict`) and cross-checks that
     no artifact ships without a checksum,
   - then flips release metadata only: prerelease flag cleared, marked
     latest. **Nothing is rebuilt, re-signed, retagged or re-uploaded** — the
     exact artifacts tested on preview become stable.
   - Fails closed on any missing artifact or checksum mismatch.
3. **Rollback** = promote an older known-good tag by name (e.g.
   `phantomchat-v1.0.40`). Same metadata-only contract.

Required artifacts for promotion live in `scripts/promote-release.sh`
(`REQUIRED_ARTIFACTS`). Both macOS architectures (DMG *and* update zip) and
both Windows architectures are required, as are all three update feeds; promotion fails closed until the
full matrix exists, and also if a feed does not declare the tag's version.

## In-app updates (issue #164)

The rings above are only half the story: a ring the client cannot see is just
a label on a GitHub page. The desktop app picks a ring in
**Settings → Updates**, checks every **24 hours**, and installs in the
background where the platform allows it.

### Choosing a ring

| Ring | Resolves to | Who it is for |
|---|---|---|
| **Stable** (default) | `/releases/latest` — the release a human promoted | everyone |
| **Preview** | newest release including prereleases | dogfooding |

The ring lives in `update-settings.json` under the Electron `userData`
directory, **not** in the renderer: the first check runs before a window
exists, so `localStorage` could never be the source of truth.

Switching **Preview → Stable** is a *downgrade* in version terms (an installed
`1.0.50` preview against a `1.0.45` stable). electron-updater refuses to move
backwards unless told to, so the stable ring sets `allowDowngrade`. Without it
choosing Stable looks like it worked and then quietly keeps serving preview
builds until stable's counter overtakes. See `channelUpdaterFlags()` in
`electron/updateSettings.ts`.

### What each platform can actually do

| Platform | Behaviour |
|---|---|
| Windows (NSIS) | downloads and installs on quit |
| Linux (AppImage) | downloads and replaces the AppImage |
| Linux (.deb) | **notify only** — dpkg owns those files |
| macOS | downloads and installs on quit (Squirrel.Mac) |
| macOS, run from the DMG | **notify only** — read-only volume |

Auto-installing over a dpkg-managed file would desynchronise the package
database, so .deb stays notify-only permanently. macOS went auto in #169: the
app is Developer ID signed and notarized (Squirrel.Mac's hard precondition),
the release carries a `zip` for each architecture, and `latest-mac.yml` is
merged and published alongside the other feeds. The one macOS install that
stays notify-only is an app still running out of its mounted DMG — that volume
is read-only, so the bundle cannot be replaced in place (and the update would
be ejected with the image); the UI tells the user to drag the app to
Applications. On the notify-only path the app queries the GitHub
Releases API against the same ring and offers to open the release page.
`electron/updateCapability.ts` makes the decision; an unpackaged dev run is
always notify-only.

### The feed

`electron-builder.yml` carries a `publish:` provider. That is what makes
electron-builder write:

- `latest.yml` (Windows), `latest-mac.yml` (macOS) and `latest-linux.yml`
  (Linux) next to the artifacts — the feed clients read. They are produced during packaging, so `--publish
  never` in CI still yields them; CI *asserts* their presence on every PR
  rather than assuming it.
- `app-update.yml` inside the packaged resources — how an installed app knows
  where to look.

**macOS ships a zip as well as a DMG.** The DMG is what a human downloads;
the zip is what Squirrel.Mac installs. `MacUpdater` picks the payload with
`findFile(files, 'zip', ...)` and throws `ERR_UPDATER_ZIP_FILE_NOT_FOUND` when
the feed lists only a DMG, so a DMG-only release is a release nobody can
update from. Both come out of one `electron-builder --mac zip dmg` run, from
the same signed `.app`. After notarization the DMG is stapled, the `.app` is
stapled, and the zip is **rebuilt** from the stapled app with `ditto -c -k
--sequesterRsrc --keepParent` — notarization is per-cdhash so one submission
covers both containers, but a ticket is stapled to a container, and the
original zip was written before the ticket existed. Both rewrites change the
bytes, so `latest-mac.yml` is re-stamped on the runner before it is uploaded.

**Windows *and macOS* feeds must be merged.** `getUpdateInfoFileName()` in app-builder-lib
appends an architecture suffix **only on Linux**, so both Windows runners emit
a file literally called `latest.yml`, each describing only its own
architecture. macOS has the identical problem: both runners write
`latest-mac.yml`. Uploaded as-is, the second clobbers the first and every user
is offered the wrong architecture's build on their next update.
`scripts/merge-update-feed.mjs` combines them into one feed listing both, which
electron-updater resolves per-architecture by matching `process.arch` against
the file name. x64 is passed first because it is the fallback entry when no
architecture matches.

Differential ("delta") downloads are **disabled**: we publish the installers
and the feeds but not the `.blockmap` sidecars a delta needs, so leaving it on
would mean every update tries a 404'd delta before falling back.

### Provenance

On Windows the installer carries an Authenticode signature, so the OS itself
checks the publisher before anything runs. Everywhere else the only thing
binding a downloaded update to us is the `sha512` in the feed, fetched over TLS
from GitHub, which electron-updater verifies before installing — strictly
weaker than code signing. macOS closes that gap at download time instead: the
DMG is Developer ID signed and carries a stapled notarization ticket, so
Gatekeeper checks the publisher before the app ever runs — and the app inside
the update zip carries its own stapled ticket, so an auto-updated install
validates offline too.

Note that Authenticode rewrites the installer, so the feed has to be
re-stamped against the signed bytes (`scripts/restamp-update-feed.mjs`); a feed
carrying pre-signing hashes fails every Windows update on checksum
verification.

## Signing

### Windows — done

The two published NSIS installers are Authenticode signed with the SSL.com
eSigner cloud HSM, in the `publish` job of `app-release.yml`. CI secrets:

| Secret | Purpose |
|---|---|
| `ES_USERNAME` / `ES_PASSWORD` | SSL.com account |
| `ES_CREDENTIAL_ID` | which credential on that account signs — the account also holds a document-sealing "eSeal" credential that is marked *default*, so this is not optional |
| `ES_TOTP_SECRET` | seed CodeSignTool uses to mint the one-time code |

Design notes, because each one is a trap:

- **Signing runs on the Linux publish runner**, not on the Windows build
  runners. The private key is not downloadable — CodeSignTool only sends a
  digest — so the host OS is irrelevant, and this keeps `windows-11-arm` out of
  the JDK-plus-vendor-tool business.
- **At build, not at promote.** `app-promote.yml` never rebuilds; it flips an
  existing release to stable so the artifacts that soaked on preview are the
  ones stable installs. Signing at promote would mutate published assets and
  regenerate the feed on every promotion.
- **Installers only.** electron-builder's `sign` hook would also sign the app
  executable and the uninstaller inside each package, and cloud signing is
  metered per signing operation. The installer is what the browser hands to
  SmartScreen.
- **The feed must be re-stamped after signing** — see Provenance above.
- The vendor action is pinned to a **commit sha**, not a moving tag: it
  receives the signing credentials.

No private key or credential is ever committed to the repository.

### macOS — done

Each DMG is signed on its native runner with the Developer ID Application
certificate, then notarized and stapled before it is uploaded as an artifact.
The update zip built from the same `.app` gets the same treatment and is
verified separately by `scripts/check-macos-update-zip.sh`.

| Secret | Purpose |
|---|---|
| `APPLE_CSC_LINK` | Developer ID Application certificate, base64 `.p12` |
| `APPLE_CSC_KEY_PASSWORD` | `.p12` password |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | notarytool credentials |

The `macos` job asserts all five are present before packaging, so a missing
secret fails the release instead of quietly shipping an unsigned DMG. The
identity is pinned by name in `electron-builder.yml`, so a stray Keychain
certificate on a runner cannot be used by accident.

Three separate things have to hold, and the package check verifies each one:

1. **Signing** — `codesign --verify --deep --strict`, plus the expected
   `Authority=` line and the hardened-runtime flag.
2. **Notarization** — Apple scans the DMG (`notarytool submit --wait`). Since
   Catalina a signed-but-unnotarized app is still blocked.
3. **Stapling** — `stapler staple` attaches the ticket to the DMG so first
   launch works offline; `stapler validate` proves it.

The hardened runtime is required for notarization, and Electron needs the JIT,
unsigned-executable-memory and library-validation exceptions in
`electron/build/entitlements.mac.plist` to start under it.
