# Bug Fuzzer Phase 2a — Stabilità: chiusura blocker P2P + medium/regression invariants

Date: 2026-04-18
Status: Design approved, ready for planning
Supersedes scope in: [`2026-04-17-bug-fuzzer-design.md`](2026-04-17-bug-fuzzer-design.md) §17 (Phase 2)

## 1. Motivation

Phase 1 MVP ha spedito il fuzzer e già durante il primo 2h run overnight ha rivelato tre bug P2P production-blocker:
- **FIND-cfd24d69** — due bubble (is-in + is-out) condividono lo stesso `data-mid` dopo un cross-direction send su userA/userB. Documentato in `docs/fuzz-reports/FIND-cfd24d69/README.md`. Attuale: `INV-no-dup-mid` muted.
- **FIND-676d365a** — `deleteMessages` su un mid P2P (>= 1e15) non rimuove il bubble locale. `getServerMessageId(mid) % MESSAGE_ID_OFFSET` non round-trippa → `serverMessageIds` viene filtrato a `[]` → VMT ritorna `pts_count: 0` → `apiUpdatesManager` tratta come no-op. Attuale: `POST_delete_local_bubble_gone` muted.
- **FIND-1526f892** — sendReaction emoji non aggiorna UI. Display bridge Nostra per reactions probabilmente mancante. Attuale: `POST_react_emoji_appears` muted.

Ognuno di questi tre bug ha fatto saturare iterazioni del fuzzer (dup findings), nascondendo altri bug dietro a essi. Nelle iter "clean path" (~15 consecutive dopo i fix Phase 1) il fuzzer non trova findings, a riprova che la baseline è stabile UNA VOLTA chiusi questi tre.

Obiettivo Phase 2a: portare Nostra al livello production-ready sul **core messaging 1:1** (send, receive, edit, delete, react), blindare contro regressioni future via invarianti medium + regression tier ancora mancanti dal Phase 1 MVP, e committare un regression baseline replay-abile in 30s.

Phase 2b (profile actions, groups actions, UI contract manifest) resta come milestone successiva, a valle del ship di 2a.

## 2. Goals

- **Chiudere i tre bug P2P blocker** (dup-mid render, delete local-gone, react display) con fix mirati e un test Vitest per ognuno che riproduce il bug pre-fix (red → green).
- **Riattivare le tre mute** (`INV-no-dup-mid`, `POST_delete_local_bubble_gone`, `POST_react_emoji_appears`) una volta fixati i bug corrispondenti — nessun mute deve sopravvivere al ship di 2a.
- **Aggiungere le 9 invarianti mancanti**: 4 medium tier (state coherence + offline queue) + 5 regression tier (crypto + edit integrity + migration safety).
- **Committare un regression baseline trace** di seed=42 con `--emit-baseline` / `--replay-baseline` CLI flags che altri PR possono rigiocare in 30s per rilevare regressioni.
- **Superare un triple acceptance gate** (A tech + B 2-device manuale + C baseline) prima del merge.

## 3. Non-goals

- **Niente nuove azioni** (profile/groups/lifecycle). Tutto in 2b.
- **Niente UI contract manifest**. Resta in Phase 3 per scelta di scope.
- **Niente `--pairs>1` / `--backend=real` / `--tor`**. Flag Phase 3, restano gated.
- **NIP-25 full implementation receive-side** — se la diagnosi di FIND-1526f892 rivela che l'infra reactions è quasi interamente mancante, il fix 2a copre il **sender-side display** locale (reaction visibile immediatamente su A). Receive-side completo (B vede la reaction di A sul suo DOM) slitta a 2b.
- **`INV-group-wrap-count`** — dipende da groups, 2b.
- **`INV-virtual-peer-id-stable`** — invariante implementata in 2a ma "silente" (gate su azione `reloadPage` che arriva in 2b). Codice c'è, esecuzione completa in 2b.

