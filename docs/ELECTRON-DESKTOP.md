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
- `electron-builder.yml` — packaging (PR#1: Linux x64 AppImage + `.deb`).

Security posture: `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`, permission requests denied, navigation away from `app://`
blocked, window creation denied, https links handed to the OS browser, CSP
enforced on every `app://` response.

## Development

```bash
pnpm install
pnpm run app:dev          # vite dev server + electron window (hot reload)
pnpm run app:start        # production build loaded in electron, unpackaged
pnpm run typecheck:electron
```

## Packaging (Linux — PR#1)

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

## Release channels (preview / stable)

Same release-ring model as PhantomBot — including the naming: releases
are cut automatically and tagged with the release workflow's own monotonic
run counter, never by hand.

1. **Every merge to main cuts a preview release.** The **app-release**
   workflow fires on each push to main (except docs-only merges) and
   publishes `phantomchat-v1.0.<run_number>` — the workflow's per-run counter,
   the same scheme phantombot uses for `v1.1.<run_number>` and the PWA
   deploy uses for its `APP_VERSION`. Run numbers never regress (PR numbers
   can), and each one maps to exactly one Actions run. The workflow builds
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
(`REQUIRED_ARTIFACTS`); the Windows/macOS PRs append their artifacts there
so promotion fails closed until the full matrix exists.

## Signing (deferred — Axelera B.V.)

Unsigned for now per issue #150. Reserved CI secret names for the Windows
and macOS PRs:

| Secret | Purpose |
|---|---|
| `AXELERA_WINDOWS_SIGNING_PFX` | Axelera B.V. Authenticode certificate (base64) |
| `AXELERA_WINDOWS_SIGNING_PASSWORD` | PFX password |
| `AXELERA_MACOS_CERTIFICATE_P12` | Axelera B.V. Apple Developer signing certificate |
| `AXELERA_MACOS_CERTIFICATE_PASSWORD` | P12 password |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | Apple notarization |

No private key or credential is ever committed to the repository.

## Windows / macOS (upcoming PRs)

The same repo structure (main + preload + build script + workflows) is
reused; platform PRs add their electron-builder targets, workflow jobs,
install/uninstall docs and the signing wiring above. Iteration happens
against the GitHub Actions runners (`windows-latest`, `macos-latest`).
