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

These interim DMGs are intentionally unsigned and unnotarized. On first
launch, Gatekeeper can report the quarantined app as damaged. After verifying
the published SHA-256 checksum and copying it to Applications, clear the
quarantine attribute with
`xattr -dr com.apple.quarantine /Applications/PhantomChat.app`, then launch
normally. This is temporary until the Axelera B.V. Developer ID and
notarization credentials are available.

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

These interim installers are intentionally unsigned. Windows SmartScreen may
warn that the publisher is unknown; verify the published SHA-256 checksum
before choosing **More info → Run anyway**. The warning goes away once the
Axelera B.V. Authenticode certificate is available.

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
(`REQUIRED_ARTIFACTS`). Both macOS architectures and both Windows architectures
are required; promotion fails closed until the full matrix exists.

## Signing (deferred — Axelera B.V.)

Unsigned for now per issue #150. `electron-builder.yml` explicitly sets the
macOS identity to `null` and disables Hardened Runtime, while CI also disables
identity auto-discovery; this prevents accidental signing with a runner or
developer Keychain identity. Reserved CI secret names for the signing PR:

| Secret | Purpose |
|---|---|
| `AXELERA_WINDOWS_SIGNING_PFX` | Axelera B.V. Authenticode certificate (base64) |
| `AXELERA_WINDOWS_SIGNING_PASSWORD` | PFX password |
| `AXELERA_MACOS_CERTIFICATE_P12` | Axelera B.V. Apple Developer signing certificate |
| `AXELERA_MACOS_CERTIFICATE_PASSWORD` | P12 password |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | Apple notarization |

No private key or credential is ever committed to the repository.

When the Apple credentials arrive, replace the explicit unsigned setting with
Developer ID signing, enable Hardened Runtime, import the P12 from CI secrets,
notarize using the Apple credentials, and staple both DMGs. The native matrix
and package checks stay unchanged.
