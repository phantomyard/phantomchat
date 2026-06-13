# Phase 6: Broadcast Channels - Context

**Gathered:** 2026-04-03
**Status:** Ready for planning

<domain>
## Phase Boundary

One-to-many broadcast channels stile Telegram using NIP-28 (kind 40/41/42). Users can create channels, publish messages (owner + admin), subscribe via shared ID, and read channel messages. Channel metadata is updatable by owner. View count tracked via NIP-25 reactions.

Does NOT include: channel search/discovery (v2), private/invite-only channels (v2), comments/threads on channel posts (v2), voice/video channels (v2), NIP-29 relay-based groups (v2).

</domain>

<decisions>
## Implementation Decisions

### Channel data model
- **D-01:** Hybrid storage — IndexedDB locale per i channel sottoscritti + sync dal relay per nuovi messaggi. Pattern coerente con i gruppi (Phase 5 GroupStore). Offline reading dei messaggi gia scaricati.
- **D-02:** Metadata relay-authoritative — il kind 41 piu recente sul relay e la source of truth. L'owner edita -> pubblica kind 41 -> relay notifica subscriber -> UI aggiorna. Nessun optimistic local update. Semplifica il codice: un solo flusso relay -> local store -> UI.

### UX creazione e sottoscrizione
- **D-03:** Creazione via FAB > "New Channel" — stessa UX di Telegram. Il menu FAB ha gia l'opzione "New Channel" visibile, va solo collegata. Form: nome + descrizione + avatar opzionale -> pubblica kind 40 -> channel appare in chat list.
- **D-04:** Channel nella chat list mescolati con le chat — stile Telegram. Distinguibili dall'icona megafono. Nessuna sezione separata.
- **D-05:** Sottoscrizione via link/ID condivisibile (event ID del kind 40 o formato bech32). Campo "Join Channel" nell'app. Nessuna ricerca globale in v1 — discovery via link diretto.

### Permessi e moderazione
- **D-06:** Owner + delegati (admin) possono pubblicare. Lista admin come array di pubkey nel metadata kind 41. L'owner aggiorna il kind 41 per aggiungere/rimuovere admin. I subscriber verificano che il kind 42 sia firmato da una pubkey nella lista admin o dall'owner.
- **D-07:** Edit messaggi via kind 42 replacement — nuovo kind 42 con tag `e` che referenzia l'originale. I subscriber sostituiscono il messaggio in UI.
- **D-08:** Delete messaggi via NIP-09 (kind 5) con i 3 livelli di Phase 4: (1) locale: rimuovi da IndexedDB/cache, (2) pubblica kind 5 referenziando il kind 42 — i subscriber lo nascondono, (3) best-effort: relay onorano la deletion.

### Rendering messaggi
- **D-09:** Layout dedicato stile Telegram channel — messaggi full-width senza bolle, nome channel come header, media preview grandi. Layout distinto dalle chat 1:1 e gruppi. Richiede un nuovo renderer o variante del bubble renderer.
- **D-10:** View count via NIP-25 kind 7 reaction — i subscriber pubblicano automaticamente una reaction (kind 7) sul kind 42 del messaggio letto. Conteggio = numero di pubkey uniche che hanno reagito. Query relay standard: `REQ ["e", msg_id, "kind", 7]`. Non anonimo ma accettabile per channel pubblici.

### Claude's Discretion
- Schema IndexedDB per ChannelStore (struttura record, indici)
- Formato bech32 per channel ID sharing (nchannel1... o custom)
- Implementazione del renderer channel post (nuovo componente vs variante bubbles)
- Logica di sync relay per channel messages (intervallo polling, subscription filter)
- UX del "Join Channel" field (dove posizionarlo, validazione input)
- Icona megafono per distinguere channel nella chat list
- Gestione admin list UI nell'info sidebar del channel

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### NIP-28 Public Chat (core protocol)
- NIP-28 spec: kind 40 (create channel), kind 41 (set channel metadata), kind 42 (channel message). Public events, not encrypted.
- NIP-09 spec: kind 5 (event deletion). Used for channel message delete.
- NIP-25 spec: kind 7 (reaction). Used for view count tracking.

