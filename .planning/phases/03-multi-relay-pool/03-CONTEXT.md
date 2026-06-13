# Phase 3: Multi-Relay Pool - Context

**Gathered:** 2026-04-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Messaging is resilient — no single Nostr relay can silence the app. All message transport goes through the relay pool with Tor privacy. Includes: multi-relay pool with 4+ relays, relay failover, NIP-65 relay list publishing, Tor privacy via webtor-rs, progressive Tor bootstrap, and fallback to direct WebSocket with user consent. Does NOT include: actual 1:1 messaging UI (Phase 4), group messaging (Phase 5), or channel features (Phase 6).

</domain>

<decisions>
## Implementation Decisions

### Tor bootstrap UX
- Icona scudo nella topbar: grigia durante bootstrap, verde quando Tor attivo, arancione quando diretto
- Durante bootstrap: banner sotto la topbar "Avvio di Tor..." — scompare quando Tor è pronto
- Quando in fallback diretto: banner arancione persistente "Connessione diretta - IP visibile ai relay" con bottone "Riprova Tor" e dismiss (riappare ad ogni apertura app)
- Quando Tor torna disponibile dopo fallback: banner verde "Connesso via Tor" che scompare dopo 3 secondi
- Tap sull'icona scudo: popup dettagliato con stato Tor, relay connessi, latenza per relay

### Tor fallback behavior
- Se Tor fallisce completamente: popup di conferma "Tor non disponibile. Continuare con connessione diretta? Il tuo IP sarà visibile." con bottoni Riprova/Continua
- NON passare automaticamente a diretto — l'utente deve confermare esplicitamente
- Durante bootstrap Tor: i messaggi vengono accodati localmente in IndexedDB (no invio via WebSocket diretto temporaneo)
- Queue infrastructure (rootScope events) built in Phase 3; per-message clock/check icons deferred to Phase 4 (messaging UI)

### Relay defaults e gestione
- 4+ relay hardcoded di default + discovery di nuovi relay tramite NIP-65 dei contatti
- CRUD completo nella UI: aggiungere, rimuovere, abilitare/disabilitare read/write per ogni relay, toggle "usa solo i miei relay"
- Ogni relay nelle impostazioni mostra: pallino verde/rosso/giallo + latenza in ms + read/write toggle, aggiornamento in tempo reale
- NIP-65 (kind 10002): pubblica relay list all'inizializzazione identità + ogni volta che l'utente modifica la lista relay

### Integrazione Pool + Tor
- Singolo WebtorClient condiviso da tutti i relay nel pool — un solo bootstrap Tor
- Se Tor fallisce, tutto il pool passa a diretto (dopo conferma utente)
- Tentare WebSocket tunneling via Tor; se non supportato da webtor-rs, fallback a HTTP polling via Tor
- La coda messaggi durante bootstrap usa rootScope events; icona stato per-messaggio deferred a Phase 4

### Claude's Discretion
- Scelta dei 4+ relay di default (basarsi su uptime, geo-distribuzione, compatibilità NIP)
- Architettura WebSocket tunneling via Tor (valutare se webtor-rs lo supporta)
- Intervallo di polling HTTP come fallback se WebSocket via Tor non possibile
- Logica di discovery relay tramite NIP-65 dei contatti
- Formato e stile del popup dettagliato Tor (contenuto: stato, relay, latenza)
- Strategia di reconnection e circuit rotation Tor

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- **nostr-relay-pool.ts** (`src/lib/nostra/nostr-relay-pool.ts`): Multi-relay pool già funzionante con 3 default, dedup LRU (10k), backfill, add/remove relay, pool recovery ogni 60s. Manca: 4° relay, NIP-65, integrazione Tor
- **nostr-relay.ts** (`src/lib/nostra/nostr-relay.ts`): Single relay WebSocket con NIP-44 encryption, kind 4 events, reconnection con backoff (1s/2s/4s, max 3 tentativi)
- **privacy-transport.ts** (`src/lib/nostra/privacy-transport.ts`): Wrapper Tor con webtor-rs bootstrap + direct fallback. Attualmente wrappa singolo relay, non il pool
- **webtor-fallback.ts** (`src/lib/nostra/webtor-fallback.ts`): WebtorClient completo con Snowflake WebRTC bridge, circuit health polling, Nostr subscription polling, HTTP fetch via Tor
- **offline-queue.ts** (`src/lib/nostra/offline-queue.ts`): IndexedDB queue per messaggi offline — riutilizzabile per coda durante bootstrap Tor
- **Relay settings tab** (`src/components/sidebarLeft/tabs/nostraRelaySettings.ts`): UI impostazioni relay esistente — da estendere con CRUD completo e indicatori stato

### Established Patterns
- **rootScope events**: State changes via rootScope.dispatchEvent() — Tor/relay state events dovrebbero seguire lo stesso pattern
- **IndexedDB stores**: NostraPool DB già esiste per config relay — riutilizzare per relay config estesa
- **Logger**: logger('NostrRelayPool') pattern — mantenere per debug
- **Transport interface**: PeerTransport/PrivacyTransport condividono interfaccia — il pool Tor-wrapped deve esporre la stessa API

### Integration Points
- **PrivacyTransport → NostrRelayPool**: Attualmente PrivacyTransport wrappa singolo NostrRelay — deve wrappare il pool intero
- **Topbar**: Aggiungere icona scudo con stato Tor
- **Chat bubbles**: Aggiungere icona stato per messaggi in coda (orologio → check)
- **Identity init**: Trigger NIP-65 publish quando identità creata (collegamento con Phase 2 stores)

</code_context>

<specifics>
## Specific Ideas

- Il banner Tor deve essere nello stesso stile del banner "Connessione diretta" — coerente con il design Telegram-like
- L'utente vuole vedere latenza per-relay nelle impostazioni — importante per utenti tecnici che vogliono ottimizzare
- La conferma prima del fallback diretto è fondamentale — Nostra.chat è una app privacy-first, non deve mai esporre l'IP silenziosamente
- Il sistema di coda messaggi durante bootstrap Tor è lo stesso offline-queue già esistente — riutilizzare

</specifics>

<deferred>
## Deferred Ideas

- Per-message queue status icons (clock/check on chat bubbles) — deferred to Phase 4 (messaging UI). Phase 3 builds the event infrastructure (`nostra_message_queued`), Phase 4 renders it.

</deferred>

---

*Phase: 03-multi-relay-pool*
*Context gathered: 2026-04-01*
