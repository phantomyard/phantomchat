# Bug Fuzzer Phase 2b.2a — Lifecycle + 3 Carry-Forward FINDs + Baseline v2b1 Emit

Date: 2026-04-20
Status: Design approved, ready for planning
Follows: [`2026-04-19-bug-fuzzer-phase-2b-design.md`](2026-04-19-bug-fuzzer-phase-2b-design.md) §6
Supersedes: §6 of that spec is split — this is Sub-PR 2b.2a; profile scope moves to Sub-PR 2b.2b.

## 1. Motivation

Phase 2b.1 ha shipped NIP-25 reactions RX bilaterale + architectural identity triple fix via PR #42 (merged 2026-04-20, commit `da0f1568`). Lo scope originale includeva emit di `baseline-seed42-v2b1.json`, ma è stato deferrato perché il richer action registry ha surfaced 3 bug pre-esistenti che bloccano il gate `findings === 0`:

- `FIND-c0046153` — `INV-bubble-chronological` DOM ordering violation post out-of-order delivery
- `FIND-bbf8efa8` — `POST_react_multi_emoji_separate` — multi-emoji render aggregation incompleta
- `FIND-eef9f130` — `POST-sendText-input-cleared` — chat input retains text after send (regressione sospetta dal migration `keyboard.insertText` per fix FIND-3c99f5a3)

Come effect collaterale del merge 2b.1, il file `docs/fuzz-baseline/baseline-seed42.json` (v2a) è stato rimosso. **Attualmente main NON è protetto da replay baseline.** Ripristinarlo è parte di questa sub-PR.

Phase 2b.2a è Sub-PR sequenziale che:
1. Chiude i 3 FIND carry-forward (root-cause + surgical fix + regression test).
2. Aggiunge lifecycle actions + invariants da spec §6.1/§6.2 (reloadPage, deleteWhileSending).
3. Attiva `INV-virtual-peer-id-stable` (già scaffolded in `regression.ts:128`).
4. Emit `baseline-seed42-v2b1.json` — ri-abilita `--replay-baseline` protection.
5. Triple gate.

Phase 2b.2b (prossima sub-PR) copre profile scope: editName/editBio/uploadAvatar/setNip05 + Blossom mock + cross-peer kind-0 propagation + emit `baseline-seed42-v2b2.json`.

## 2. Goals

- **Chiudere 3 carry-forward FINDs** — ciascuno con root cause identificato, surgical fix, regression test, README aggiornato a `Status: FIXED`.
- **Lifecycle fuzz coverage** — `reloadPage` (pure + during-pending-send variants) + `deleteWhileSending` (race action) + 5 invariants + 1 new postcondition (+ 1 existing `POST_sendText_input_cleared` re-enabled via M5 harness fix).
- **Reactivate `INV-virtual-peer-id-stable`** — guard switched from `false` a `action.name === 'reloadPage'`.
- **Emit `baseline-seed42-v2b1.json`** — 6-min run @ seed=42, max-commands=40, findings=0, `fuzzerVersion: 'phase2b1'` (field name follows spec-level version convention `phase2b{N}` from parent spec §4; the file is the deferred v2b1 emit, not a new v2b2a version). File committed in `docs/fuzz-baseline/`.
- **Triple gate passed**: tech + 2-device manual + baseline replay.
- **Update CLAUDE.md** — rimuovere il claim stale su baseline, aggiungere note operative 2b.2a.

## 3. Non-goals

- **Profile actions** (`editName`, `editBio`, `uploadAvatar`, `setNip05`) → Sub-PR 2b.2b.
- **Blossom mock injection** in harness → 2b.2b.
- **`INV-profile-propagates`** cross-peer kind-0 verify → 2b.2b.
- **`baseline-seed42-v2b2.json`** emit → 2b.2b (questa sub-PR ferma al v2b1).
- **Groups** (createGroup/addGroupMember/leaveGroup/etc.) → Sub-PR 2b.3.
- **Chaos actions** (flakyRelay, connectivityLoss) → Phase 3.
- **Tor backend, `--pairs>1`, UI contract manifest** → Phase 3.

