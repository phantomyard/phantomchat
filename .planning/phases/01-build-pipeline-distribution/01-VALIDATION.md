---
phase: 1
slug: build-pipeline-distribution
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-01
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 0.34.6 |
| **Config file** | `vite.config.ts` (test section) |
| **Quick run command** | `pnpm test src/tests/` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test src/tests/`
- **After every plan wave:** Run `pnpm build` (exits 0) + `pnpm test`
- **Before `/gsd:verify-work`:** `pnpm build` exits 0 with TypeScript checker enabled
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 01-01-T1 | 01-01 | 1 | DIST-01 | unit | `pnpm test src/tests/vendor-stubs.test.ts` | ❌ W0 | ⬜ pending |
| 01-01-T2 | 01-01 | 1 | DIST-01, DIST-05 | smoke | `pnpm build` (exits 0 = pass) | ✅ | ⬜ pending |
| 01-02-T1 | 01-02 | 2 | DIST-01 | smoke | `pnpm build` (exits 0 with TypeScript checker = pass) | ✅ | ⬜ pending |
| 01-02-T2 | 01-02 | 2 | DIST-01 | smoke | `pnpm build 2>&1 \| tail -20` | ✅ | ⬜ pending |
| 01-03-T1 | 01-03 | 1 | DIST-02, DIST-05 | smoke | `grep -c "Cross-Origin-Opener-Policy" public/_headers` | ❌ W0 | ⬜ pending |
| 01-03-T2 | 01-03 | 1 | DIST-02 | smoke | `grep -c "sessionStorage" public/404.html` | ❌ W0 | ⬜ pending |
| 01-03-CP | 01-03 | 1 | DIST-02 | manual | Chrome DevTools → Application → Manifest (installability) + Offline checkbox | N/A | ⬜ pending |
| 01-04-T1 | 01-04 | 3 | DIST-03 | smoke | `grep -c "wrangler-action\|deploy-pages" .github/workflows/deploy.yml` | ❌ W0 | ⬜ pending |
| 01-05-T1 | 01-05 | 4 | DIST-04 | smoke | `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml'))" && grep -c "ipfs-deploy-action" .github/workflows/deploy.yml` | ❌ W0 | ⬜ pending |
| 01-05-CP | 01-05 | 4 | DIST-03, DIST-04 | manual | GitHub Actions → all 4 jobs green; Cloudflare/GitHub/IPFS URLs load app | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/tests/vendor-stubs.test.ts` — stubs for DIST-01: verify each critical stub exports expected API shape
- [ ] `src/tests/build-output.test.ts` — stubs for DIST-05: verify no absolute origin URLs in dist/

*Smoke tests for DIST-03/04 are post-deploy checks, not pre-commit — run manually after CI deploys*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| PWA manifest valid + installable | DIST-02 | Requires real browser to check install prompt | Chrome DevTools > Application > Manifest > check "Installability" |
| Service worker registers + caches offline shell | DIST-02 | Requires browser network interception | Chrome DevTools > Application > Service Workers > check "Offline" checkbox > reload |
| All three mirror URLs load app | DIST-03, DIST-04 | Requires live CI deploy to real CDN/IPFS | Push to main, wait for all 4 jobs green, visit each mirror URL |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