## 4. Architecture

Phase 2a non introduce nuova architettura. Opera su tre assi paralleli:

1. **App-code fixes** in `src/lib/appManagers/` e `src/components/chat/` — tre bug, tre commit atomici.
2. **Fuzzer infrastructure extension** in `src/tests/fuzz/invariants/` — 9 nuove invarianti distribuite su 3 file nuovi (`state.ts`, `queue.ts`, `regression.ts`) + 1 extend (`delivery.ts`).
3. **CLI extension** per regression baseline in `src/tests/fuzz/cli.ts` + `src/tests/fuzz/fuzz.ts` + `src/tests/fuzz/replay.ts`.

Principio trasversale: **diagnose-first, fix-second** per bug con root cause non confermata (FIND-cfd24d69 e FIND-1526f892). Step di diagnosi minimale (log temporanei + replay) precede ogni fix, documentato nel commit message. Fix confermati (FIND-676d365a) vanno dritti.

## 5. Bug fixes

### 5.1 FIND-cfd24d69 — dup-mid render

**Known facts** (da `docs/fuzz-reports/FIND-cfd24d69/README.md`):
- Due bubble `.bubble[data-mid="X"]` sul DOM del sender, una `is-in` (con contenuto del peer) e una `is-out` (con contenuto proprio), stesso `data-mid` == il mid della send corrente.
- Riproduce su qualunque sequenza di send cross-direction (B→A poi A→B), non solo reply.
- Attesa: bubble `is-in` mantiene il suo mid originario (derivato dal send del peer), bubble `is-out` ha mid nuovo derivato dal proprio send.

**Theory primaria**: il `message_sent` listener in `src/components/chat/bubbles.ts` fa `bubble.dataset.mid = '' + mid` e la mutazione tocca il bubble sbagliato. Candidate sources: (a) Solid reactive key collision tra bubble adiacenti; (b) group-rendering che aggrega `.bubbles-group-first/last` e condivide stato; (c) duplicate entry in `apiManagerProxy.mirrors.messages[${peerId}_history]` per due messaggi distinti con stesso mid.

**Approach**: diagnose-first.
1. Aggiungi log in bubbles.ts a ogni sito dove `bubble.dataset.mid` viene assegnato (grep `dataset.mid` ~3-5 siti): `console.log('[bubbles] data-mid write', {sitelabel, mid, bubbleInnerText, isIn, isOut})`.
2. Aggiungi log in `apiManagerProxy.mirrors.messages` mutation path (se esiste un setter o update function).
3. `pnpm fuzz --replay=FIND-cfd24d69 --headed` (headed per debug visivo) cattura la sequenza esatta.
4. Dal log: identifica il write site che tocca il bubble is-in con il mid di is-out.
5. Fix chirurgico — probabilmente un guard `if(bubbleMatchesTempMid(tempMid))` prima dell'assegnazione, o un fix a un bug di grouping logic.
6. Rimuovi log temporanei prima del commit; commit include note di diagnosi nel body.

**Files**: `src/components/chat/bubbles.ts` (primary); possibilmente `src/lib/nostra/nostra-bridge.ts` (se `mapEventIdToMid` ha collisione — meno probabile); possibilmente `src/lib/appManagers/apiManagerProxy.ts` (se è mirror drift).

**Test**: nuovo `src/tests/nostra/bubbles-dup-mid.test.ts` — simula il message_sent con due bubble mock (is-in con mid=X, is-out con mid=tempMid), fire handler, assert solo is-out cambia mid. Red pre-fix, green post-fix.

**Un-mute**: in `src/tests/fuzz/invariants/index.ts`, uncomment `noDupMid` nell'array `ALL_INVARIANTS`.

### 5.2 FIND-676d365a — delete P2P local bubble gone