## 4. Work Breakdown (7 milestones)

Ordering: lineare, checkpoint ad ogni milestone. Ordering scelta per minimizzare interdipendenze e garantire bisect pulito.

| # | Milestone | Deliverable principale | Commit atomico? | Exit condition |
|---|---|---|---|---|
| M1 | Worktree + sanity | `../nostra.chat-wt/2b2a` creato, `.env.local` copiato, baseline state checked | no (setup) | `pnpm test:nostra:quick` ≥ 401/401, `npx vitest run src/tests/fuzz/` 50+/50+, main HEAD `da0f1568` visibile |
| M2 | Replay triage 3 FINDs | `pnpm fuzz --replay=FIND-xxx` per ciascuno, verdict documentato nel README (prod-bug / harness-bug / not-repro), root-cause hypothesis ranked | 1 docs-only commit | 3 verdicts decided |
| M3 | Fix FIND-c0046153 (bubble chronological) | Surgical fix in path `nostra_new_message` insertBubble sort key, regression test in `bubbles.test.ts` | 1 commit `fix(nostra): bubble chronological ordering + regression` | `pnpm fuzz --replay=FIND-c0046153` exit 0 |
| M4 | Fix FIND-bbf8efa8 (multi-emoji) | Root cause H1/H2/H3 confirmed via instrumentation, surgical fix, regression test in `reactions.test.ts` | 1 commit `fix(nostra): reactions multi-emoji aggregation + regression` | `pnpm fuzz --replay=FIND-bbf8efa8` exit 0 |
| M5 | Fix FIND-eef9f130 (input cleared) | Triage verdict (harness vs prod) via manual sanity in `pnpm start`; se harness: update `sendText` drive in `messaging.ts`; se prod: fix `input.ts` compositionend handler | 1 commit | `pnpm fuzz --replay=FIND-eef9f130` exit 0 |
| M6 | Lifecycle actions + invariants | `actions/lifecycle.ts` (`reloadPage` ×2 variants, `deleteWhileSending`), `invariants/lifecycle.ts` (5 invariants), activation `virtualPeerIdStable` guard, Vitest `lifecycle.test.ts` | 2 commits (actions + invariants) | 6-min fuzz smoke run @ seed=42 passes 0 findings |
| M7 | Baseline emit + triple gate + PR prep | Emit `baseline-seed42-v2b1.json`, scrivi `docs/VERIFICATION_2B2A.md`, aggiorna `CLAUDE.md`, tech gate complete, PR draft titled `feat(fuzz): phase 2b.2a — lifecycle + 3 carry-forward FINDs + baseline v2b1 emit` | N artifact commits | triple gate pass |

**Principi operativi** (enforced across all milestones):
- Commit atomici Conventional Commits. PR title Conventional (per memory `feedback_pr_titles_conventional.md`).
- Ogni FIND fix commit include **sia fix sia regression test** (per chiarire correlazione).
- "Fix wave" cap applicato **per-milestone**: se M3 surface 3 nuovi bug → max 2 wave di fix DENTRO M3, poi carry-forward residui. Reset su M4. Stessa logica per M5. Per memory `feedback_fuzz_ship_with_carryforward.md`.
- Se M6 lifecycle fuzz surface nuovi bug: max 1 fix wave dentro M6 — oltre, carry-forward a 2b.2b.

## 5. FIND Fix Strategies

### 5.1 FIND-c0046153 — Bubble chronological ordering (M3)

**Hypothesis ranking** (dal `docs/fuzz-reports/FIND-c0046153/README.md`):

- **H1 (priorità)**: `nostra_new_message` handler inserisce bubble in ordine di ricezione, non `created_at`. Fix: binary-search insertion by `timestampSec` primary key.
- **H2**: `BubblesController.insertBubble` usa `mid` come sort key; per P2P peer (`peerId >= 1e15`) mid è `timestampSec * 1000 + microseq`, ma `microseq` è counter locale non ordinabile cross-device.
- **H3**: clock skew tra Playwright context su secondo-boundary → ordering non-deterministico.

