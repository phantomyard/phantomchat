# Bug Fuzzer Phase 2b — Reactions RX + Lifecycle + Profile + Groups

Date: 2026-04-19
Status: Design approved, ready for planning
Supersedes scope in: [`2026-04-17-bug-fuzzer-design.md`](2026-04-17-bug-fuzzer-design.md) §17 (Phase 2, Phase 3 partial)
Follows: [`2026-04-18-bug-fuzzer-phase-2a-design.md`](2026-04-18-bug-fuzzer-phase-2a-design.md)

## 1. Motivation

Phase 2a ha chiuso i 3 blocker P2P core messaging (dup-mid render, delete local-gone, react sender-side display) e committato il primo regression baseline replay-abile in 30s. La superficie 1:1 messaging è ora considerata stabile sotto fuzz.

Phase 2b estende la superficie fuzz al resto del prodotto Nostra:
- **Reactions bilaterali** — receive-side NIP-25 completo (publish, receive, remove, multi-emoji, aggregazione) — chiude lo user story "entrambi i lati vedono la reaction".
- **Lifecycle chaos ridotto** — page reload (pure + during-pending-send) e delete-while-sending race per esporre offline-queue + persistence bug.
- **Profile management** — edit name/bio/avatar/NIP-05 con verifica cross-peer propagation via NIP-65 relay fetch.
- **Groups completi** — create/send/add/remove/leave con triplo harness user (userA/B/C) per testare realmente membership change.

Cinque FIND aperti da overnight Phase 2a vengono ri-triagati all'inizio di 2b.1 — alcuni (`FIND-9df3527d`, `FIND-f7b0117c` — "y " trailing-space) potrebbero essere già stati chiusi dal commit `633aed78` (trim in `INV-sent-bubble-visible-after-send`); altri (`FIND-2fda8762`, `FIND-7fd7bc72` — tweb `reaction.ts` crash su `center_icon`/`sticker`) stanno nello stesso asse delle reactions RX e vanno risolti dentro la stessa patch.

Al termine di Phase 2b, resta come Phase 3 solo: chaos actions (flaky relay, connectivity loss), Tor runtime backend, `--pairs>1`, UI contract manifest, cross-platform rendering checks.

## 2. Goals

- **Reactions NIP-25 completo** (publish + receive + remove + multi-emoji + aggregazione) + fix 2 crash tweb `reaction.ts` legacy + chiusura 5 FIND aperti da 2a.
- **Lifecycle actions** — `reloadPage` (2 varianti: pure + during-pending-send), `deleteWhileSending` (race action mirata).
- **Attivazione `INV-virtual-peer-id-stable`** (già scritta in 2a, ora triggerata da `reloadPage`).
- **Profile core 4** — `editName`, `editBio`, `uploadAvatar`, `setNip05` + cross-peer propagation invariant.
- **Groups completi** con 3° harness user `userC` — create/send/add/remove/leave + `INV-group-wrap-count` + membership invariants.
- **1 regression baseline attivo** in ogni momento: `v2b1` attivo dopo merge 2b.1 (sostituisce `v2a`), rimpiazzato da `v2b2` dopo 2b.2, da `v2b3` dopo 2b.3. Replay-able in ≤ 90s.
- **Triple gate per sub-PR** (tech + N-device manual + baseline replay) — zero mute invariants, zero open FIND al merge di 2b.3.

## 3. Non-goals

- **Chaos actions** (`flakyRelay`, `connectivityLoss`) — Phase 3.
- **Tor backend** — Phase 3.
- **`--pairs>1`** parallel fuzz contexts — Phase 3.
- **UI contract manifest** — Phase 3.
- **Cross-platform rendering checks** — Phase 3.
- **Group size > 3** — Phase 3 (richiede più del 3° user).
- **Gruppi `addGroupMember` su nuovo user non-nel-harness** — 3° user fisso userC; 4° user = Phase 3.
- **Profile banner, lud16, zaps** — non core, Phase 3.

## 4. Architecture

Phase 2b è splittata in **3 sub-PR sequenziali**, ognuno autosufficiente e merge-ato indipendentemente:

| Sub-PR | Titolo | Stima scope | Gate | Deliverable utente |
|---|---|---|---|---|
| **2b.1** | reactions NIP-25 + stabilization | ~50% Phase 2b | Triple gate | Reactions bilaterali full, 5 FIND chiusi |
| **2b.2** | lifecycle + profile | ~30% | Triple gate | reloadPage + delete-race invariants, profile edit propagato cross-peer |
| **2b.3** | groups completo | ~20% | Triple gate (3-device) | Groups 2-3 member con membership change |

**Ordine obbligato**:
- **2b.1 prima**: le 2 FIND in `reaction.ts` stanno nella stessa patch delle reactions NIP-25 — refactorare metà tweb reactions path e poi ri-toccarlo è spreco. Profile e groups inducono nuova reactions UI surface che beneficia da baseline RX già stabile.
- **2b.2 prima di 2b.3**: `reloadPage` + offline-queue invariants rivelano persistence bug che si mascherano in groups (N recipients = N opportunità di race).
- **2b.3 chiude**: la surface più ampia, l'ultima a consolidarsi.