**Root cause** (già identificato durante session diagnostica):
- `deleteMessagesInner:6196-6200` in `appMessagesManager.ts` mappa `mids → serverMessageIds` via `getServerMessageId(mid) % MESSAGE_ID_OFFSET` e filtra entries dove `generateMessageId(round-trip) !== mid`.
- Per mid P2P (>= 1e15), il round-trip non matcha → `serverMessageIds = []`.
- VMT `deleteMessages:1123-1142` riceve `{id: []}`, ritorna `{pts_count: 0}`.
- `apiUpdatesManager.processLocalUpdate({messages: mids, pts_count: 0})` è trattato come no-op da tweb → bubble non rimosso.

**Approach**: short-circuit per P2P direttamente in `deleteMessagesInner`. Aggiungi early-branch:

```ts
if(peerId && peerId.isP2P?.()) {  // o: peerId >= 1e15
  // Nostra P2P path: dispatch local update with full mids + fire NIP-09 via VMT
  const nostraResult = await this.apiManager.invokeApi('messages.deleteMessages', {revoke, id: mids});
  this.apiUpdatesManager.processLocalUpdate({
    _: 'updateDeleteMessages',
    messages: mids,
    pts: nostraResult.pts,
    pts_count: mids.length  // ← FIX: usa lunghezza reale, non 0 del filter
  });
  return;
}
```

**Files**: `src/lib/appManagers/appMessagesManager.ts:6176-6245` (early branch top of method). Helper `isP2PPeer(peerId)` in `src/lib/nostra/nostra-bridge.ts` se non esiste.

**Test**: nuovo `src/tests/nostra/delete-messages-p2p.test.ts` — mock `apiManager`, call `deleteMessages(peerIdP2P, [P2PMid])`, assert `processLocalUpdate` called with `messages=[P2PMid]`, `pts_count=1`.

**Un-mute**: in `src/tests/fuzz/postconditions/index.ts`, uncomment `POST_delete_local_bubble_gone` nell'array di `deleteRandomOwnBubble`.

### 5.3 FIND-1526f892 — react display bridge

**Approach**: diagnose-first, fix scoped.
1. Grep `src/lib/nostra/` per `reaction` / `sendReaction` — verifica se esiste già un handler Nostra.
2. Grep `src/lib/appManagers/appReactionsManager.ts` `sendReaction` flow per capire dove finisce la chiamata (VMT bridge? static? passthrough?).
3. **Caso A — infra P2P reactions esiste, manca solo il display update**: individua il componente `.reactions` render in bubbles.ts / componenti chat, fix per aggiornare al dispatch dell'evento store post-send. Test via postcondition.
4. **Caso B — infra P2P reactions è completamente assente**: scope Phase 2a al solo sender-side display locale.
   - Sender: al click reaction → aggiorna store locale + render immediato `.reactions` sul bubble.
   - Nessun publish NIP-25 a relay, nessun receive bridge B-side.
   - Postcondition verifica: bubble sender ha `.reactions` con emoji entro 2.5s. B-side non verificato (receive bridge in 2b).

**Files probabili**: nuovo `src/lib/nostra/nostra-reactions-local.ts` (caso B), modifiche a `src/components/chat/reactions.ts` (display update), possibilmente patch a `sendReaction` in `appReactionsManager.ts`.

**Test**: Vitest unit per store update + render; postcondition fuzz testa sender-side.

**Un-mute**: in `src/tests/fuzz/postconditions/index.ts`, uncomment `POST_react_emoji_appears` nell'array di `reactToRandomBubble`. Se caso B (sender-only), postcondition resta scope-limited (solo sender DOM).

**Nota di rischio**: la dimensione del bug dipende dalla diagnosi. Se è caso B profondo, il fix può crescere a ~1 giorno. Piano d'attacco: time-box la diagnosi a 1h, poi decidi scope.

## 6. Medium tier invariants (4)

Runner gate esistente: `ctx.actionIndex % MEDIUM_EVERY === 0` (MEDIUM_EVERY=10).

