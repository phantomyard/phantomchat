---
phase: 4
slug: 1-1-messaging-e2e
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-01
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (via vite.config.ts) |
| **Config file** | vite.config.ts (test section at line 128) |
| **Quick run command** | `pnpm test src/tests/nostra/` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test src/tests/nostra/`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | MSG-01, MSG-04 | unit | `pnpm test src/tests/nostra/nip17-messaging.test.ts` | ❌ W0 | ⬜ pending |
| 04-01-02 | 01 | 1 | MSG-04 | unit | `pnpm test src/tests/nostra/nip17-giftwrap.test.ts` | ❌ W0 | ⬜ pending |
| 04-02-01 | 02 | 1 | MSG-05, MSG-06 | unit | `pnpm test src/tests/nostra/blossom-media.test.ts` | ❌ W0 | ⬜ pending |
| 04-03-01 | 03 | 2 | MSG-07 | unit | `pnpm test src/tests/nostra/delivery-tracker.test.ts` | ❌ W0 | ⬜ pending |
| 04-03-02 | 03 | 2 | MSG-02, MSG-08 | unit | `pnpm test src/tests/nostra/offline-queue.test.ts` | ✅ (extend) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/tests/nostra/nip17-messaging.test.ts` — stubs for MSG-01, MSG-04 (gift-wrap send/receive roundtrip)
- [ ] `src/tests/nostra/nip17-giftwrap.test.ts` — stubs for MSG-04 (seal pubkey verification, timestamp randomization)
- [ ] `src/tests/nostra/blossom-media.test.ts` — stubs for MSG-05, MSG-06 (encrypt/upload/download/decrypt roundtrip)
- [ ] `src/tests/nostra/delivery-tracker.test.ts` — stubs for MSG-07 (state machine transitions, receipt creation/parsing)
- [ ] Extend `src/tests/nostra/offline-queue.test.ts` — stubs for MSG-08 (gift-wrap flush path)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Photo renders inline in chat bubble | MSG-05 | Requires visual DOM rendering with media element | Send photo in dev mode, verify `<img>` renders in bubble |
| Video plays inline in chat bubble | MSG-06 | Requires video element playback interaction | Send video in dev mode, verify `<video>` plays in bubble |
| Message request section UX | MSG-01 | UI layout and interaction flow | Send message from unknown npub, verify "Richieste" section appears |
| Read receipt toggle in Settings | MSG-07 | Settings UI integration | Toggle "Conferme di lettura", verify no blue checks sent/received |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
