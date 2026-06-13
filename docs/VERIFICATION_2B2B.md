# Phase 2b.2b Verification Checklist

Manual 2-device verification steps. Complete all boxes before merging.

## Baseline emit (T7 — REQUIRED before merge)

This session could not run `pnpm fuzz` because `pnpm start` was not available. Before merging this PR:

1. `pnpm start` in one terminal
2. In another terminal: `cd /home/raider/Repository/nostra.chat-wt/2b2b && pnpm fuzz --duration=6m --max-commands=40 --seed=42 --emit-baseline`
3. Verify output: `findings: 0` and `docs/fuzz-baseline/baseline-seed42-v2b2.json` exists with `"fuzzerVersion": "phase2b2"`.
4. Verify replay: `pnpm fuzz --replay-baseline` exits 0.
5. Commit the emitted JSON: `git add docs/fuzz-baseline/baseline-seed42-v2b2.json && git commit -m "chore(fuzz): emit baseline-seed42-v2b2.json (profile scope included)"`

If the 6-min run surfaces new findings, per plan §4 decision #3 apply max 1 fix wave, else carry-forward to Phase 2b.3 and **do not commit the baseline JSON** (it requires findings=0).

## Reporter (T1)
- [ ] Run `pnpm fuzz --duration=30s` on this branch.
- [ ] Run `git diff docs/FUZZ-FINDINGS.md` — confirm `## Fixed` section is byte-for-byte unchanged, only `Last updated:` + `Last seen:` fields in Open section moved.

## Warmup (T2)
- [ ] Cold-boot `pnpm fuzz --duration=60s --seed=42` — observe 4 `[harness] warmup: …` lines before first fuzz action.
- [ ] Replay `FIND-cold-deleteWhileSending` 10 times — 10/10 pass.
- [ ] Replay `FIND-cold-reactPeerSeesEmoji` 10 times — 10/10 pass.

## chrono-v2 (T3)
- [ ] Replay `FIND-eef9f130` 10 times — 10/10 pass (previously ~40% flake post-2b.2a).

## reactViaUI (T5)
- [ ] Open a chat in the browser; right-click any bubble.
- [ ] Reactions picker renders with ≥3 emoji.
- [ ] Click one — reaction appears on the bubble within 2s.

## Profile (T6)
Two browser windows (device A, device B):
- [ ] Device A: Settings → Edit Profile → change name → Save.
- [ ] Device B: within 5s, A's name updates in the chat list.
- [ ] Device A: upload a new avatar → crop → confirm.
- [ ] Device B: A's avatar updates within 5s (from `blossom.fuzz` mock URL in fuzz runs; real Blossom in production test).
- [ ] Device A: set NIP-05 (e.g. `alice@example.com`) → Save.
- [ ] Device A: reload → NIP-05 persists.

## Baseline (T7)
- [ ] `pnpm fuzz --replay-baseline` exits 0.
- [ ] `docs/fuzz-baseline/baseline-seed42-v2b2.json` exists with `"fuzzerVersion": "phase2b2"`.

## Tech gate (automated)
- [ ] `pnpm lint` clean.
- [ ] `npx tsc --noEmit` clean.
- [ ] `pnpm test:nostra:quick` ≥ 401 passing.
- [ ] `npx vitest run src/tests/fuzz/` ≥ 68 passing.