| ID | File | Check |
|---|---|---|
| `INV-mirrors-idb-coherent` | `src/tests/fuzz/invariants/state.ts` (NEW) | Ogni `mid` in `apiManagerProxy.mirrors.messages[${peerId}_history]` ha match in IDB `nostra-messages` |
| `INV-peers-complete` | `src/tests/fuzz/invariants/state.ts` (same) | Per ogni `peerId` coinvolto, `mirrors.peers[peerId].first_name` non matcha `/^[0-9a-f]{8}/` (hex fallback) |
| `INV-delivery-tracker-no-orphans` | `src/tests/fuzz/invariants/delivery.ts` (EXTEND) | Ogni `mid` in `deliveryTracker.states` corrisponde a bubble DOM o IDB row |
| `INV-offline-queue-purged` | `src/tests/fuzz/invariants/queue.ts` (NEW) | Dopo `waitForPropagation`, `offlineQueue.getQueueLength(peerId) === 0` per peer last-sent |

**Unit tests**: `state.test.ts` (4 tests: 2 invariants × 2 cases) + extend `delivery.test.ts` (2 tests) + `queue.test.ts` (2 tests) = 8 new tests.

## 7. Regression tier invariants (5)

Runner esegue a end-of-sequence in `runSequence` finally block (prima del teardown, solo se sequence ha completato senza altri FIND) e end-of-run in `main()` prima del done-log. File unico: `src/tests/fuzz/invariants/regression.ts` (NEW).

| ID | Check | Extra infra |
|---|---|---|
| `INV-no-nip04` | `LocalRelay.getAllEvents()` non contiene `kind === 4` | Extend `LocalRelay` con `getAllEvents(): NostrEvent[]` metodo |
| `INV-idb-seed-encrypted` | Raw dump IDB `Nostra.chat.nostra_identity` non contiene substring `nsec1…` o bech32-seed plaintext | Harness helper `dumpIdentityIDB()` |
| `INV-edit-preserves-mid-timestamp` | Per ogni edit con snapshot capturing, mid+timestamp identici pre/post | Extend `editRandomOwnBubble` action per capture `action.meta.beforeSnapshot = {mid, timestamp, content}` prima del send-edit |
| `INV-edit-author-check` | IDB query: ogni row con `editedAt !== null` ha `rumor.pubkey === original.senderPubkey` | IDB iteration |
| `INV-virtual-peer-id-stable` | Pre-reload: snapshot `npub → peerId` map; post-reload: assert identico | Action `reloadPage` (Phase 2b) — invariante gate su `action?.name === 'reloadPage'` → rimane silente in 2a |

**Unit tests**: `regression.test.ts` — 5 invariants × 2 cases = 10 tests. `INV-virtual-peer-id-stable` testato ma "skipped at runtime" finché 2b non aggiunge reloadPage.

**Tier runner update**: `src/tests/fuzz/invariants/index.ts` — export `runEndOfSequence(ctx)` e `runEndOfRun(ctx)` che triggano regression tier. Chiamato da `fuzz.ts` `runSequence` finally e `main` loop end.

## 8. Regression baseline CLI

Nuovi flag:
- `--emit-baseline` — dopo un run, scrive `docs/fuzz-baseline/baseline-seed<N>.json` con `{seed, backend, maxCommands, commands[], completedAt}`. Baseline cattura l'intera sequenza eseguita (non solo un minimal trace).
- `--replay-baseline` — carica `docs/fuzz-baseline/baseline-seed42.json`, esegue il trace, fallisce se emerge qualsiasi FIND. Execution ~30s (1 iterazione = boot + N azioni senza retry).

Il baseline committato in 2a è `baseline-seed42.json` generato con 25 actions, completato clean. Futuro `pnpm fuzz --replay-baseline` in un PR Phase 2b è un 30-second smoke check che protegge contro regressioni su dup-mid / delete / react.

