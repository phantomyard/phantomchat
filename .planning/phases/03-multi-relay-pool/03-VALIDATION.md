---
phase: 3
slug: multi-relay-pool
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-01
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (latest, via pnpm) |
| **Config file** | vitest implicit in vite.config.ts |
| **Quick run command** | `pnpm test src/tests/nostra/` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test src/tests/nostra/ -x`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 03-01-T1 | 01 | 1 | INF-03, INF-04, INF-06 | unit | `pnpm test src/tests/nostra/nip65.test.ts src/tests/nostra/relay-failover.test.ts -x` | ❌ W0 | ⬜ pending |
| 03-01-T2 | 01 | 1 | PRIV-01, PRIV-02 | unit | `pnpm test src/tests/nostra/privacy-transport.test.ts src/tests/nostra/tor-bootstrap.test.ts -x` | ❌ W0 | ⬜ pending |
| 03-02-T1 | 02 | 1 | PRIV-02 | tsc | `pnpm exec tsc --noEmit` | N/A | ⬜ pending |
| 03-02-T2 | 02 | 1 | PRIV-03 | unit | `pnpm test src/tests/nostra/tor-fallback-confirm.test.ts -x` | ❌ W0 | ⬜ pending |
| 03-03-T1 | 03 | 2 | INF-03, INF-04 | tsc | `pnpm exec tsc --noEmit` | N/A | ⬜ pending |
| 03-03-T2 | 03 | 2 | INF-03, INF-04 | unit | `pnpm test src/tests/nostra/nostr-relay-pool.test.ts -x` | Exists (extend) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/tests/nostra/relay-failover.test.ts` — stubs for INF-04 (one relay down, messages still deliver)
- [ ] `src/tests/nostra/nip65.test.ts` — stubs for INF-06 (kind 10002 build/parse/publish)
- [ ] `src/tests/nostra/privacy-transport.test.ts` — stubs for PRIV-01 (pool-level Tor HTTP polling)
- [ ] `src/tests/nostra/tor-bootstrap.test.ts` — stubs for PRIV-02 (progressive bootstrap, app interactive)
- [ ] `src/tests/nostra/tor-fallback-confirm.test.ts` — stubs for PRIV-03 (no auto-fallback, user confirmation)

*Existing: `src/tests/nostra/nostr-relay-pool.test.ts` covers INF-03 baseline — extend for 4+ relays*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Tor circuit creation via Snowflake WebRTC | PRIV-01 | Requires real network access + Snowflake proxy | Start app in browser, verify shield icon turns green, check Network tab for no direct relay connections |
| App interactive within 3s during Tor bootstrap | PRIV-02 | Timing-sensitive, requires real bootstrap | Cold start app, measure time to first chat list render |
| Banner appearance and dismiss/reappear behavior | PRIV-03 | Visual UI verification | Force Tor failure, verify orange banner appears, dismiss it, reopen app, verify banner reappears |
| Per-relay latency display in settings | INF-03 | Real network latency needed | Open Settings > Relay, verify each relay shows green/red dot + latency in ms |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
