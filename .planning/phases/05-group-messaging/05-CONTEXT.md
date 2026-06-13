# Phase 5: Group Messaging - Context

**Gathered:** 2026-04-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Private group messaging for up to 12 members using NIP-17 multi-recipient gift-wrap. Users can create groups, exchange text and media messages with the same privacy guarantees as 1:1 DMs (relay operators cannot determine group membership), manage members (add/remove), and leave groups. Replicates Telegram group UX using the existing tweb UI components.

Does NOT include: broadcast channels (Phase 6), groups >12 members / NIP-29 relay groups (v2), voice/video in groups (v2), shared secret encryption for large groups (v2).

</domain>

<decisions>
## Implementation Decisions

### Group identity & metadata
- **D-01:** Groups use a shared random hex ID (not a dedicated keypair). The group ID is generated at creation time and shared with members via NIP-17 control messages signed by the creator.
- **D-02:** Group metadata (name, avatar, member list) stored in IndexedDB locally. Claude's Discretion on whether to also persist a NIP-17 'group_info' event on relay for multi-device recovery.
- **D-03:** Only admin/creator can change group name and avatar. Transfer of admin role done via NIP-17 control message.

### Message wrapping strategy
- **D-04:** 1 gift-wrap per member (NIP-17 puro). For a group of N members, each message generates N+1 gift-wrap events (one per member + self-send for multi-device). Max 13 events per message. Conforme a GRP-02.
- **D-05:** Delivery indicators stile WhatsApp gruppi: doppio check = consegnato a tutti i membri, check blu = letto da tutti. Tap sul messaggio mostra dettaglio per membro (chi ha ricevuto/letto). Read receipt privacy setting from Phase 4 applies.

### Group management UX
- **D-06:** Creazione gruppo stile Telegram: bottone 'Nuovo gruppo' nella chat list → seleziona contatti dalla rubrica → nome gruppo + avatar opzionale → crea. Riutilizza componenti tweb esistenti per selezione contatti.
- **D-07:** Inviti: default auto-join con notifica (messaggio di servizio "Sei stato aggiunto al gruppo X da Y"). Setting Privacy > Gruppi con toggle "Chi può aggiungermi ai gruppi" (Tutti / Solo contatti / Nessuno → invito nella sezione Richieste).
- **D-08:** Rimozione stile Telegram: admin apre info gruppo → lista membri → tap → 'Rimuovi'. Il membro rimosso vede messaggio di servizio e non riceve più messaggi.
- **D-09:** Leave: quando un membro lascia il gruppo, la chat viene rimossa automaticamente dalla sua lista. Per rientrare serve un nuovo invito.

### Group chat list display
- **D-10:** Chat list stile Telegram: avatar del gruppo (se impostato, altrimenti iniziali generate), nome in grassetto, anteprima "NomeMembro: testo messaggio", badge non letti come 1:1.
- **D-11:** Info gruppo: sidebar Telegram completa — avatar, nome, descrizione, lista membri con ruolo (admin/membro), media condivisi, notifiche mute, lascia gruppo. Riutilizza componenti sidebar tweb.
- **D-12:** Messaggi di servizio stile Telegram: bolle centrali grigie con testo ("X ha aggiunto Y", "X ha lasciato il gruppo"). Riutilizza il rendering service message esistente in tweb.

### Claude's Discretion
- Recovery multi-dispositivo dei metadata gruppo (locale only vs relay hint)
- Formato del payload nei messaggi NIP-17 di controllo (group_create, group_add_member, group_remove_member, group_leave, group_info_update)
- Implementazione del setting privacy "Chi può aggiungermi ai gruppi" (UI e storage)
- Generazione avatar con iniziali per gruppi senza avatar
- Logica di aggregazione delivery status per visualizzazione "consegnato/letto da tutti"
- Limite membri (12) enforcement UX e messaging

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### NIP-17 Gift-Wrap (core protocol)
- `src/lib/nostra/nostr-crypto.ts` — Current NIP-17 wrapping implementation (wrapNip17Message, unwrapNip17Message). Must extend for multi-recipient
- `src/lib/nostra/chat-api.ts` — ChatAPI with send/receive, ChatMessage type, status tracking. Must extend for group message routing
- `src/lib/nostra/delivery-tracker.ts` — Delivery status state machine (4 states). Must extend for per-member tracking in groups