**Files**: `src/tests/fuzz/cli.ts` (2 nuovi flag), `src/tests/fuzz/fuzz.ts` (emit/replay logic), `src/tests/fuzz/replay.ts` (loader), nuovo `docs/fuzz-baseline/` directory.

**Unit test**: `baseline.test.ts` — emit produce valid JSON, replay consume round-trip.

## 9. Acceptance workflow (gate D)

Il PR di 2a è merge-ready solo dopo triple gate:

### 9.A — Tech gate (~35 min, automatizzato)

```bash
pnpm test:nostra:quick                        # 351+/351+ pass (no regression)
npx vitest run src/tests/fuzz/                # 35+/35+ pass (19 baseline + ~16 new)
pnpm lint                                     # 0 errors
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l  # ≤30 (vendor baseline)
FUZZ_APP_URL=http://localhost:8090 pnpm fuzz --duration=30m --max-commands=25 --seed=42
# expect: 0 NEW findings
pnpm test:e2e:all                             # all pass
```

### 9.B — 2-device manual gate (~15 min, umano)

Checklist in `docs/VERIFICATION_2A.md` (CREATE). Tu esegui su 2 device reali:
1. Onboard entrambi con identità distinte.
2. Device A → 5 text a B. Verifica ricezione su B e mid unici in DOM A.
3. Device B → reply a un messaggio di A. Verifica su A: reply bubble con mid distinto dall'originale. (Bug 1 chiuso)
4. Device A → context-menu + delete su proprio messaggio. Bubble scompare su A entro 2s. (Bug 2 chiuso)
5. Device A → reaction 👍 su messaggio. Count compare sia su A che su B. (Bug 3 chiuso)
6. Device A → hard-reload pagina. History ricaricata, 0 errori console.

Pass: commenti "PASS 2A manual" sul PR. Fail: blocker.

### 9.C — Regression baseline (~5 min, automatizzato)

1. `pnpm fuzz --duration=10m --max-commands=50 --seed=42 --emit-baseline` — produce `docs/fuzz-baseline/baseline-seed42.json` con 50-action trace completed clean.
2. Verifica immediata: `pnpm fuzz --replay-baseline` — 0 FIND, exit 0.
3. Commit `docs/fuzz-baseline/baseline-seed42.json` nel PR.

Output: ogni PR 2b+ può eseguire `pnpm fuzz --replay-baseline` in 30s per smoke regressione.

## 10. File layout changes

