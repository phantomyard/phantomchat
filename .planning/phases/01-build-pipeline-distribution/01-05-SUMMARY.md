---
phase: 01-build-pipeline-distribution
plan: 05
subsystem: infra
tags: [github-actions, ipfs, pinata, ipfs-deploy-action, censorship-resistance, cicd]

# Dependency graph
requires:
  - phase: 01-build-pipeline-distribution
    plan: 04
    provides: GitHub Actions workflow with build + Cloudflare Pages + GitHub Pages jobs
provides:
  - deploy-ipfs job in .github/workflows/deploy.yml pinning dist/ to IPFS via Pinata
  - Four-job CI/CD pipeline: build, deploy-cloudflare, deploy-github-pages, deploy-ipfs
  - IPFS content-addressed CID surfaced as GitHub commit status after each push
affects: [phase-02, phase-03, censorship-resistance, distribution]

# Tech tracking
tech-stack:
  added: [ipshipyard/ipfs-deploy-action@v1, Pinata IPFS pinning service]
  patterns: [single artifact shared across all deploy jobs, CID reported via GitHub commit status]

key-files:
  created: []
  modified: [.github/workflows/deploy.yml]

key-decisions:
  - "IPFS deploy uses ipshipyard/ipfs-deploy-action@v1 with Pinata as pinning backend — satisfies DIST-04 censorship resistance requirement"
  - "ENS/HNS decentralized domain deferred to future phase — HTTP gateway link sufficient for Phase 1"
  - "User will configure secrets (PINATA_JWT_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN) and enable GitHub Pages manually before first push"

patterns-established:
  - "Three-mirror distribution: Cloudflare Pages (CDN speed) + GitHub Pages (free fallback) + IPFS (censorship resistance)"
  - "All deploy jobs share a single build artifact — identical asset hashes on all mirrors, no rebuild per job"

requirements-completed: [DIST-04]

# Metrics
duration: checkpoint-gated (user approved after verifying workflow YAML correctness)
completed: 2026-03-31
---

# Phase 1 Plan 05: IPFS Deploy Job Summary

**IPFS deploy job added to GitHub Actions workflow using ipshipyard/ipfs-deploy-action@v1 with Pinata pinning, completing the three-mirror censorship-resistant distribution pipeline**

## Performance

- **Duration:** Checkpoint-gated (workflow YAML verified correct; infrastructure setup deferred to user)
- **Started:** 2026-03-31
- **Completed:** 2026-03-31
- **Tasks:** 2 (1 auto, 1 checkpoint)
- **Files modified:** 1

## Accomplishments

- Added `deploy-ipfs` job to `.github/workflows/deploy.yml` alongside existing build, deploy-cloudflare, and deploy-github-pages jobs
- Complete four-job CI/CD pipeline is now in place: build → (deploy-cloudflare, deploy-github-pages, deploy-ipfs) in parallel
- IPFS deploy pins `dist/` to Pinata and surfaces the CID as a GitHub commit status after every push to main
- Pipeline satisfies DIST-04: three independent mirrors with distinct failure domains (CDN, VCS-hosted, content-addressed)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add IPFS deploy job to GitHub Actions workflow** - `9293abb` (feat)
2. **Task 2: Checkpoint: Verify all three mirror deployments serve the PWA** - approved by user (infrastructure setup deferred)

## Files Created/Modified

- `.github/workflows/deploy.yml` - Added `deploy-ipfs` job using `ipshipyard/ipfs-deploy-action@v1` with Pinata JWT token and GitHub commit status reporting

## Decisions Made

- Used `ipshipyard/ipfs-deploy-action@v1` with Pinata as the IPFS pinning backend — matches research recommendation, free tier (1GB) sufficient for Phase 1
- ENS/HNS decentralized domain integration deferred to a future phase — HTTP gateway (`https://ipfs.io/ipfs/<CID>/`) satisfies DIST-04 for Phase 1
- User will manually configure GitHub secrets (`PINATA_JWT_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`) and enable GitHub Pages before first deployment push

## Deviations from Plan

None — plan executed exactly as written. The checkpoint was approved by user with acknowledgment that secrets and infrastructure setup will be done manually before first push.

## Issues Encountered

None. YAML validated successfully. Checkpoint verification (all three mirrors serving PWA) is contingent on user configuring secrets and pushing — approved as out-of-scope for automated verification.

## User Setup Required

Before the first push to main, the user must:

1. **Pinata account:** Create free account at https://app.pinata.cloud (no credit card, 1GB free)
   - Generate API Key: API Keys → New Key → Admin → copy JWT
   - Add to GitHub: Settings → Secrets and variables → Actions → `PINATA_JWT_TOKEN`

2. **Cloudflare Pages:** Existing setup from Plan 04
   - Secrets already documented: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

3. **GitHub Pages:** Settings → Pages → Source → GitHub Actions

4. **Verify after push:** All 4 jobs green in GitHub Actions; three mirror URLs load the Nostra.chat PWA

## Next Phase Readiness

- Complete four-job CI/CD pipeline ready; will activate on first push after secrets are configured
- Phase 1 distribution infrastructure is complete: build pipeline (01), vendor/TS fixes (01-02), static host config (01-03), Cloudflare+GH Pages deploy (01-04), IPFS deploy (01-05)
- Phase 2 (Identity/Nostr key management) can begin immediately — no pipeline blockers

---
*Phase: 01-build-pipeline-distribution*
*Completed: 2026-03-31*
