# Phase 2b.1 — 2-Device Manual Verification

Complete all steps on 2 real devices (Device A, Device B) with distinct identities, connected to the same set of relays (default config or a shared test relay). Run in production build (`pnpm build && pnpm serve` or deployed ipfs.nostra.chat), NOT dev mode — dev-only Vite gotchas can mask real bugs.

## Setup

- [ ] Device A: onboard new identity (name: "Alice-2B1").
- [ ] Device B: onboard new identity (name: "Bob-2B1").
- [ ] Each device adds the other as a contact via QR exchange or Add Contact.
- [ ] Exchange 3 test messages to warm the chat cache (so reactions attach to real messages, not synthetic fixtures).

## Reactions RX

- [ ] **1. A reacts 👍 on a message from B.** Within 3 s, B's DOM shows 👍 on that bubble.
- [ ] **2. A adds ❤️ on the same bubble.** B's DOM shows both 👍 + ❤️ within 3 s.
- [ ] **3. A removes 👍 (tap the reaction to toggle off).** B's DOM shows only ❤️ within 3 s.
- [ ] **4. B reacts 🔥 on a message from A.** Within 3 s, A's DOM shows 🔥 on that bubble.
- [ ] **5. Both A and B react 👍 on the same message from A.** Both DOMs show 👍 count=2.

## Regression — 5 FINDs closed

- [ ] **6.** Send many rapid text messages trailing a whitespace (`"hi "`). Bubble appears immediately on sender. (FIND-9df3527d, f7b0117c)
- [ ] **7.** Scroll chat history up and down repeatedly. No `"cleanups created outside a createRoot"` warning in console. (FIND-2f61ff8b)
- [ ] **8.** Send a message then immediately delete it. No `center_icon` console error. (FIND-2fda8762)
- [ ] **9.** React to a bubble then scroll. No `wrapSticker 'sticker'` console error. (FIND-7fd7bc72)

## Result

- [ ] Every box above is checked.
- [ ] No console errors (non-allowlisted) observed throughout.

Report on the PR: `PASS 2B.1 manual` or specific checkbox that failed + logs.