**Plan**:
1. Replay con `--headed --slowmo=500` per osservare ordine di `nostra_new_message` dispatch + DOM insertBubble call.
2. Instrumentare `injectOutgoingBubble` e `nostra_new_message` handler in `bubbles.ts` e `nostra-sync.ts` con `console.debug('[chrono]', {mid, timestampSec, domIdx})`.
3. Root cause identified → surgical fix: binary-search insert con `timestampSec` primary sort key + `mid` tiebreaker.
4. Regression: update `INV-bubble-chronological` to cover scenario esplicito; aggiungi Vitest `bubbles.test.ts` con mock out-of-order delivery.

**Rischio**: bubbles.ts è 11000+ righe (CLAUDE.md warning). Cambio sort key può cascare su scroll position, "new messages" marker. **Mitigazione**: scope ristretto al path `nostra_new_message` (no touch path MTProto legacy), manual 2-device smoke post-fix, `pnpm test:nostra:quick` regressione suite.

**Time-box**: 2h. Escape: downgrade `INV-bubble-chronological` a `skip: true`, carry-forward a 2b.2b.

### 5.2 FIND-bbf8efa8 — Multi-emoji aggregation render (M4)

**Hypothesis ranking** (dal README):

- **H1 (priorità)**: tweb legacy `.reactions` container collide con `renderNostraReactions`. Ultimo render vince, overwrite precedenti.
- **H2**: `nostraReactionsStore` race — event-driven re-render legge snapshot durante write.
- **H3**: Solid keyed-list diff unmount/remount intermittent quando 3 emoji rapid-fire.

**Plan**:
1. Instrumentare `renderNostraReactions` con `console.debug('[react]', {mid, storeSnapshot: [...]})` start + end.
2. Replay `--headed --slowmo=200` per osservare store snapshot vs DOM rendered.
3. Se H1: assegnare classe distinta `.nostra-reactions` vs `.reactions` legacy, o short-circuit legacy handler per P2P peers.
4. Se H2: avvolgere upsert + dispatch in `batch(() => {...})` Solid o `untrack` nel render.
5. Se H3: deterministic keying `emoji+reactorPubkey` invece di `reactionEventId`.

**Regression**: `INV-reaction-aggregated-render` nuovo in `reactions.ts` + Vitest mock 3 kind-7 events back-to-back → asserta 3 emojis rendered.

**Rischio**: toccare `reaction.ts` può cascata su tweb reactions UI. **Mitigazione**: short-circuit legacy pathway per P2P peers invece di refactor, feature flag se necessario.

**Time-box**: 2h. Escape: downgrade `POST_react_multi_emoji_separate` a `skip: true`, carry-forward.

### 5.3 FIND-eef9f130 — Input not cleared (M5)

**Triage verdict path**:

**Step 1**: `pnpm fuzz --replay=FIND-eef9f130 --headed --slowmo=500`. Osserva DOM input node durante `keyboard.insertText('hello')` + Enter.

**Step 2 (manual sanity)**: `pnpm start` locale → chat → console `document.execCommand('insertText', false, 'hello')` + Enter. Se clear manually works → **HARNESS bug**. Se clear manually doesn't work → **PROD bug**.

**Scenario harness (atteso)**:
- Update `src/tests/fuzz/actions/messaging.ts` `sendText` drive: `await input.evaluate((el, text) => { el.focus(); document.execCommand('insertText', false, text); }, text)` + Enter. Evita `keyboard.insertText` CDP event sequence che non triggera tweb compositionend path.
- Verify: multi-codepoint emoji (`🔥🔥🔥`) ancora funziona (no regress FIND-3c99f5a3).
- Regression: Vitest asserta post-`sendText` action `input.textContent === ''`.

**Scenario prod-bug**:
- Fix in `src/components/chat/input.ts` — aggiungi compositionend handler al "clear on send" path.
- Test matrix multi-codepoint (BMP + SMP + ZWJ sequences).

**Decisione harness-fix = valida closure**: user ha già approvato (nel brainstorming): OK chiudere con "harness-fix-only" se riproducibile via manual verification che flow prod è corretto.

