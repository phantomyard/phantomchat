# Phase 2a — Manual Verification Checklist

**Gate: 2-device manual sanity check before merge. Run on two real devices
(desktop + mobile, or two desktops) with distinct Nostra identities.**

## Setup

- Device A (sender-dominant)
- Device B (receiver-dominant)

Onboard both with fresh identities (`Create New Identity` → set display name →
Get Started). Confirm each sees the other in the contact list after QR/npub
exchange.

## Scenario 1 — Basic send/receive (baseline)

1. On A: send five text messages to B ("hi 1", "hi 2", "hi 3", "hi 4", "hi 5").
2. On B: verify all five bubbles appear in order.
3. **A-side check**: `document.querySelectorAll('.bubble[data-mid]')` in devtools
   returns 5 bubbles; every `data-mid` is UNIQUE.

## Scenario 2 — Cross-direction dup-mid (FIND-cfd24d69 fix)

4. On B: send "reply from B" to A.
5. On A: reply to B's message with "A reply".
6. **A-side check**: `document.querySelectorAll('.bubble[data-mid]')` returns
   the expected count; every `data-mid` is UNIQUE. No two bubbles share a mid.

## Scenario 3 — Delete (FIND-676d365a fix)

7. On A: long-press / context-menu on one of A's own messages → Delete.
8. **A-side check**: bubble disappears within 2s.
9. **B-side check** (optional): within 5s, the same bubble also disappears on B.

## Scenario 4 — React (FIND-1526f892 sender-side fix)

10. On A: send a new text to B ("for react").
11. On A: double-tap (or context-menu → React → 👍) on that message.
12. **A-side check**: the `.reactions` element in the bubble's DOM now contains
    the 👍 emoji within 2s.
13. **B-side check** (Phase 2b scope — not required for 2a): B may NOT see
    the reaction yet. That's expected.

## Scenario 5 — Reload

14. On A: hard-reload the page.
15. **Check**: chat history reloads, no red error in devtools console,
    previously-sent messages still visible with correct mids.

## Report

- **All 5 scenarios pass:** write "PASS 2A manual" as a PR comment or commit
  message.
- **Any scenario fails:** blocker — report the step number + expected/actual
  on the PR and do not merge.
