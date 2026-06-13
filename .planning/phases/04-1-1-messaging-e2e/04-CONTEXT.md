# Phase 4: 1:1 Messaging E2E - Context

**Gathered:** 2026-04-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Complete 1:1 conversation flow via Nostr relay pool: text and media messaging with NIP-17 gift-wrap privacy, delivery/read indicators, and conversation management. Two users can have a full private conversation where relay operators see neither content, nor sender/recipient metadata, nor message timing. Includes: text messaging, photo/video sending via Blossom, NIP-17 gift-wrap migration, 4-state delivery indicators, conversation lifecycle (history loading, message requests, deletion). Does NOT include: group messaging (Phase 5), broadcast channels (Phase 6), or voice/video calls (v2).

</domain>

<decisions>
## Implementation Decisions

### Media transfer strategy
- Photos and videos uploaded to Blossom-compatible servers (NIP-96 decentralized blob storage)
- Media encrypted client-side with AES-256-GCM before upload — Blossom servers see only opaque blobs
- Encryption key shared inside the NIP-17 gift-wrapped message (URL + key in rumor content)
- All uploads go through Tor (webtor-rs HTTP proxy) — IP hidden from Blossom servers
- 2-3 public Blossom servers hardcoded as defaults, user can configure custom servers
- Size limits: 10MB photos, 50MB videos

### Delivery indicators
- 4 states per message: invio (orologio) → inviato al relay (1 check) → ricevuto dal peer (2 check) → letto (2 check blu)
- Receipt events (ricezione + lettura) are NIP-17 gift-wrapped — relay cannot distinguish receipts from messages
- Read receipts disattivabili in Settings > Privacy: toggle "Conferme di lettura". Se disattivato, non invia check blu e non vede quelli degli altri (reciproco, come WhatsApp)
- Messaggi falliti: retry automatico con backoff esponenziale, molti tentativi. L'utente può eliminare il messaggio dal menu contestuale standard (selezione messaggio), nessun popup speciale

### Conversation lifecycle
- All'apertura app: richiedi ultimi 50 messaggi per ogni chat attiva dal relay pool. Scroll verso l'alto carica messaggi più vecchi (lazy load). Messaggi anche in cache IndexedDB locale
- Messaggi da npub sconosciuti: sezione "Richieste" separata (come Telegram/Instagram). L'utente può accettare (sposta in chat list) o rifiutare (blocca/ignora). Nessuna notifica push per richieste
- Chat list stile Telegram: avatar, nome/npub, anteprima ultimo messaggio troncata, timestamp, badge messaggi non letti. Display bridge già crea dialoghi sintetici — da estendere
- Eliminazione conversazione a 3 livelli:
  1. Locale: rimuovi da IndexedDB/cache
  2. Notifica al peer: evento gift-wrapped con riferimento agli ID dei messaggi eliminati → il client dell'altro utente li nasconde e li ignora se il relay li ritrasmette
  3. Richiesta al relay: NIP-09 deletion request (best-effort)

### NIP-17 gift-wrap
- Full NIP-17 da subito: kind 14 (rumor) → kind 13 (seal, NIP-44 encrypted) → kind 1059 (gift-wrap, NIP-44 encrypted con chiave effimera). Kind 4 rimosso completamente, nessuna backward compatibility
- Chiave effimera: nuova chiave random generata per ogni singolo gift-wrap (massima privacy, nessuna correlazione tra messaggi)
- Timestamp randomizzato: kind 1059 ha created_at randomizzato ±48 ore rispetto all'orario reale. Il timestamp reale è dentro il rumor cifrato
- Tutti gli eventi di controllo (receipt ricezione, receipt lettura, notifiche eliminazione) viaggiano come NIP-17 gift-wrap — il relay non può distinguerli dai messaggi normali

### Claude's Discretion
- Scelta dei 2-3 server Blossom di default (basarsi su uptime e compatibilità Nostr)
- Formato del payload media nel rumor (JSON con URL + chiave + metadata)
- Implementazione lazy loading dello scroll history (virtualizzazione, chunk size)
- Logica di backoff esponenziale per retry messaggi (intervalli, max tentativi)
- UI della sezione "Richieste" messaggi (posizione, badge, interazione)
- Come gestire il cambio dispositivo (sincronizzazione history da relay)
- Gestione conflitti timestamp tra messaggi locali e relay

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- **chat-api.ts** (`src/lib/nostra/chat-api.ts`): ChatAPI con send/receive per text/image/video/gif. Ha ChatMessage con status tracking (sending/sent/delivered/failed). Da migrare da kind 4 a NIP-17
- **nostr-crypto.ts** (`src/lib/nostra/nostr-crypto.ts`): NIP-44 encrypt/decrypt, createUnsignedRumor (kind 14), conversation key cache. Primitivi NIP-17 già presenti — mancano seal (kind 13) e gift-wrap (kind 1059)
- **nostra-display-bridge.ts**: Trasforma ChatMessage → synthetic tweb Message → history_append per bubble rendering. Già funzionante per messaggi base
- **nostra-send-bridge.ts**: Route outbound a ChatAPI per virtual peers. LRU cache per reverse lookup peerId → pubkey
- **offline-queue.ts**: IndexedDB queue per messaggi offline — riutilizzabile per retry con backoff
- **nostr-relay-pool.ts**: Multi-relay pool con dedup LRU, backfill, recovery. Sarà esteso in Phase 3
- **virtual-peers-db.ts**: IndexedDB pubkey ↔ peerId mapping, già funzionante con npub (Phase 2)

### Established Patterns
- **rootScope events**: State changes via rootScope.dispatchEvent() — delivery status, new messages, receipt events dovrebbero seguire lo stesso pattern
- **IndexedDB stores**: Pattern consolidato per Nostra.chat DBs — history cache e message request store seguiranno lo stesso schema
- **Display bridge → tweb rendering**: ChatMessage → synthetic Message → bubble. Questo pattern va esteso per media (foto/video inline), delivery indicators, e message requests
- **Send bridge routing**: isVirtualPeer() check → ChatAPI. Lo stesso pattern gestisce anche receipt events e delete notifications

### Integration Points
- **ChatAPI → NostrRelayPool**: ChatAPI deve migrare da kind 4 a NIP-17 gift-wrap (pool fornito da Phase 3)
- **Blossom upload**: Nuovo modulo — upload via webtor-rs HTTP proxy, download per rendering media inline
- **Chat bubbles**: Estendere per mostrare 4 stati delivery (icone check), media inline (foto/video), e stato retry
- **Chat list**: Display bridge deve popolare anteprima, timestamp, badge non letti nei dialoghi sintetici
- **Settings > Privacy**: Nuovo toggle "Conferme di lettura" — va accanto alle impostazioni privacy esistenti
- **Message requests**: Nuova sezione nella chat list o tab separato per messaggi da sconosciuti

</code_context>

<specifics>
## Specific Ideas

- Privacy totale: tutto gift-wrapped, tutto via Tor, media cifrati client-side. Il relay non sa nulla — né contenuto, né mittente, né destinatario, né timing
- Eliminazione messaggi deve propagarsi all'altro client in modo affidabile — l'evento di eliminazione permane per prevenire ritrasmissione dal relay
- UX familiare per Telegram refugees: 4 stati delivery come WhatsApp, chat list come Telegram, richieste messaggi come Instagram
- Read receipt reciproco: se disattivi, non invii e non ricevi (come WhatsApp)
- Retry aggressivo con backoff — l'utente non deve preoccuparsi di messaggi persi

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 04-1-1-messaging-e2e*
*Context gathered: 2026-04-01*