**Cross-sub-PR principles:**
- Ogni sub-PR committa il proprio `docs/fuzz-baseline/baseline-seed42-v2bN.json` e **rimpiazza** quello del sub-PR precedente (sempre 1 file attivo, non accumulato).
- Nessun sub-PR può mute invariants esistenti (no backsliding).
- `fuzzerVersion` nel baseline JSON bumpa `'phase2a'` → `'phase2b1'` → `'phase2b2'` → `'phase2b3'`. Baseline vecchi diventano stale e `--replay-baseline` fallisce graceful con "stale fuzzer version, re-emit required".
- Ogni sub-PR esegue **triple gate** (tech + N-device manual + baseline replay) prima del merge.

## 5. Sub-PR 2b.1 — reactions NIP-25 + stabilization

### 5.1 FIND re-triage (primo commit, solo verifica)

Replay deterministico di ciascuno dei 5 FIND aperti contro `main` post-2a prima di toccare codice:

```bash
pnpm fuzz --replay=FIND-9df3527d  # "y " trailing-space, POST-sendText-bubble-appears
pnpm fuzz --replay=FIND-f7b0117c  # stesso "y ", INV-sent-bubble-visible-after-send
pnpm fuzz --replay=FIND-2f61ff8b  # Solid "createRoot" leak post-react
pnpm fuzz --replay=FIND-2fda8762  # reaction.ts center_icon crash post-delete
pnpm fuzz --replay=FIND-7fd7bc72  # wrapSticker 'sticker' crash post-scroll
```

Esito atteso:
- `FIND-9df3527d`, `FIND-f7b0117c` — probabilmente `not reproduced` (fix già in main via commit `633aed78`). Status → `fixed-in-2a`.
- `FIND-2f61ff8b` — investigare: Solid `createRoot` leak post-react. Probabilmente collegato al ciclo render della reactions UI; può essere chiuso dal refactor reactions in 5.2.
- `FIND-2fda8762`, `FIND-7fd7bc72` — affrontati direttamente dentro 5.2 come parte del reactions RX refactor.

Output: ciascun FIND ha `docs/fuzz-reports/FIND-xxx/README.md` con status `fixed-in-2a` | `reproduced` | `fixed-in-2b1-commit-<sha>`. `docs/FUZZ-FINDINGS.md` aggiornato.

### 5.2 Reactions NIP-25 — architettura

**Data model NIP-25.** Reaction = kind-7 event con tags `['e', targetEventId]`, `['p', targetAuthor]`, `content = emoji` (o `+` / `-`). Remove = kind-5 delete event targetando il kind-7 event id (stesso pattern NIP-09 delete messaggi già in uso).

**Module layout:**

```
src/lib/nostra/nostra-reactions-local.ts     # MODIFY — store ora backed da relay
src/lib/nostra/nostra-reactions-publish.ts   # NEW    — publish kind-7 via ChatAPI
src/lib/nostra/nostra-reactions-receive.ts   # NEW    — subscribe kind-7, dispatch
src/lib/nostra/nostra-reactions-store.ts     # NEW    — IDB-backed (nostra-reactions)
src/components/chat/reaction.ts              # MODIFY — fix center_icon/sticker guards + wire to store
src/lib/appManagers/appReactionsManager.ts   # MODIFY — sendReaction shortcut per P2P peers
src/lib/nostra/virtual-mtproto-server.ts     # MODIFY — messages.sendReaction handler
src/lib/nostra/chat-api.ts                   # MODIFY — extend initGlobalSubscription a kinds [1059, 7, 5]
```

**Pipeline send (A reagisce 👍 su bubble di B):**
1. UI click → `appReactionsManager.sendReaction()` — P2P peer → shortcut Nostra
2. `nostraReactionsPublish.publish(targetEventId, targetPubkey, emoji)` → kind-7 via relay pool + append locally
3. `nostraReactionsStore.add({targetEventId, fromPubkey: me, emoji, reactionEventId})` → IDB persist
4. `rootScope.dispatchEventSingle('messages_reactions', {peerId, mid})` → bubble subscribe → re-render reactions area

**Pipeline receive (B riceve reaction di A):**
1. Global relay subscription in `initGlobalSubscription()` (`chat-api.ts`) estesa con `{kinds: [1059, 7, 5], '#p': [ownPubkey]}` — filter `#p` per evitare flood.
2. `RelayPool.handleIncomingMessage` → se `event.kind === 7` → delega a `nostraReactionsReceive.onKind7`.
3. Author verification: tag `['p']` contiene `ownPubkey` (io sono target). Se no → drop (non per me).
4. Target resolution: `targetEventId` da tag `['e']` → resolve via `message-store.getByEventId(eventId)` → se no match, **buffer 5s** in `nostraReactionsPendingBuffer` (out-of-order tolerance: kind-7 può arrivare prima del kind-1059 gift-wrap del msg originale); dopo 5s senza match → drop silent con console.debug.
5. `nostraReactionsStore.add(...)` dedupe per `(targetEventId, fromPubkey, emoji)` compound key.
6. Dispatch `messages_reactions` → bubble render.

