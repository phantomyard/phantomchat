# Phase 2b.2a — 2-Device Manual Verification

This checklist validates the 3 FIND fixes + lifecycle coverage land correctly. Baseline v2b1 emit is **deferred to 2b.2b** (see Known Issues). Run on 2 real devices OR 2 isolated browser profiles on the same machine.

## Setup

- Device A + Device B, each with a distinct Nostra identity (either existing or fresh).
- Both devices have each other added as a contact.
- Open the chat A↔B on both devices.

## Checklist

- [ ] **1. Pure reload — history rehydration**
  - A and B exchange 5 messages bilaterally.
  - A performs a hard reload (Cmd-Shift-R / Ctrl-Shift-R).
  - **Expected**: all 5 messages visible after rehydrate (≤ 8s). No "compromissione rilevata" popup. `window.apiManagerProxy.mirrors.peers` (console) shows B's peerId unchanged.

- [ ] **2. During-send reload**
  - A types "test hard reload", presses Send, and within 100ms presses Cmd-R (plain refresh).
  - **Expected**: after reload, either (a) the message is visible on B with ✓, or (b) never-sent (no ghost bubble on A). Never a duplicate.

- [ ] **3. Delete-while-sending**
  - A types "race test", presses Send, and immediately right-click → Delete on the new bubble.
  - **Expected**: B either doesn't receive, or receives + sees a delete marker. Never a duplicate.

- [ ] **4. Multi-message reload stress**
  - A sends 20 messages rapidly to B. A performs a hard reload. While A rehydrates, B sends 5 more.
  - **Expected**: A post-rehydrate sees all 25 in chronological order. No pageerror.

- [ ] **5. Regression — reactions NIP-25 bilateral (Phase 2b.1 sanity)**
  - A reacts 👍 on a message of B.
  - **Expected**: B sees 👍 within 3s.

- [ ] **6. Regression — multi-emoji aggregation (Phase 2b.2a fix: FIND-bbf8efa8)**
  - A reacts with 3 emojis (`👍`, `❤️`, `😂`) on the same message of B in rapid succession.
  - **Expected**: A's own bubble shows all 3 emojis aggregated. B sees all 3 within 3s.

- [ ] **7. Regression — bubble chronological ordering (Phase 2b.2a fix: FIND-c0046153)**
  - In the same minute: A sends a message, then B sends a message, then A sends another. Observe order.
  - **Expected**: Both A and B see bubbles in chronological order (by timestamp), not by arrival order.

- [ ] **8. Regression — 3 FIND replays**
  ```bash
  pnpm fuzz --replay=FIND-c0046153
  pnpm fuzz --replay=FIND-bbf8efa8
  pnpm fuzz --replay=FIND-eef9f130
  ```
  **Expected**: all 3 exit 0.

- [ ] **9. Baseline replay** — SKIPPED in 2b.2a
  Baseline emit deferred to 2b.2b pending fix of cold-start postcondition flakes. `pnpm fuzz --replay-baseline` has no baseline file to load.

## Known Issues Carry-Forward to 2b.2b

- **FIND-chrono-v2** — `INV-bubble-chronological` flake on high-concurrency traces (same-second same-user race). Distinct from FIND-c0046153. Tracked in `docs/FUZZ-FINDINGS.md` → Open section.
- **Cold-start flake: `POST_deleteWhileSending_consistent`** — on first action of the seed=42 smoke, `deleteWhileSending` produced asymmetric outcome (sender had bubble, peer didn't — relay delivery timing on boot). Partial mitigation applied in 2b.2a: skip-if-tempMid-null + 6s poll window. Remaining gap: add a harness warmup guard (skip postcondition for first N actions after boot).
- **Cold-start flake: `POST_react_peer_sees_emoji`** — on first reaction action after boot, peer may not receive via relay subscription within 3s. Pre-existing postcondition from Phase 2a that becomes observable when fuzz reaches reaction actions before relay stabilizes. Needs same warmup guard as above.
- **Baseline v2b1 emit** itself is carry-forward — once the two cold-start flakes have warmup guards, seed=42 6m/40-cmd smoke should produce findings=0 and the emit will proceed.
