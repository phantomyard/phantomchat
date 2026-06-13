# Release & Deployment

Reference for the PhantomChat release pipeline. For day-to-day rules, see `CLAUDE.md`.

## Pipeline

PhantomChat is a static client-side PWA deployed to **GitHub Pages**.

- **`.github/workflows/ci.yml`** runs on every PR targeting `main`: `typecheck` (`tsc --noEmit`) and `test` (`vitest run`). Both are required status checks.
- **`.github/workflows/deploy.yml`** runs on every push to `main` (i.e. after a PR merges) and on manual `workflow_dispatch`. It builds the PWA, publishes `dist/` to GitHub Pages, and tags the release.

GitHub Pages serves the build at the custom domain in `public/CNAME` (`chat.phantomyard.ai`) and auto-provisions the Let's Encrypt certificate once DNS resolves — no Terraform/ACM, the same pattern as `phantombot.bot`.

## Versioning

Scheme: **`1.0.<build_number>`**, matching phantombot.

- CI sets `APP_VERSION=1.0.${{ github.run_number }}` for the build. `github.run_number` is a monotonic per-workflow counter that never regresses.
- Vite bakes `APP_VERSION` into the bundle (`import.meta.env.VITE_VERSION` / `VITE_VERSION_FULL`) and emits two endpoints into `dist/`:
  - **`/version`** — plain text, e.g. `1.0.42`. Polled by the sidebar update-available check; when it differs from the running build, the in-app "Update" button appears (a plain reload to the freshly-deployed bundle).
  - **`/version.json`** — `{"version":"1.0.42","builtAt":"…"}`, a curlable health/release endpoint.
- The version is shown in-app on the Settings screen ("PhantomChat 1.0.42").
- After a successful deploy, the `tag` job pushes a `v1.0.<build_number>` git tag.

Local/dev builds fall back to the `package.json` version (`1.0.0`) when `APP_VERSION` is unset.

`build:release` differs from `build` only by a `pnpm run update-tor-consensus` prelude that refreshes `public/webtor/*.br.bin` against live Tor directory authorities; `build` uses the committed snapshot so local builds stay reproducible without network access.

## Live URL

| | URL |
|---|---|
| Production | https://chat.phantomyard.ai |

## No self-update / signed-manifest system

PhantomChat does **not** ship a trust-minimized / signed self-update channel. Updates are delivered the normal PWA way: a new push to `main` rebuilds and redeploys, the service worker picks up the new hashed bundle, and the sidebar update button (driven by the `/version` poll) prompts a reload. There is no update manifest, no signing key, no IPFS/mirror cross-checking, and no consent-gated update popup — that subsystem (inherited from the upstream fork) was removed.

## Repo Settings

- Branch protection on `main` wires `typecheck` and `test` as required status checks.
- Pages source: **GitHub Actions** (set under Settings → Pages).
- The `deploy` job needs `pages: write` + `id-token: write`; the `tag` job needs `contents: write`. Both are scoped per-job in `deploy.yml`.