**Pipeline remove (A rimuove 👍):**
1. UI click su reaction già propria → `nostraReactionsPublish.unpublish(reactionEventId)` → kind-5 delete targetando kind-7 event id.
2. Store update: `nostraReactionsStore.remove(reactionEventId)` → dispatch → bubble re-render.

**Multi-emoji per user**: store keyed by `(targetEventId, fromPubkey, emoji)`. Aggregazione conta per emoji: `{'👍': 2, '❤️': 1}` per lo stesso target.

**Fix crash tweb `reaction.ts`** (FIND-2fda8762, FIND-7fd7bc72):
- Root cause: `availableReaction` è `undefined` perché `messages.getAvailableReactions` in Nostra mode ritorna stub vuoto.
- **Approach (diagnose-first)**:
  1. Replay i 2 FIND contro `main` post-2a. Identifica l'access path esatto (line exact) — current: line 340 ha `if(!availableReaction) return;` ma line 630 no (`doc: sticker || availableReaction.center_icon`), line 416 potenzialmente no.
  2. **Primary fix — guard pattern completo** in tutti gli access site che mancano. Surgical, no feature flag.
  3. **Fallback (solo se il refactor è troppo invasivo)**: feature flag `NOSTRA_SKIP_REACTION_STICKER_RENDER = true` che bypassa `renderReactionWithStickerMaybe` per P2P peers (display emoji plain text). Decisione time-boxed a 2h di diagnosi; se guard-only non è fattibile, escalate a fallback.

**Relay subscription fanout mitigation**: filter `{kinds: [1059, 7, 5], '#p': [ownPubkey]}` — solo eventi dove io sono taggato. Standard NIP-25 practice.

### 5.3 Azioni (registry update)

| Azione | Esistente | 2b.1 change |
|---|---|---|
| `reactToRandomBubble` | ✓ | weight ↑ 8→12; arg `fromTarget` ∈ {'own', 'peer'} per forzare cross-direction |
| `removeReaction` | no | NEW — pick own reaction random → unpublish → verify disappears bilateralmente |
| `reactMultipleEmoji` | no | NEW — single bubble, stesso user, 2-3 emoji distinti — verifica aggregazione |

### 5.4 Invariants & postconditions nuove

| ID | Tier | Check |
|---|---|---|
| `INV-reaction-bilateral` | medium | Per ogni kind-7 event in mio IDB, peer ha stesso record entro propagation window (5s) |
| `INV-reaction-dedupe` | cheap | `nostraReactionsStore.getAll(targetMid, fromPubkey, emoji)` ha ≤ 1 row |
| `INV-reaction-author-check` | regression | Ogni row in `nostra-reactions` con `fromPubkey === rumor.pubkey` del kind-7 originante |
| `INV-no-kind7-self-echo-drop` | cheap | Own kind-7 published → proprio store ha la row (no drop da relay echo) |
| `INV-reaction-remove-kind` | regression | Ogni `removeReaction` genera kind-5 event su relay (non kind-7 con content vuoto) |
| `POST_react_peer_sees_emoji` | postcondition | Dopo `reactToRandomBubble`, entro 3s il peer ha la reaction nel suo DOM bubble |
| `POST_remove_reaction_peer_disappears` | postcondition | Dopo `removeReaction`, entro 3s la reaction sparisce su peer DOM |
| `POST_react_multi_emoji_separate` | postcondition | Dopo `reactMultipleEmoji`, DOM mostra distinte row emoji/count |

### 5.5 Baseline update

Genera `docs/fuzz-baseline/baseline-seed42-v2b1.json` con ~50 azioni che includono ≥3 `reactToRandomBubble`, ≥1 `removeReaction`, ≥1 `reactMultipleEmoji`. `baseline-seed42.json` di 2a viene **rimosso** (un solo file attivo). CLI `--replay-baseline` carica il file `v2bN.json` più recente nel repo; fail graceful su stale.

### 5.6 Acceptance 2b.1

**Tech gate** (§9.A-equivalente di 2a):

```bash
pnpm test:nostra:quick
npx vitest run src/tests/fuzz/
pnpm lint
npx tsc --noEmit
FUZZ_APP_URL=http://localhost:8090 pnpm fuzz --duration=30m --max-commands=50 --seed=42
pnpm fuzz --replay-baseline
pnpm test:e2e:all
```

Expect: 0 NEW finds, 0 mute, 0 open FIND post-triage.

**2-device manual** (`docs/VERIFICATION_2B1.md`):
1. A reagisce 👍 su msg di B → B vede 👍 entro 3s.
2. A aggiunge ❤️ sullo stesso → B vede 👍+❤️.
3. A rimuove 👍 → B vede solo ❤️.
4. B reagisce 🔥 su msg di A → A vede 🔥.
5. A e B reagiscono entrambi 👍 sullo stesso msg di A → entrambi vedono count=2.

**Baseline replay**: `pnpm fuzz --replay-baseline` exit 0 in < 60s.

### 5.7 Ship-as-is adjustments — carry-forward to 2b.2