**Time-box**: 1h harness, 2h prod. Escape: carry-forward postcondition a 2b.2b con `skip: true`.

## 6. Lifecycle Actions

### 6.1 `reloadPage` action

```ts
// action.args: {user: UserId, mode: 'pure' | 'during-pending-send', raceWindowMs?: number}
// weight: 3 (2 pure, 1 during-pending-send — pure più comune per coverage post-reload invariants)
```

**`pure` mode**:
1. `snapshotPreReloadState(user)`:
   - `ctx.snapshots.set('preReloadPeerMap-<user>', Map<npub, peerId>)`
   - `ctx.snapshots.set('preReloadHistorySig-<user>', sha256(sortedDataMids))`
2. `user.page.reload({waitUntil: 'load'})`
3. `waitForFunction(() => window.apiManagerProxy?.mirrors?.peers_ready)` timeout 10s.

**`during-pending-send` mode**:
1. `user.page.evaluate((t) => { const rs = window.rootScope; const peerId = window.appImManager?.chat?.peerId; window.__nostraPendingSend = rs.managers.appMessagesManager.sendText({peerId, text: t}); }, text)`.
2. `await user.page.waitForTimeout(action.args.raceWindowMs || 80)`.
3. `user.page.reload()`.
4. Post-reload `waitForFunction` come sopra.

### 6.2 `deleteWhileSending` action

```ts
// action.args: {user: UserId, raceWindowMs?: number}
// weight: 1
```

Pseudocodice (driver usa API esistenti `appMessagesManager.sendText` + `deleteMessages`):

```ts
async drive(ctx, action) {
  const sender = ctx.users[action.args.user];
  const text = 'race-test-' + Date.now();
  await sender.page.evaluate((t) => {
    const rs = window.rootScope;
    const peerId = window.appImManager?.chat?.peerId;
    window.__nostraPendingSend = rs.managers.appMessagesManager.sendText({peerId, text: t});
  }, text);
  await sender.page.waitForTimeout(action.args.raceWindowMs || 80);
  const tempMid = await sender.page.evaluate(() => {
    const proxy = window.apiManagerProxy;
    const peerId = window.appImManager?.chat?.peerId;
    const hist = proxy?.mirrors?.messages?.[`${peerId}_history`] || {};
    const mids = Object.keys(hist).map(Number).filter((m) => m < 1);
    return mids.length ? Math.max(...mids) : null;
  });
  if(tempMid) {
    await sender.page.evaluate((m) => {
      const rs = window.rootScope;
      const peerId = window.appImManager?.chat?.peerId;
      return rs.managers.appMessagesManager.deleteMessages(peerId, [m], true);
    }, tempMid);
  }
  await sender.page.evaluate(() => window.__nostraPendingSend?.catch(() => {}));
  action.meta = {raceWindowMs: action.args.raceWindowMs || 80, tempMid, text};
}
```

**Replay fidelity**: `raceWindowMs` e `tempMid` persistiti in `action.meta`. Non-determinismo intrinseco (Promise scheduler) accettato — invariants sono strutturate per essere valid-in-either-outcome.

## 7. Invariants

File: `src/tests/fuzz/invariants/lifecycle.ts` (NEW) + modifica `invariants/regression.ts`, `invariants/bubbles.ts`, `invariants/reactions.ts`.

| ID | Tier | Activation | Check |
|---|---|---|---|
| `INV-history-rehydrates-identical` | medium | after `reloadPage` (pure) | Post-reload DOM bubble count + mid Set ≡ `preReloadHistorySig`. Timeout 8s via `waitForFunction`. |
| `INV-offline-queue-persistence` | medium | after `reloadPage` (during-pending-send) | Se offline-queue non-empty al reload (via `localStorage['nostra:offline-queue']` o IDB), queued msg sono in `nostra-messages` IDB con flag `isOffline: true` E flushate post-reconnect entro 5s. **Precondition check M1**: se non esiste offline queue impl, downgrade a `skip: true` con TODO. |
| `INV-no-dup-after-delete-race` | cheap | after `deleteWhileSending` | Sender DOM ha ≤ 1 bubble matching `action.meta.text`; peer DOM ha ≤ 1. Mai duplicati. |
| `INV-no-orphan-tempmid-post-reload` | medium | after `reloadPage` | Post-reload, nessun bubble DOM ha `data-mid` matching regex `/^\d+\.\d{1,4}$/` (pattern temp mid). |
| `INV-virtual-peer-id-stable` | regression | **ACTIVATED** — `regression.ts:128` guard switched from `false` a `action.name === 'reloadPage'` | Per ogni peer noto, `preReloadPeerMap-<user>.get(npub) === apiManagerProxy.mirrors.peers[npub].peerId` post-reload. |

