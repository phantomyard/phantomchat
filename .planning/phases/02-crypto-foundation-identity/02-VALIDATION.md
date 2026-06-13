---
phase: 2
slug: crypto-foundation-identity
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-01
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (via pnpm test) |
| **Config file** | vitest.config.ts (jsdom environment, globals: true) |
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
| 02-01-01 | 01 | 0 | IDEN-01 | unit | `pnpm test src/tests/nostra/nostr-identity.test.ts -t "NIP-06"` | ❌ W0 | ⬜ pending |
| 02-01-02 | 01 | 0 | IDEN-06 | unit | `pnpm test src/tests/nostra/key-storage.test.ts` | ❌ W0 | ⬜ pending |
| 02-01-03 | 01 | 0 | MSG-03 | unit | `pnpm test src/tests/nostra/nip44-crypto.test.ts` | ❌ W0 | ⬜ pending |
| 02-01-04 | 01 | 0 | IDEN-02 | integration | `pnpm test src/tests/nostra/onboarding-npub.test.ts` | ❌ W0 | ⬜ pending |
| 02-01-05 | 01 | 0 | IDEN-03 | unit | `pnpm test src/tests/nostra/nip05.test.ts` | ❌ W0 | ⬜ pending |
| 02-01-06 | 01 | 0 | IDEN-04 | unit | `pnpm test src/tests/nostra/qr-identity.test.ts` | ❌ W0 | ⬜ pending |
| 02-01-07 | 01 | 0 | IDEN-05 | integration | `pnpm test src/tests/nostra/add-contact.test.ts` | ❌ W0 | ⬜ pending |
| 02-01-08 | 01 | 0 | — | unit | `pnpm test src/tests/nostra/migration.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/tests/nostra/nostr-identity.test.ts` — NIP-06 derivation with test vectors, npub/nsec encoding
- [ ] `src/tests/nostra/key-storage.test.ts` — AES-GCM encrypt/decrypt roundtrip, PBKDF2 key derivation
- [ ] `src/tests/nostra/nip44-crypto.test.ts` — NIP-44 encrypt/decrypt, conversation key derivation
- [ ] `src/tests/nostra/onboarding-npub.test.ts` — Onboarding UI shows npub not seed
- [ ] `src/tests/nostra/nip05.test.ts` — NIP-05 kind 0 event creation, verification
- [ ] `src/tests/nostra/qr-identity.test.ts` — QR contains valid npub string
- [ ] `src/tests/nostra/add-contact.test.ts` — npub parse, virtual peer creation
- [ ] `src/tests/nostra/migration.test.ts` — OwnID to npub migration preserves data

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| QR camera scan works | IDEN-04 | Requires real camera hardware | Open app on mobile, tap QR scan, verify camera opens and decodes npub |
| CryptoKey survives browser update | IDEN-06 | Requires real browser update | Store key, update browser, verify key still decrypts |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
