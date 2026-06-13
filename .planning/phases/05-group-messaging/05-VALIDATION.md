---
phase: 5
slug: group-messaging
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-03
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `pnpm test` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 05-01-01 | 01 | 1 | GRP-01 | unit | `pnpm test src/tests/nostra/group-store.test.ts` | W0 | pending |
| 05-01-02 | 01 | 1 | GRP-02 | unit | `pnpm test src/tests/nostra/group-crypto.test.ts` | W0 | pending |
| 05-02-01 | 02 | 2 | GRP-01, GRP-02 | unit | `pnpm test src/tests/nostra/group-chat-api.test.ts` | W0 | pending |
| 05-02-02 | 02 | 2 | GRP-03, GRP-04 | unit | `pnpm test src/tests/nostra/group-management.test.ts` | W0 | pending |
| 05-03-01 | 03 | 3 | GRP-01 | unit | `pnpm test src/tests/nostra/group-display.test.ts` | W0 | pending |
| 05-03-02 | 03 | 3 | GRP-01, GRP-03, GRP-04 | build+unit | `pnpm test src/tests/nostra/group-display.test.ts && pnpm build` | W0 | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `src/tests/nostra/group-store.test.ts` — stubs for GRP-01 (group creation, metadata storage)
- [ ] `src/tests/nostra/group-crypto.test.ts` — stubs for GRP-02 (multi-recipient NIP-17 wrapping)
- [ ] `src/tests/nostra/group-chat-api.test.ts` — stubs for GRP-01/GRP-02 (group message send/receive/routing)
- [ ] `src/tests/nostra/group-management.test.ts` — stubs for GRP-03/GRP-04 (add/remove/leave members)
- [ ] `src/tests/nostra/group-display.test.ts` — stubs for GRP-01 (injectGroupChat peerChat dialog, GroupAvatarInitials)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Group appears in chat list after creation | GRP-01 | UI rendering requires browser | Create group via UI, verify it appears in sidebar |
| Group info sidebar shows member list | GRP-01 | UI component integration | Tap group name, verify sidebar opens with members |
| Service messages render correctly | GRP-03/04 | Visual rendering | Add/remove member, verify centered gray bubble |
| Delivery indicators aggregate per-member | GRP-02 | UI state aggregation | Send message, verify check marks update as members receive |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