**Modifiche a invariants esistenti** (side-effects dei fix M3/M4):
- `INV-bubble-chronological` (M3) — refinement per capture scenario "out-of-order delivery" esplicitamente (non solo retroactive).
- `INV-reaction-aggregated-render` (M4) — NEW in `reactions.ts`, verifica multi-emoji aggregation.

## 8. Postconditions

File: modifica `src/tests/fuzz/postconditions/messaging.ts`.

| ID | Action | Check |
|---|---|---|
| `POST_deleteWhileSending_consistent` | deleteWhileSending | Entro 3s: sender DOM + peer DOM entrambi senza il message OR entrambi con il message (never asymmetric). |
| `POST_sendText_input_cleared` | sendText | (closure di FIND-eef9f130) — postcondition già esistente, ma harness path fixed in M5 — no source change se fix è harness-only. |

## 9. Vitest Coverage

`src/tests/fuzz/invariants/lifecycle.test.ts` — NEW. 5 unit tests, uno per invariant check function. Mock `ctx`, mock `page.evaluate` returns, assert pass/fail boolean coherence.

`src/tests/fuzz/invariants/bubbles.test.ts` — MODIFY. Aggiungi "out-of-order delivery" scenario.

`src/tests/fuzz/invariants/reactions.test.ts` — MODIFY. Aggiungi "multi-emoji aggregation" scenario.

## 10. Baseline Emit

**Comando**:
```bash
pnpm fuzz --duration=6m --max-commands=40 --seed=42 --emit-baseline
```

**Action registry al tempo dell'emit** (post-M6):
- Messaging (pre-esistenti): `sendText`, `sendTextToRandomChat`, `replyToRandomBubble`, `deleteRandomOwnBubble`
- Reactions (pre-esistenti da 2b.1): `reactToRandomBubble`, `removeReaction`, `reactMultipleEmoji`
- Navigation (pre-esistente): `openRandomChat`
- **Lifecycle NEW**: `reloadPage` (weight 3), `deleteWhileSending` (weight 1)

**Mix atteso in 40 azioni**:
- ≥15 messaging
- ≥5 reactions
- ≥2 `reloadPage` (pure + during-pending-send almeno uno ciascuno)
- ≥1 `deleteWhileSending`
- ≥2 `openRandomChat`
- rest weighted selection

**Emit gate**: `findings === 0` durante la 6m run. Se ≥1 fire, emit fallisce → loopback M6 surgical fix → retry.

**File output**:
- Path: `docs/fuzz-baseline/baseline-seed42-v2b1.json`
- `fuzzerVersion: 'phase2b1'` (matches spec-level version naming from parent spec §4; questo è il v2b1 deferrato, non una nuova version v2b2a).
- `--replay-baseline` loader scans dir, prefers latest versioned (commit c5f2a9f0 implementazione già in place).

## 11. Acceptance Gate

### 11.1 Tech gate

```bash
pnpm lint                                     # 0 errors
npx tsc --noEmit                              # 0 errors
pnpm test:nostra:quick                        # ≥ 401/401 pass
pnpm test                                     # full Vitest green
npx vitest run src/tests/fuzz/                # ≥ 50/50 pass
pnpm fuzz --duration=6m --max-commands=40 --seed=42   # smoke, 0 findings
pnpm fuzz --replay-baseline                   # exit 0, < 90s
```

### 11.2 2-device manual (`docs/VERIFICATION_2B2A.md` — NEW)