The 2b.1 triple gate adapted from the original spec §5.6:
- **Tech gate**: reduced to unit+integration test suite + lint + tsc. The 30-min fuzz run and `--replay-baseline` deferred to 2b.2.
- **2-device manual**: unchanged — user verifies reactions RX bilateral on 2 devices.
- **Baseline emit**: deferred to 2b.2. Architectural identity triple fix (commit `2426ec6d`) validated via 8 clean fuzz iterations and seed=48 direct run, but the richer 2b.1 action registry (reactToRandomBubble w/ fromTarget, removeReaction, reactMultipleEmoji) surfaces 3 pre-existing bugs that block emit gate `findings === 0`.

Carry-forward issues (documented in `docs/FUZZ-FINDINGS.md` as open):
- FIND-c0046153 — `INV-bubble-chronological` — out-of-order delivery causes bubbles to render in non-chronological DOM order
- FIND-bbf8efa8 — `POST_react_multi_emoji_separate` — multi-emoji aggregation render issue
- FIND-eef9f130 — `POST-sendText-input-cleared` — chat input not cleared after send (introduced by keyboard.insertText migration for FIND-3c99f5a3)

Phase 2b.2 scope absorbs: baseline v2b1 emit, 3 open FINDs triage + fix.

## 6. Sub-PR 2b.2 — lifecycle + profile

### 6.1 Lifecycle actions

**`reloadPage` action** — 2 varianti:

```ts
// action.args: {user: UserId, mode: 'pure' | 'during-pending-send'}
```

- **`pure`**: `snapshotPreReloadState(user)` → `user.page.reload({waitUntil: 'load'})` → wait rehydrate (history visible, peer mirror populated, 0 pageerror post-boot).
- **`during-pending-send`**: `user.page.evaluate(() => fireSendWithoutAwait(text))` → `setTimeout(action.args.raceWindowMs || 80ms)` → `user.page.reload()`. Il send in-flight o finisce e arriva al peer, o è ri-enqueued offline e flushato post-rehydrate. Mai lost-in-the-middle.

Snapshot pre-reload: `ctx.snapshots.set('preReloadPeerMap-<user>', {npub→peerId})` e `preReloadHistorySig-<user>` (hash SHA-256 dei `data-mid` visibili + count). Post-reload, invariants confrontano.

**`deleteWhileSending` action** (pseudocodice, real drive usa le API esistenti `appMessagesManager.sendMessage` + `appMessagesManager.deleteMessages` come in `messaging.ts`):

```ts
async drive(ctx, action) {
  const sender = ctx.users[action.args.user];
  const text = 'race-test-' + Date.now();
  // Fire send without awaiting — stored on window for later inspection
  await sender.page.evaluate((t) => {
    const rs = (window as any).rootScope;
    const peerId = (window as any).appImManager?.chat?.peerId;
    (window as any).__nostraPendingSend = rs.managers.appMessagesManager.sendText({peerId, text: t});
  }, text);
  await sender.page.waitForTimeout(action.args.raceWindowMs || 80);
  // Inspect mirrors for latest temp mid (P2P temp mids start at 0.0001)
  const tempMid = await sender.page.evaluate(() => {
    const proxy = (window as any).apiManagerProxy;
    const peerId = (window as any).appImManager?.chat?.peerId;
    const hist = proxy?.mirrors?.messages?.[`${peerId}_history`] || {};
    const mids = Object.keys(hist).map(Number).filter((m) => m < 1);
    return mids.length ? Math.max(...mids) : null;
  });
  if(tempMid) {
    await sender.page.evaluate((m) => {
      const rs = (window as any).rootScope;
      const peerId = (window as any).appImManager?.chat?.peerId;
      return rs.managers.appMessagesManager.deleteMessages(peerId, [m], true);
    }, tempMid);
  }
  await sender.page.evaluate(() => (window as any).__nostraPendingSend?.catch(() => {}));
  action.meta = {raceWindowMs: action.args.raceWindowMs || 80, tempMid, text};
}
```

Non-determinism è intrinseco (send può completare prima o dopo il delete dipende dal Promise scheduler); replay fidelity garantita da persistenza di `raceWindowMs` in `action.meta`. Plan esprime i dettagli API esatti contro le signature reali di `appMessagesManager`.

### 6.2 Lifecycle invariants

| ID | Tier | Check |
|---|---|---|
| `INV-virtual-peer-id-stable` | regression | **ATTIVATA** — già scritta in `regression.ts:127`, ora triggerata da `action.name === 'reloadPage'` |
| `INV-history-rehydrates-identical` | medium | Post-reload: DOM bubble count + mid set ≡ pre-reload snapshot (entro 8s, `waitForFunction` su `apiManagerProxy.mirrors` populated) |
| `INV-offline-queue-persistence` | medium | Se `offlineQueue` non-empty al reload, queued msg sono in IDB `nostra-messages` con `isOffline: true` marker + flushate post-reconnect |
| `INV-no-dup-after-delete-race` | cheap | Dopo `deleteWhileSending`: DOM del sender ha ≤ 1 bubble; peer ha ≤ 1 bubble (ricevuto poi rimosso coerentemente, o mai ricevuto — NON duplicato) |
| `INV-no-orphan-tempmid-post-reload` | medium | Post-reload, nessun bubble DOM ha `data-mid` matching pattern temp (`0.0001`, `0.0002`, etc.) |