### Existing Nostra.chat code (reuse patterns)
- `src/lib/nostra/group-store.ts` — GroupStore pattern per IndexedDB. ChannelStore segue lo stesso pattern.
- `src/lib/nostra/group-api.ts` — GroupAPI pattern per CRUD. ChannelAPI segue lo stesso pattern (create, post, update metadata, delete).
- `src/lib/nostra/nostra-display-bridge.ts` — `injectGroupChat()` pattern. Estendere con `injectChannel()` per i channel dialog.
- `src/lib/nostra/nostra-send-bridge.ts` — `isGroupPeer()` pattern. Estendere con `isChannelPeer()`.
- `src/lib/nostra/nostr-relay-pool.ts` — Relay pool per publish/subscribe. Usare per kind 40/41/42 events.
- `src/components/sidebarLeft/tabs/nostraNewGroup.ts` — AppNostraNewGroupTab pattern. Creare AppNostraNewChannelTab analogo.
- `src/components/sidebarRight/tabs/nostraGroupInfo.ts` — AppNostraGroupInfoTab pattern. Creare AppNostraChannelInfoTab analogo.
- `src/components/sidebarLeft/index.ts` — FAB menu wiring (onNewGroupClick pattern). Estendere onNewChannelClick.
- `src/components/chat/topbar.ts` — Topbar click intercept per group peers. Estendere per channel peers.

### Phase 4 decisions (delete pattern)
- `.planning/phases/04-1-1-messaging-e2e/04-CONTEXT.md` — Delete a 3 livelli (locale, notifica peer, NIP-09 relay). Stesso pattern per channel message delete.

### Phase 5 decisions (group patterns)
- `.planning/phases/05-group-messaging/05-CONTEXT.md` — Group data model, display bridge injection, dialog management. Channel segue gli stessi pattern adattati per NIP-28.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **GroupStore** (`group-store.ts`): IndexedDB store pattern. ChannelStore puo replicare la struttura (save, get, getByPeerId, getAll, delete).
- **GroupAPI** (`group-api.ts`): CRUD pattern con publishFn. ChannelAPI replica per kind 40/41/42.
- **NostraDisplayBridge** (`nostra-display-bridge.ts`): `injectGroupChat()` + `removeGroupDialog()` — estendere per `injectChannel()` + `removeChannelDialog()`.
- **AppNostraNewGroupTab** (`nostraNewGroup.ts`): SliderSuperTab per creazione gruppo. AppNostraNewChannelTab replica per channel.
- **AppNostraGroupInfoTab** (`nostraGroupInfo.ts`): SliderSuperTab per info gruppo. AppNostraChannelInfoTab replica con admin list + subscriber count.
- **FAB wiring** (`sidebarLeft/index.ts`): `onNewGroupClick` pattern. Aggiungere `onNewChannelClick`.
- **Topbar intercept** (`topbar.ts`): `isGroupPeer()` check. Aggiungere `isChannelPeer()`.
- **dropP2PDialog** (`dialogs.ts`): Force-drop per virtual peer dialogs. Riusabile per channel unsubscribe.

### Established Patterns
- Virtual peer IDs: gruppi usano negative IDs >= GROUP_PEER_BASE. Channel useranno un CHANNEL_PEER_BASE separato.
- Dialog injection: `registerP2PDialog()` + `dialogs_multiupdate` event per aggiungere alla chat list.
- Contact indexing: `pushContact()` in `injectP2PUser()` per rendere i peer trovabili nel search.

### Integration Points
- `sidebarLeft/index.ts`: FAB menu — aggiungere handler "New Channel"
- `topbar.ts`: Click handler — aggiungere branch per channel peers
- `nostra-display-bridge.ts`: Aggiungere `injectChannel()` e channel message display
- `nostra-send-bridge.ts`: Aggiungere `isChannelPeer()` e routing per channel posts
- `nostr-relay-pool.ts`: Subscription filter per kind 40/41/42 events

</code_context>

<specifics>
## Specific Ideas

- View count stile Telegram sotto ogni messaggio channel, implementato via NIP-25 kind 7 reactions
- Admin delegation tramite lista pubkey nel kind 41 metadata (non NIP-26)
- Channel message edit via kind 42 replacement con tag `e` (non un NIP separato)
- Delete a 3 livelli coerente con Phase 4 (locale, kind 5, relay best-effort)
- Layout channel post distinto dalle chat bubbles — full-width, header channel, media preview grandi

</specifics>

<deferred>
## Deferred Ideas

- **Channel discovery/search** — Ricerca globale di channel per nome sui relay. Richiede supporto relay per full-text search su kind 40. Future phase.
- **Private channels** — Channel con accesso limitato via invito. Richiederebbe encryption (kind 40 + NIP-17 wrapping?). Future phase.
- **Comments/threads** — Risposte ai post channel in thread separati. Nuovo tipo di interazione. Future phase.
- **Anonymous view count (HKDF pseudonym)** — View count con privacy dei lettori tramite pseudonimi deterministici HKDF. Valutato e rimandato per complessita. V2 se richiesto.
- **Opt-out view tracking** — Setting per subscriber che non vogliono inviare reaction di lettura. V2.

</deferred>

---

*Phase: 06-broadcast-channels*
*Context gathered: 2026-04-03*