1. **Pure reload**: A ↔ B scambiano 5 msg → A hard-reload → tutti 5 visibili, npub→peerId stable (console `window.apiManagerProxy.mirrors.peers`), nessun "compromissione rilevata" popup.
2. **During-send reload**: A digita "test hard reload", Send, entro 100ms Cmd-R → post-reload: msg arrivato a B (bubble ✓) O mai spedito. Mai duplicato.
3. **Delete-while-sending**: A digita "race test", Send, immediate right-click Delete → B: non riceve O riceve+delete-marker. Mai duplicato.
4. **Multi-message reload**: A manda 20 msg rapidamente, hard-reload, B manda 5 durante rehydrate → post-rehydrate A vede tutti 25 in ordine.
5. **Regression reactions (2b.1)**: A reagisce 👍 su msg B → B vede 👍 entro 3s.
6. **Regression 3 FINDs**: `pnpm fuzz --replay=FIND-c0046153` && `--replay=FIND-bbf8efa8` && `--replay=FIND-eef9f130` — tutti exit 0.

### 11.3 Baseline replay gate

```bash
pnpm fuzz --replay-baseline
```
Exit 0 in < 90s usando `baseline-seed42-v2b1.json`.

### 11.4 PR criteria

- Title: `feat(fuzz): phase 2b.2a — lifecycle + 3 carry-forward FINDs + baseline v2b1 emit`
- Body: link a questo spec, summary 3 FIND fixes + lifecycle scope, checklist di `docs/VERIFICATION_2B2A.md`.
- Triple gate complete prima del merge.

## 12. File Layout (cumulativo)

| File | Change | Milestone |
|---|---|---|
| `src/tests/fuzz/actions/lifecycle.ts` | Create — `reloadPage` + `deleteWhileSending` | M6 |
| `src/tests/fuzz/actions/index.ts` | Modify — register lifecycle actions | M6 |
| `src/tests/fuzz/actions/messaging.ts` | Possibly modify — `sendText` drive update (se M5 harness fix) | M5 |
| `src/tests/fuzz/invariants/lifecycle.ts` | Create — 5 invariants | M6 |
| `src/tests/fuzz/invariants/lifecycle.test.ts` | Create — 5 Vitest | M6 |
| `src/tests/fuzz/invariants/regression.ts` | Modify — activate `virtualPeerIdStable` guard | M6 |
| `src/tests/fuzz/invariants/bubbles.ts` | Modify — `INV-bubble-chronological` refinement | M3 |
| `src/tests/fuzz/invariants/bubbles.test.ts` | Modify — "out-of-order" regression | M3 |
| `src/tests/fuzz/invariants/reactions.ts` | Modify — `INV-reaction-aggregated-render` NEW | M4 |
| `src/tests/fuzz/invariants/reactions.test.ts` | Modify — "multi-emoji" regression | M4 |
| `src/tests/fuzz/postconditions/messaging.ts` | Modify — `POST_deleteWhileSending_consistent` + `POST_sendText_input_cleared` cleanup | M5, M6 |
| `src/tests/fuzz/postconditions/index.ts` | Modify — register | M6 |
| **App code (contingenti sui fix)** | | |
| `src/components/chat/bubbles.ts` o `src/lib/nostra/nostra-sync.ts` | Modify — bubble insert sort key fix | M3 |
| `src/components/chat/reaction.ts` o `src/lib/nostra/nostra-reactions-receive.ts` | Modify — multi-emoji collision fix | M4 |
| `src/components/chat/input.ts` | Possibly modify — solo se M5 triage = prod-bug | M5 |
| **Docs** | | |
| `docs/fuzz-baseline/baseline-seed42-v2b1.json` | Create — emitted | M7 |
| `docs/fuzz-reports/FIND-c0046153/README.md` | Modify — Status FIXED + root cause + fix summary | M3 |
| `docs/fuzz-reports/FIND-bbf8efa8/README.md` | Modify — Status FIXED + root cause + fix summary | M4 |
| `docs/fuzz-reports/FIND-eef9f130/README.md` | Modify — Status FIXED (harness or prod) + fix summary | M5 |
| `docs/FUZZ-FINDINGS.md` | Modify — move 3 entries Open → Fixed (Phase 2b.2a) | M3/M4/M5 |
| `docs/VERIFICATION_2B2A.md` | Create — 2-device manual protocol | M7 |
| `CLAUDE.md` | Modify — remove stale baseline claim + add 2b.2a ops notes | M7 |

