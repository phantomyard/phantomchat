---
phase: 07
slug: disable-telegram-mtproto-remove-server-dependency
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-02
---

# Phase 07 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `pnpm test src/tests/nostra/` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~20 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test src/tests/nostra/`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 20 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 07-01-01 | 01 | 1 | SC-1 | integration | `pnpm test src/tests/nostra/` | ❌ W0 | ⬜ pending |
| 07-01-02 | 01 | 1 | SC-3 | unit | `pnpm test src/tests/nostra/` | ❌ W0 | ⬜ pending |
| 07-02-01 | 02 | 1 | SC-2 | integration | `pnpm test src/tests/nostra/` | ❌ W0 | ⬜ pending |
| 07-03-01 | 03 | 2 | SC-4 | integration | `pnpm test src/tests/nostra/` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/tests/nostra/mtproto-stub.test.ts` — tests for MTProto stub (no connections, invokeApi rejection)
- [ ] `src/tests/nostra/connection-status-relay.test.ts` — tests for relay-based ConnectionStatus
- [ ] `src/tests/nostra/boot-no-mtproto.test.ts` — tests for boot path without MTProto

*Existing vitest infrastructure covers framework requirements.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| No network requests to Telegram DCs | SC-1 | Requires network inspection | Open app, check DevTools Network tab for *.telegram.org or DC IPs |
| ConnectionStatus shows relay info | SC-2 | Visual rendering | Open app, verify status bar shows "Connected" from relay pool |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 20s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
