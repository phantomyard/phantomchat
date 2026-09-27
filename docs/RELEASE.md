# Release & Deployment

Reference for the PhantomChat release pipeline. For day-to-day rules, see `CLAUDE.md`.

## Pipeline

PhantomChat is a static client-side PWA deployed to **GitHub Pages**.

- **`.github/workflows/ci.yml`** runs on every PR targeting `main`: `typecheck` (`tsc --noEmit`) and `test` (`vitest run`). Both are required status checks.
- **`.github/workflows/deploy.yml`** runs on every push to `main` (i.e. after a PR merges) and on manual `workflow_dispatch`. It builds the PWA and publishes `dist/` to GitHub Pages. It creates **no git tag** — see [No bare tags](#no-bare-tags).

GitHub Pages serves the build at the custom domain in `public/CNAME` (`chat.phantomyard.ai`) and auto-provisions the Let's Encrypt certificate once DNS resolves — no Terraform/ACM, the same pattern as `phantombot.bot`.

## Versioning

Scheme: **`1.0.<build_number>`**, matching phantombot.

- CI sets `APP_VERSION=1.0.${{ github.run_number }}` for the build. `github.run_number` is a monotonic per-workflow counter that never regresses.
- Vite bakes `APP_VERSION` into the bundle (`import.meta.env.VITE_VERSION` / `VITE_VERSION_FULL`) and emits two endpoints into `dist/`:
  - **`/version`** — plain text, e.g. `1.0.42`. Polled by the sidebar update-available check; when it differs from the running build, the in-app "Update" button appears (a plain reload to the freshly-deployed bundle).
  - **`/version.json`** — `{"version":"1.0.42","builtAt":"…"}`, a curlable health/release endpoint.
- The version is shown in-app on the Settings screen ("PhantomChat 1.0.42").
- A deploy creates **no git tag**; the version lives only in the bundle and the `/version` endpoints. The only tags in this repo are the desktop release tags `phantomchat-v1.0.<build_number>`, created by `app-release.yml`. See [No bare tags](#no-bare-tags).

Local/dev builds fall back to the `package.json` version (`1.0.0`) when `APP_VERSION` is unset.

`build:release` differs from `build` only by a `pnpm run update-tor-consensus` prelude that refreshes `public/webtor/*.br.bin` against live Tor directory authorities; `build` uses the committed snapshot so local builds stay reproducible without network access.

## No bare tags

**Invariant: no workflow in this repo may create or push a git tag outside the
`phantomchat-v*` namespace.** `deploy.yml` used to push a bare
`v1.0.<run_number>` tag after every PWA deploy. Such a tag has no release and no
assets behind it, but it still shows up in GitHub's `releases.atom` feed — and
electron-updater's prerelease path (the Preview channel sets `allowPrerelease`)
takes the **first atom entry** without checking that a release exists, then
fetches `releases/download/<that tag>/latest-mac.yml` and gets a 404. A PWA
deploy lands well before the matching desktop release publishes, so one such tag
poisons the Preview channel on every platform until the next real release. The
stable channel resolves `/releases/latest`, which skips tags with no release, so
only Preview broke — that asymmetry is the fingerprint of this bug.

Two independent layers enforce it:

- `src/tests/releaseTagNamespace.test.ts` fails if any workflow contains a
  non-comment `git tag` or `git push … origin`, if `deploy.yml` grants
  `contents: write`, or if `app-release.yml` stops namespacing the tag it hands
  to `publish-release.sh`.
- `scripts/publish-release.sh` refuses a `TAG` that is not `phantomchat-v*`.

Do not re-add a tag job to `deploy.yml`, and do not grant it `contents: write`.
The in-bundle version comes from `APP_VERSION`/`github.run_number`, so nothing
depends on a deploy-time tag.

## Live URL

| | URL |
|---|---|
| Production | https://chat.phantomyard.ai |

## No self-update / signed-manifest system

PhantomChat does **not** ship a trust-minimized / signed self-update channel. Updates are delivered the normal PWA way: a new push to `main` rebuilds and redeploys, the service worker picks up the new hashed bundle, and the sidebar update button (driven by the `/version` poll) prompts a reload. There is no update manifest, no signing key, no IPFS/mirror cross-checking, and no consent-gated update popup — that subsystem (inherited from the upstream fork) was removed.

## Repo Settings

- Branch protection on `main` wires `typecheck` and `test` as required status checks.
- Pages source: **GitHub Actions** (set under Settings → Pages).
- The `deploy` job needs `pages: write` + `id-token: write` only. `deploy.yml` grants **no** `contents: write` — it must not be able to push a tag.