### 6.3 Profile actions

| Azione | Args | Drive |
|---|---|---|
| `editName` | `{user, newName: string_3_20}` | UI path: sidebar → profile edit → name input → save. Postcondition: kind 0 event content.name === newName su relay entro 3s |
| `editBio` | `{user, newBio: string_0_140}` | Analogo, bio field |
| `uploadAvatar` | `{user}` | Stub PNG deterministico via `page.setInputFiles(...)` + mock Blossom endpoint (`window.__nostraMockBlossom = true` injection) che ritorna URL `blossom-mock://<sha256>`. Action skippa se mock non inietta |
| `setNip05` | `{user, identifier: string_matching_email_pattern}` | Input NIP-05 field → save. NO verification round-trip — test solo persistence + publish |

**Blossom mock script** (iniettato in `harness.ts`):

```ts
context.addInitScript(() => {
  (window as any).__nostraMockBlossom = true;
  const origFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if(url.includes('/blossom/upload')) {
      const body = init?.body;
      const hash = await sha256Hex(body as ArrayBuffer);
      return new Response(JSON.stringify({url: `blossom-mock://${hash}`}), {status: 200});
    }
    return origFetch(input, init);
  };
});
```

### 6.4 Profile invariants

| ID | Tier | Check |
|---|---|---|
| `INV-profile-propagates` | medium | Dopo `editName(userA, "NewName")`: entro 5s `userB.apiManagerProxy.mirrors.peers[peerIdA].first_name === "NewName"` |
| `INV-profile-kind0-single-active` | regression | Per ogni pubkey autore, al più 1 kind-0 event su relay con `created_at` più recente è l'active; non deve esistere ambiguità multi-attive |
| `INV-profile-cache-coherent-with-store` | cheap | `localStorage['nostra:cached-profile']` parsato ≡ `nostraIdentity` Solid store value |
| `POST_editName_cache_updated` | postcondition | Dopo `editName`, `localStorage['nostra:cached-profile']` parsato ha `name === newName` entro 500ms |
| `POST_editName_relay_published` | postcondition | Dopo `editName`, `LocalRelay.getAllEvents()` contiene kind-0 event con `pubkey === ownPubkey` e `content.name === newName` entro 3s |

### 6.5 Baseline update

Genera `baseline-seed42-v2b2.json` con ~50 azioni includendo ≥2 `reloadPage` (uno per variante), ≥1 `deleteWhileSending`, ≥3 profile actions (mix di 4 tipi), più il mix 2b.1. Rimpiazza `baseline-seed42-v2b1.json`.

### 6.6 Acceptance 2b.2

**Tech gate**: full suite + 30m fuzz run + `--replay-baseline` passes + 0 mute.

**2-device manual** (`docs/VERIFICATION_2B2.md`):
1. Device A edit name "Alice" → "Alice2" → Device B vede cambio entro 5s.
2. Device A upload avatar (PNG reale via file picker) → Device B vede nuovo avatar entro 5s.
3. Device A set NIP-05 `alice@example.com` → Device B vede badge NIP-05 o kind-0 content.nip05 presente.
4. Device A: paste 1000 chars + send + immediate hard-reload → message arriva a B oppure bubble nulla (never-sent, consistente), no duplicate.
5. Device A: reload dopo 10 messaggi scambiati → history identica pre/post, peer B id stabile.

**Baseline replay**: exit 0.

## 7. Sub-PR 2b.3 — groups completo

### 7.1 Harness extension — 3° user

`FuzzContext.users` diventa `{userA, userB, userC}`. `linkContacts` diventa triplo (A↔B, A↔C, B↔C). Boot time cresce da ~20s a ~30s (+~50%). Tutte le invariants/postconditions esistenti che iterano `['userA', 'userB']` → `['userA', 'userB', 'userC']`. Cambio meccanico, no logica nuova.

File impattati:
- `src/tests/fuzz/harness.ts` — triple `createUser` + triple `linkContacts`; signature `HarnessOptions` invariata.
- `src/tests/fuzz/types.ts` — `UserId = 'userA' | 'userB' | 'userC'`.
- `src/tests/fuzz/actions/messaging.ts` — `fc.constantFrom('userA', 'userB', 'userC')` replacing binary picks.
- `src/tests/fuzz/invariants/*.ts` — loops `['userA', 'userB']` → esteso.
- `src/tests/e2e/helpers/local-relay.ts` — `getAllEvents({since, until}?)` extended con time filter.

### 7.2 Groups actions

Gruppi Nostra usano NIP-17 + NIP-59 gift-wrap per-member: `sendGroupMessage` a gruppo di N produce N kind-1059 eventi **distinti** (uno per recipient, ciascuno cifrato separatamente), che **condividono la stessa finestra `created_at`** (emessi quasi-simultaneamente entro ±1s). Sender non pubblica il proprio wrap su relay — lo persiste localmente.

| Azione | Args | Drive | Weight |
|---|---|---|---|
| `createGroup` | `{creator, members: subset_of_other_users_size_1_or_2, name}` | `window.groupApi.createGroup(name, memberPubkeys)` | 4 |
| `sendGroupMessage` | `{group: groupId, from, text}` | Apri chat group, type, send | 10 |
| `addGroupMember` | `{group, newMember: user_not_in_group}` | Skipped se gruppo ha già tutti e 3 gli harness user o se `newMember` non è uno dei 3 harness user | 2 |
| `removeGroupMember` | `{group, targetMember, actor}` | Drop random member, actor ≠ target | 2 |
| `leaveGroup` | `{group, user: member_of_group}` | Control message member-leave | 1 |

`ctx.snapshots.set('activeGroups', Array<{id, members[], name}>)` aggiornato dalle azioni, consultato per argument generation (validità). Azioni senza argomenti validi → skipped.

### 7.3 Groups invariants

| ID | Tier | Check |
|---|---|---|
| `INV-group-wrap-count` | medium | Dopo `sendGroupMessage` in gruppo di N: `LocalRelay.getAllEvents({since: sendTs-1, until: sendTs+5})` contiene exactly N kind-1059 eventi |
| `INV-group-membership-coherent` | medium | `group-store.members[groupId]` identico su tutti i member (tutti i device vedono la stessa lista) |
| `INV-group-send-all-receive` | medium | Dopo `sendGroupMessage` da X su gruppo G: tutti i member ≠ X hanno il message nel DOM entro 5s |
| `INV-group-leave-no-future-msg` | regression | Per ogni `leaveGroup(G, X)` seguito da `sendGroupMessage(G, ...)`: X non ha il nuovo message né in IDB né in DOM |
| `INV-group-add-backfill-aware` | medium | Dopo `addGroupMember(G, newX)`: il nuovo member riceve i FUTURI message, non backfill del passato (NIP-17 default forward-only). Verifica no-error, no-backfill |
| `INV-group-kind40-author` | regression | Ogni control message (kind-40 create, kind-41 add, kind-42 remove, kind-43 leave) ha `pubkey === actor_user_pubkey` — no forged events |

**Postconditions:**

| ID | Action | Check |
|---|---|---|
| `POST_createGroup_members_visible` | createGroup | Creator sidebar mostra gruppo entro 2s; ogni member (non creator) vede notification entro 3s |
| `POST_sendGroupMessage_all_bubbles` | sendGroupMessage | Bubble appare su tutti i member ≠ sender entro 5s + sender DOM ha bubble `is-out` |
| `POST_leaveGroup_sidebar_removed` | leaveGroup | Group sparisce dalla sidebar del leaving user entro 2s |
| `POST_removeGroupMember_kicked_sees_removal` | removeGroupMember | Kicked user vede disconnect dal group (sidebar entry removed o marked left) entro 3s |

### 7.4 Baseline update

Genera `baseline-seed42-v2b3.json` con ~60 azioni (max-commands aumentato per coprire 3-user + group lifecycle) includendo: ≥1 createGroup, ≥5 sendGroupMessage, ≥2 member change (add/remove), ≥1 leaveGroup, più mix 1:1 e profile/reactions da 2b.1+2b.2. Rimpiazza `baseline-seed42-v2b2.json`.

### 7.5 Acceptance 2b.3

**Tech gate**: full suite + 30m fuzz run con 3 user + `--replay-baseline` passes + 0 mute + 0 NEW finds.

**3-device manual** (`docs/VERIFICATION_2B3.md`):
- Carve-out per maintainer senza 3 device fisici: 2 device reali + 3° browser profile isolato sulla stessa macchina (storage isolato, loopback OK).
- Protocollo:
  1. A crea gruppo "FuzzTest" con B e C → B e C ricevono notification, vedono gruppo entro 5s.
  2. A manda msg al gruppo → B e C lo vedono entro 3s.
  3. B manda msg → A e C lo vedono.
  4. A rimuove C → C vede removal (sidebar entry); A invia msg → C non lo riceve.
  5. A ri-aggiunge C → C riceve messaggi futuri.
  6. B leaves → A e C non vedono più B come member; B non riceve più messaggi.

**Baseline replay**: 3-user baseline in < 90s.

## 8. File layout changes (cumulativo Phase 2b)

### 8.1 Sub-PR 2b.1

| File | Change |
|---|---|
| `src/lib/nostra/nostra-reactions-local.ts` | Modify — extends relay-backed |
| `src/lib/nostra/nostra-reactions-publish.ts` | Create |
| `src/lib/nostra/nostra-reactions-receive.ts` | Create |
| `src/lib/nostra/nostra-reactions-store.ts` | Create (IDB `nostra-reactions`) |
| `src/lib/nostra/chat-api.ts` | Modify — extend `initGlobalSubscription` a `{kinds: [1059, 7, 5], '#p': [ownPubkey]}` |
| `src/lib/nostra/virtual-mtproto-server.ts` | Modify — `messages.sendReaction` handler |
| `src/lib/appManagers/appReactionsManager.ts` | Modify — P2P shortcut |
| `src/components/chat/reaction.ts` | Modify — fix `center_icon` / `sticker` guards (diagnose-first) + wire to store |
| `src/tests/nostra/reactions-nip25.test.ts` | Create — E2E publish+receive+remove |
| `src/tests/nostra/reactions-local.test.ts` | Extend |
| `src/tests/fuzz/actions/messaging.ts` | Modify — extend reactToRandomBubble; `removeReaction`, `reactMultipleEmoji` added |
| `src/tests/fuzz/actions/index.ts` | Modify — register |
| `src/tests/fuzz/invariants/reactions.ts` | Create — 5 invariants |
| `src/tests/fuzz/invariants/reactions.test.ts` | Create |
| `src/tests/fuzz/postconditions/messaging.ts` | Modify — 3 new postconditions |
| `docs/fuzz-baseline/baseline-seed42.json` | Delete |
| `docs/fuzz-baseline/baseline-seed42-v2b1.json` | Create |
| `docs/fuzz-reports/FIND-*/README.md` × 5 | Modify — triage status |
| `docs/FUZZ-FINDINGS.md` | Update — close/reclassify 5 |
| `docs/VERIFICATION_2B1.md` | Create |
| `CLAUDE.md` | Modify — aggiungi note 2b.1 (~5 righe) |

### 8.2 Sub-PR 2b.2

| File | Change |
|---|---|
| `src/tests/fuzz/actions/lifecycle.ts` | Create — `reloadPage`, `deleteWhileSending` |
| `src/tests/fuzz/actions/profile.ts` | Create — 4 profile actions |
| `src/tests/fuzz/actions/index.ts` | Modify — register |
| `src/tests/fuzz/invariants/lifecycle.ts` | Create — 3 invariants |
| `src/tests/fuzz/invariants/queue.ts` | Modify — `INV-offline-queue-persistence` |
| `src/tests/fuzz/invariants/regression.ts` | Modify — attivazione `virtualPeerIdStable` + `INV-profile-kind0-single-active` |
| `src/tests/fuzz/invariants/profile.ts` | Create — 2 invariants |
| `src/tests/fuzz/postconditions/profile.ts` | Create — `POST_editName_*`, etc. |
| `src/tests/fuzz/postconditions/index.ts` | Modify — register |
| `src/tests/fuzz/harness.ts` | Modify — Blossom mock `addInitScript` |
| `src/tests/fuzz/invariants/*.test.ts` | Create |
| `docs/fuzz-baseline/baseline-seed42-v2b1.json` | Delete |
| `docs/fuzz-baseline/baseline-seed42-v2b2.json` | Create |
| `docs/VERIFICATION_2B2.md` | Create |
| `CLAUDE.md` | Modify — aggiungi note 2b.2 |

### 8.3 Sub-PR 2b.3

| File | Change |
|---|---|
| `src/tests/fuzz/harness.ts` | Modify — 3° user `userC`, triple linkContacts |
| `src/tests/fuzz/types.ts` | Modify — `UserId` union add `userC` |
| `src/tests/fuzz/actions/groups.ts` | Create — 5 group actions |
| `src/tests/fuzz/actions/index.ts` | Modify — register |
| `src/tests/fuzz/actions/messaging.ts` | Modify — 3-user argument generation |
| `src/tests/fuzz/invariants/groups.ts` | Create — 6 invariants |
| `src/tests/fuzz/invariants/*.ts` | Modify — loops 2-user → 3-user |
| `src/tests/fuzz/postconditions/groups.ts` | Create — 4 postconditions |
| `src/tests/fuzz/postconditions/index.ts` | Modify — register |
| `src/tests/e2e/helpers/local-relay.ts` | Modify — `getAllEvents({since, until}?)` time filter |
| `docs/fuzz-baseline/baseline-seed42-v2b2.json` | Delete |
| `docs/fuzz-baseline/baseline-seed42-v2b3.json` | Create |
| `docs/VERIFICATION_2B3.md` | Create — 3-device checklist |
| `CLAUDE.md` | Modify — aggiungi note Phase 2b complete |

## 9. Risks

| Risk | Sub-PR | Mitigation |
|---|---|---|
| **tweb `reaction.ts` refactor cascade** — fix `center_icon`/`sticker` crashes può richiedere rethinking Nostra stub per `getAvailableReactions` | 2b.1 | **Primary**: diagnose-first + surgical guard pattern in access site mancanti (§5.2). **Fallback, solo se primary non fattibile in 2h**: feature flag `NOSTRA_SKIP_REACTION_STICKER_RENDER` che short-circuita `renderReactionWithStickerMaybe` per P2P peers (emoji plain text). No UI regression (peer non aveva comunque animations P2P) |
| **NIP-25 remove semantics ambiguous** — alcuni client usano kind-5, altri kind-7 con content vuoto. Peer potrebbero non interoperare | 2b.1 | Scegli kind-5 (stesso pattern NIP-09 delete già in uso); documenta in commit; `INV-reaction-remove-kind` garantisce |
| **Relay subscription fanout** — aggiungere `kind: 7, 5` alla global subscription aumenta traffic | 2b.1 | Filter `{kinds: [1059, 7, 5], '#p': [ownPubkey]}` — solo eventi dove io sono taggato |
| **reloadPage flakiness** — rehydrate timing dipende da Vite dev server speed | 2b.2 | `INV-history-rehydrates-identical` con wait window 8s + explicit `waitForFunction` su `apiManagerProxy.mirrors` populated, no hope-based timeout |
| **deleteWhileSending race non deterministic** — `setTimeout` può finire in qualunque punto del send pipeline | 2b.2 | Replay fidelity via `action.meta.raceWindowMs` persistence. Non elimina non-determinism ma garantisce replay consistency |
| **Blossom mock potrebbe divergere dal reale** — test pass ma prod rompe su upload reale | 2b.2 | Accept risk, mitigato da 2-device manual checklist step 2 (upload PNG reale) |
| **3° user onboarding +~10s boot** — fuzz iteration time cresce, meno iter per minuto | 2b.3 | Accept — 2b.3 budget è ridotto (20%), fewer iter OK. 30m target 3-5 iter invece di 8-10 |
| **3-device manual verification impractical** — maintainer potrebbe non avere 3 device fisici | 2b.3 | Accept carve-out 2 device reali + 3° browser profile isolato; documenta in `VERIFICATION_2B3.md` |
| **Group control messages schema instability** — kind-40/41/42/43 API interne non-standard Nostr | 2b.3 | Documenta exact kinds used in `group-control-messages.ts`; invariants validate pubkey ma non semantic (che è testato dai postconditions end-to-end) |
| **Triple gate fatica — 3× sub-PR × manual × baseline = 9 gate passes** | tutti | Accept; maintainer può parallelizzare tech gate (automated, overnight) con manual (live). Spec documenta workflow per minimizzare overlap |
| **Baseline versioning regressioni** — action registry cambiato tra sub-PR rende v2b1 stale post-merge 2b.2 | tutti | `fuzzerVersion` check in loader con graceful fail + re-emit istruzione. Ogni sub-PR aggiorna baseline |

## 10. Implementation phasing

**Commit structure per sub-PR:**

- **2b.1**: ~20-30 commits
  1. FIND re-triage (1-2 commits — update READMEs)
  2. Reactions store + publish + receive modules (3-4 commits)
  3. tweb `reaction.ts` fix diagnose + fix (2-3 commits)
  4. Integration + wiring (VMT, appReactionsManager) (2-3 commits)
  5. Fuzz actions + invariants + postconditions (3-5 commits)
  6. Vitest unit tests (2-3 commits)
  7. Baseline emit + commit (1 commit)
  8. Docs (VERIFICATION_2B1, FUZZ-FINDINGS, CLAUDE.md) (1-2 commits)

- **2b.2**: ~15-20 commits
  1. Lifecycle actions (2 commits — reloadPage, deleteWhileSending)
  2. Lifecycle invariants + tests (2-3 commits)
  3. Profile actions (2-3 commits — 4 actions + Blossom mock)
  4. Profile invariants + postconditions + tests (2-3 commits)
  5. Regression tier virtualPeerIdStable activation (1 commit)
  6. Baseline emit + commit (1 commit)
  7. Docs (1-2 commits)

- **2b.3**: ~15-20 commits
  1. Harness 3-user extension (2-3 commits)
  2. Existing invariants loops extension (1-2 commits)
  3. Group actions (2-3 commits)
  4. Group invariants + postconditions + tests (3-4 commits)
  5. LocalRelay `getAllEvents` time filter (1 commit)
  6. Baseline emit + commit (1 commit)
  7. Docs (1-2 commits)

**Sequenza merge:**

```
main → 2b.1 PR → triple gate → merge → main (reactions RX complete)
     → rebase 2b.2 PR → triple gate → merge → main (lifecycle + profile)
     → rebase 2b.3 PR → triple gate → merge → main (groups complete = Phase 2b done)
```

Ogni merge è safe-stop: se maintainer burnout post-2b.1, progetto è strict progress rispetto a 2a (reactions RX completo è user-facing milestone).

## 11. Success criteria (Phase 2b chiusa)

- 0 mute invariants nel registry
- 0 open FIND in `docs/FUZZ-FINDINGS.md`
- 1 baseline attivo committato (`baseline-seed42-v2b3.json`)
- Reactions, reloadPage, profile, groups tutte coverate da ≥2 invariants e ≥1 postcondition
- Harness supporta 3 user `{userA, userB, userC}`
- CLAUDE.md ha sezione Phase 2b con quick reference (fuzz flags, baseline replay, action list)

## 12. Phase 3 skeleton (out-of-scope, annotato)

Phase 3 include:
- Chaos actions: `flakyRelay(user, pct)`, `connectivityLoss(user, durationMs)`, `clockSkew(user, ms)`
- Tor runtime backend mode (`--backend=tor`)
- `--pairs>1` parallel fuzz contexts con per-worker harness
- UI contract manifest (v1 ~25 entries)
- 4° user `userD` per group size > 3
- Cross-platform rendering checks (Firefox/WebKit via Playwright browsers)
- Profile extended: banner, lud16, zaps integration

Spec separato quando maintainer decide di aprire Phase 3.