## 13. Risks

| Risk | Probabilità | Mitigation |
|---|---|---|
| Fix FIND-c0046153 in bubbles.ts cascata regressione scroll/markers | Media | `pnpm test:nostra:quick` + manual 2-device smoke post-fix; scope ristretto al path `nostra_new_message` |
| Fix FIND-bbf8efa8 richiede tocco profondo in `reaction.ts` tweb legacy | Media | Short-circuit legacy handler per P2P peers invece di refactor; feature flag se necessario |
| FIND-eef9f130 triage rivela prod bug (non harness) | Bassa | Se prod: scope isolato a compositionend handler aggiuntivo; test multi-codepoint matrix completa |
| Lifecycle `reloadPage` invariants flaky in CI | Media-alta | `waitForFunction` timeout ampio (8-10s), tier=medium non=cheap, retry logic se necessario |
| `INV-offline-queue-persistence` vacuous (offline queue non impl) | Media | M1 precondition check: grep `src/lib/nostra/` per offline queue code. Se assente: downgrade a `skip: true` con TODO |
| Baseline emit fallisce per flake | Media | 3 tentativi: se findings differenti, downgrade flaky invariants a `skip: true`, emit con subset ridotto, doc in VERIFICATION |
| `deleteWhileSending` race window 80ms: send completa sempre prima del delete | Bassa | Postcondition + invariant sono valid-in-either-outcome; action stress-testa pipeline senza richiedere race |
| Commit size > 500 LOC per fix FIND | Bassa | Surgical fix pattern, max 2 file per commit, no refactor |
| Time-box 2h per FIND supera budget | Media | Escape: downgrade + skip + carry-forward già definita |

## 14. Decisions made during brainstorming

Per chiarezza e audit trail:

- **Scope split**: 2b.2 originale splittata in 2b.2a (qui) + 2b.2b (profile). Motivazione: 2 triple-gate più piccoli, baseline protection ripristinata presto.
- **Harness-fix = valid closure** per FIND-eef9f130 se prod flow verificato via manual sanity.
- **Ordering M3/M4/M5**: chrono → emoji → input, in ordine di gravità utente-facing.
- **Manual sanity per FIND-eef9f130**: utente esegue `pnpm start` al checkpoint M5.
- **Time-box FIND**: 2h ciascuno, escape = downgrade invariant a skip + carry-forward 2b.2b.
- **Fix wave cap**: 2 wave su M3/M4/M5 (nuovi FIND surfaced), 1 wave su M6 lifecycle.

## 15. Timeline Estimate

Session-wise (effettivi):
- M1: 10 min (worktree + sanity)
- M2: 20 min (3 replay + verdict doc)
- M3: 2h max
- M4: 2h max
- M5: 1h harness / 2h prod
- M6: 3h (lifecycle impl)
- M7: 1.5h (emit + gate + PR)

**Totale lordo**: ~10-12h + manual-verify. Stima: 2-3 sessioni.

## 16. Dependencies & Preconditions

- Main HEAD `da0f1568` (2b.1 merged)
- `pnpm test:nostra:quick` baseline: 401+/401+ pass
- `npx vitest run src/tests/fuzz/` baseline: 50+/50+ pass
- `.env.local` copied to worktree (gitignored, needed for Vite)
- Memory: `project_phase_2b_state.md`, `feedback_worktree.md`, `feedback_pr_titles_conventional.md`, `feedback_fuzz_ship_with_carryforward.md`

## 17. Next Step

After this spec is approved:
1. Invoke `superpowers:writing-plans` skill to generate detailed implementation plan at `docs/superpowers/plans/2026-04-20-bug-fuzzer-phase-2b2a.md`.
2. Execute plan via `gsd:execute-phase` or equivalent.