### Display Bridge (UI integration)
- `src/lib/nostra/nostra-display-bridge.ts` — Synthetic dialog/message injection into tweb. Must extend for group dialogs and service messages
- `src/lib/nostra/nostra-send-bridge.ts` — Outbound routing for virtual peers. Must extend for group message fan-out

### Existing Patterns
- `src/lib/nostra/nostr-relay-pool.ts` — Multi-relay pool with dedup. Group events published via same pool
- `src/lib/nostra/virtual-peers-db.ts` — IndexedDB pubkey ↔ peerId mapping. Groups need a parallel group ID ↔ peerId mapping

### Phase 4 Context (prior decisions)
- `.planning/phases/04-1-1-messaging-e2e/04-CONTEXT.md` — 1:1 messaging decisions that Phase 5 extends (delivery indicators, message requests, NIP-17 approach)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **wrapNip17Message** (`nostr-crypto.ts`): Creates gift-wrap for 1 recipient + self-send. Can be called N times in a loop for group members
- **ChatAPI** (`chat-api.ts`): Full message lifecycle (send/receive/status). Needs group-aware routing but core primitives reusable
- **Display bridge** (`nostra-display-bridge.ts`): Synthetic dialog creation, message rendering via history_append. Extend for group dialogs
- **Send bridge** (`nostra-send-bridge.ts`): Outbound routing with LRU cache. Extend for group peer resolution
- **Delivery tracker** (`delivery-tracker.ts`): 4-state delivery machine. Extend for per-member aggregate status
- **Virtual peers DB** (`virtual-peers-db.ts`): IndexedDB peer mapping. Group needs similar store for group metadata

### Established Patterns
- **rootScope events**: All state changes via rootScope.dispatchEvent() — group events (member add/remove, service messages) follow same pattern
- **IndexedDB stores**: Consistent pattern for Nostra.chat databases — group metadata store follows same schema approach
- **Service messages in tweb**: tweb has built-in service message rendering (centered gray bubbles) — reuse for group events

### Integration Points
- **Chat list**: Display bridge populates synthetic dialogs → extend for group entries
- **Chat topbar**: Shows peer name/avatar → extend to show group name/avatar with tap → sidebar info
- **Message bubbles**: 1:1 bubbles show sender implicitly → group bubbles need explicit sender name/color
- **Settings > Privacy**: Existing privacy toggles → add "Chi può aggiungermi ai gruppi" toggle
- **Contact selector**: tweb has contact picker components → reuse for group member selection

</code_context>

<specifics>
## Specific Ideas

- Replicare esattamente la UX Telegram per gruppi: creazione, lista chat, info sidebar, messaggi di servizio
- WhatsApp-style delivery indicators nei gruppi con dettaglio per membro
- Shared secret per gruppi grandi notato per v2 (non in Phase 5)
- Privacy setting per inviti gruppi simile a Telegram ("Chi può aggiungermi")

</specifics>

<deferred>
## Deferred Ideas

- **Shared secret encryption per gruppi grandi** — Alternativa al fan-out gift-wrap per gruppi >12 membri. Più efficiente (1 evento per messaggio) ma meno privacy. Da valutare per v2/NIP-29
- **Avatar collage** — Avatar composto dai primi 4 avatar dei membri (griglia 2x2). Alternativa all'avatar gruppo con iniziali. Potrebbe essere aggiunto come enhancement futuro

</deferred>

---

*Phase: 05-group-messaging*
*Context gathered: 2026-04-03*
