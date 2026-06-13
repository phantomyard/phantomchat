# Release & Deployment

Detailed reference for the Nostra.chat release pipeline. For the day-to-day rules, see the "Release & Deployment" section in `CLAUDE.md`.

## Pipeline

`.github/workflows/deploy.yml` triggers **only** on `push: tags: v*`. Daily commits to `main` do NOT run CI or deploy — `main` is unprotected, push directly. Tag push runs `pnpm lint` → `npx tsc --noEmit` → `pnpm build:release` as a server-side gate, then publishes to 4 mirrors. `build:release` differs from `build` only by a `pnpm run update-tor-consensus` prelude that refreshes `public/webtor/*.br.bin` against live directory authorities; `build` uses the committed snapshot so local dev builds stay reproducible without network access to Tor dir auths.

**Do NOT re-add `push: branches: main` or `pull_request:` triggers** — the pipeline is intentionally tag-triggered so every production update flows through a version tag.

## Live Mirrors

| Mirror | URL |
|---|---|
| Cloudflare (primary) | https://nostra.chat |
| Cloudflare fallback | https://nostra-chat.pages.dev |
| GitHub Pages | https://nostra-chat.github.io/nostra-chat/ |
| IPFS (stable via DNSLink) | https://ipfs.nostra.chat |
| IPFS (raw CID) | CID per release, pinned on Filebase |

## Two Release Paths

1. **release-please PR** — merge the open `chore(main): release X.Y.Z` PR that release-please maintains. Creates the tag and triggers deploy with full CHANGELOG. **Do NOT enable auto-merge** on this PR — it accumulates commits, merge it manually when you want to release.
2. **Local `pnpm version patch|minor|major`** — `preversion` runs lint + tsc locally, bumps `package.json`, tags, `postversion` auto-pushes commit + tag.

Never edit `package.json` version or `CHANGELOG.md` manually — one of the two paths always owns them.

## Conventional Commits

| Prefix | Effect |
|---|---|
| `feat:` / `fix:` / `perf:` / `revert:` | Bump version, shown in changelog |
| `docs:` / `chore:` / `style:` / `build:` / `ci:` / `refactor:` / `test:` | Hidden from changelog, non-releasing |
| `feat!:` or `BREAKING CHANGE:` footer | Major bump |

## CI Gotchas

- **release-please PRs don't trigger CI** (`GITHUB_TOKEN` anti-recursion). Under tag-triggered deploy this is harmless — merge immediately.
- **`deploy-ipfs` job permissions**: needs explicit `permissions: contents: read, statuses: write`. Without `statuses: write` the IPFS upload succeeds but the job fails when posting the CID as a commit status.
- **Pinata rejected**: `ipshipyard/ipfs-deploy-action@v1` rejects Pinata as sole provider and requires a CAR upload provider (Filebase works). Do not re-add Pinata.

## IPFS Stable URL (DNSLink via dweb.link)

Raw IPFS CIDs change at every build. `https://ipfs.nostra.chat` gives a stable URL by combining:

1. **Filebase pin** — `deploy-ipfs` job uploads the CAR and Filebase announces the CID to the DHT.
2. **DNSLink TXT record** — updated automatically by the workflow step `Update DNSLink on Cloudflare` after each deploy.
3. **`dweb.link` public gateway** — resolves DNSLink and serves the content over HTTPS, free, no SLA.
4. **Cloudflare proxy** — terminates TLS on `ipfs.nostra.chat` with a Cloudflare cert, reverse-proxies to `dweb.link`.

### One-time DNS setup on Cloudflare

Zone `nostra.chat`:

| Type | Name | Content | Proxy | TTL |
|---|---|---|---|---|
| CNAME | `ipfs` | `ipfs.nostra.chat.ipns.dweb.link.` | ON (orange cloud) | Auto |
| TXT | `_dnslink.ipfs` | `dnslink=/ipfs/<placeholder>` | — | 60 |

The TXT record's content is overwritten at every release by the CI step — the placeholder is only needed so the record exists at first run. SSL/TLS mode must be **Full** (not Flexible).

### One-time Cloudflare API token

Create a scoped token at Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom:

- Permissions: **Zone → DNS → Edit**
- Zone Resources: **Include → Specific zone → `nostra.chat`**

Store as `CLOUDFLARE_DNS_API_TOKEN` secret (separate from `CLOUDFLARE_API_TOKEN` which is scoped to Pages). The zone ID (dashboard → zone overview → API section) goes into `CLOUDFLARE_ZONE_ID`.

### Rate limits & fallback

`dweb.link` has undocumented per-IP rate limits. If users hit 429s, change the CNAME to `cf-ipfs.com` or swap in a paid gateway (Cloudflare Web3, Filebase dedicated). No CI change needed — only the CNAME.

## Required Secrets

| Secret | Used by | Notes |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `deploy-cloudflare` | Pages deployment token |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy-cloudflare` | |
| `CLOUDFLARE_DNS_API_TOKEN` | `deploy-ipfs` (DNSLink step) | Zone → DNS → Edit on `nostra.chat` |
| `CLOUDFLARE_ZONE_ID` | `deploy-ipfs` (DNSLink step) | Zone ID for `nostra.chat` |
| `FILEBASE_ACCESS_KEY` / `FILEBASE_SECRET_KEY` / `FILEBASE_BUCKET` | `deploy-ipfs` | IPFS pinning |

## Repo Settings

- Settings → Actions → General → Workflow permissions: **"Allow GitHub Actions to create and approve pull requests" MUST stay enabled** or release-please can't open its release PR.
- "Allow auto-merge" is on and usable on feature PRs via `gh pr merge N --auto --squash --delete-branch`. Never on the release-please release PR.

## Phase A Controlled Updates — Pre-release checklist

Before cutting a release that touches the Phase A update flow, manually verify:

- [ ] First install in fresh Chrome → SW registered, no popup
- [ ] First install in fresh Firefox → idem
- [ ] First install in fresh Safari → idem (verify `updateViaCache` respected)
- [ ] Simulated upgrade in Chrome (local mock manifest with higher version) → popup appears with changelog
- [ ] Simulated upgrade in Safari → idem
- [ ] "Più tardi" → close tab → reopen → popup reappears
- [ ] Block nostra.chat in DevTools → verdict falls to verified-partial (2 sources)
- [ ] Go fully offline → no popup, no warning
- [ ] Settings → Aggiornamenti → "Check for updates" → spinner → result
- [ ] With Tor enabled → boot does not fetch anything before PrivacyTransport.settled
- [ ] With Tor enabled → after settled, check fires via webtor
- [ ] PWA installed (home screen) → flow identical
- [ ] Mid-download network drop → state recovers, no orphan register
- [ ] Cross-source conflict scenario → Aggiorna button disabled

Run E2E suite as part of the gate:
```bash
pnpm start &
pnpm test:e2e src/tests/e2e/e2e-update-controlled.ts
```