| File | Change |
|---|---|
| `src/components/chat/bubbles.ts` | Modify — fix 1 (dup-mid) |
| `src/lib/appManagers/appMessagesManager.ts` | Modify — fix 2 (delete P2P short-circuit) |
| `src/lib/nostra/nostra-bridge.ts` | Modify — `isP2PPeer` helper se non esiste |
| `src/lib/nostra/nostra-reactions-local.ts` | Create — fix 3 (se caso B) |
| `src/components/chat/reactions.ts` | Modify — fix 3 (display update) |
| `src/tests/nostra/bubbles-dup-mid.test.ts` | Create — unit test fix 1 |
| `src/tests/nostra/delete-messages-p2p.test.ts` | Create — unit test fix 2 |
| `src/tests/nostra/reactions-local.test.ts` | Create — unit test fix 3 |
| `src/tests/fuzz/invariants/index.ts` | Modify — uncomment noDupMid, register new invariants, add `runEndOfSequence`/`runEndOfRun` |
| `src/tests/fuzz/invariants/state.ts` | Create — medium tier (mirrors-coherent, peers-complete) |
| `src/tests/fuzz/invariants/queue.ts` | Create — medium tier (offline-queue-purged) |
| `src/tests/fuzz/invariants/delivery.ts` | Modify — extend with `deliveryTrackerNoOrphans` |
| `src/tests/fuzz/invariants/regression.ts` | Create — regression tier (5 invariants) |
| `src/tests/fuzz/invariants/state.test.ts` | Create — unit tests |
| `src/tests/fuzz/invariants/queue.test.ts` | Create — unit tests |
| `src/tests/fuzz/invariants/regression.test.ts` | Create — unit tests |
| `src/tests/fuzz/invariants/delivery.test.ts` | Create — unit tests (extend) |
| `src/tests/fuzz/postconditions/index.ts` | Modify — uncomment 2 muted postconditions |
| `src/tests/fuzz/actions/messaging.ts` | Modify — extend editRandomOwnBubble per snapshot capture |
| `src/tests/fuzz/cli.ts` | Modify — `--emit-baseline`, `--replay-baseline` |
| `src/tests/fuzz/fuzz.ts` | Modify — emit/replay baseline logic + end-of-seq/end-of-run tier calls |
| `src/tests/fuzz/replay.ts` | Modify — baseline loader |
| `src/tests/fuzz/reporter.ts` | Modify (maybe) — emit baseline format |
| `src/tests/fuzz/baseline.test.ts` | Create — emit/replay round-trip unit test |
| `src/tests/e2e/helpers/local-relay.ts` | Modify — `getAllEvents(): NostrEvent[]` method |
| `docs/VERIFICATION_2A.md` | Create — manual checklist |
| `docs/fuzz-baseline/baseline-seed42.json` | Create — regression artifact |
| `docs/fuzz-reports/FIND-cfd24d69/README.md` | Modify — status `fixed` + link al commit |
| `docs/fuzz-reports/FIND-676d365a/README.md` | Create — fix write-up |
| `docs/fuzz-reports/FIND-1526f892/README.md` | Create — fix write-up |
| `CLAUDE.md` | Modify — aggiungi note Phase 2a (~5 righe) |

## 11. Risks

| Risk | Mitigation |
|---|---|
| Fix 1 (dup-mid) più profondo di quanto stimato — bubbles.ts è 11000+ righe | Time-box diagnose step a 1-2h; se root cause non identificato, escalate (defer 2b o ask user) |
| Fix 3 (react display) caso B infra completamente mancante | Scope-limited caso B: solo sender-side, no NIP-25 relay, receive bridge in 2b. Escalate se profondo |
| Medium invariants generano falsi positivi (state drift transient) | Propagation window + actionIndex gating già nel design; fine-tune in iterazione |
| Regression baseline diventa stale con action registry change | Baseline è legato a action registry version; commit include `fuzzerVersion` field; breaking changes richiedono ri-emit |
| Unit test infra non scala (16 new tests già proposti, più crescerà) | Shared fixtures in `src/tests/fuzz/test-helpers.ts` (create se serve) |
| 2 device manual verification fallisce — bug che fuzz non ha catturato | Expand fuzz invariants/actions in 2b per coprire il gap; 2a ship su verifica umana è il gate |

## 12. Implementation phasing

PR unico `feat(fuzz): phase 2a — stability pass`. Ordinamento interno commit per atomicità:

1. (3-4 commits) Bug fix 1: dup-mid — diagnose commit + fix commit + test commit + un-mute commit
2. (2-3 commits) Bug fix 2: delete — fix + test + un-mute
3. (3-5 commits) Bug fix 3: react display — diagnose + fix (scope A o B) + test + un-mute
4. (3 commits) Medium invariants — new files + registry + tests
5. (3 commits) Regression invariants — new files + tier runner integration + tests
6. (2 commits) Baseline CLI — cli extension + emit/replay + baseline commit
7. (1 commit) Docs — VERIFICATION_2A.md + fuzz-reports updates + CLAUDE.md

Totale ~17-21 commits sul PR. Il PR viene merge-ato solo dopo triple gate (§9).

Phase 2b parte dopo merge 2a — spec separato in `docs/superpowers/specs/YYYY-MM-DD-bug-fuzzer-phase-2b-design.md`.
