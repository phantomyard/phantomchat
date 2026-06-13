# Phase 7: Disable Telegram MTProto & Remove Server Dependency - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-02
**Phase:** 07-disable-telegram-mtproto-remove-server-dependency
**Areas discussed:** Strategia di rimozione MTProto, Connection status & UX di avvio, apiManagerProxy e state management, Scope e confini della fase

---

## Strategia di rimozione MTProto

### Come gestire il codice MTProto

| Option | Description | Selected |
|--------|-------------|----------|
| Stub minimale | Rimpiazza networker/authorizer/transports con stub no-op. Mantiene interfacce per i 55+ manager. | ✓ |
| Rimozione completa | Elimina src/lib/mtproto/ e riscrive tutti i punti di dipendenza. Più pulito ma molto rischioso. | |
| Kill switch all'avvio | Lascia MTProto intatto ma impedisci connessioni a livello di NetworkerFactory.reconnect(). | |

**User's choice:** Stub minimale
**Notes:** Approccio conservativo — mantiene la compatibilità con l'architettura manager esistente.

### Come gestire invokeApi() per i manager

| Option | Description | Selected |
|--------|-------------|----------|
| Ritorna errore | Lo stub invokeApi() rejecta con 'MTProto disabled'. Manager già intercettati da api-manager-stub continuano a funzionare. | ✓ |
| Ritorna dati vuoti | Lo stub ritorna risposte vuote/default per ogni metodo. | |
| Tu decidi | Lascia a Claude la scelta tecnica. | |

**User's choice:** invokeApi() ritorna errore
**Notes:** Errori espliciti per chiamate non intercettate — fail fast piuttosto che nascondere problemi.

---

## Connection Status & UX di Avvio

### Cosa mostrare all'avvio

| Option | Description | Selected |
|--------|-------------|----------|
| Stato relay Nostr | ConnectionStatusComponent mostra stato connessione ai relay Nostr. Riusa componente esistente. | ✓ |
| Nessuno status bar | Rimuovi completamente ConnectionStatusComponent. Stato relay già visibile nello shield icon Tor. | |
| Splash screen Nostra.chat | Branding screen durante bootstrap relay, poi transizione alla UI. | |

**User's choice:** Stato relay Nostr
**Notes:** Riuso del componente esistente con dati diversi.

### Comportamento riconnessione

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-reconnect silenzioso | Pool relay si riconnette in background. Status bar solo se tutti i relay down. | ✓ |
| Notifica esplicita | Mostra sempre notifica per ogni relay disconnect/reconnect. | |
| Tu decidi | Basato sui pattern Phase 3. | |

**User's choice:** Auto-reconnect silenzioso
**Notes:** Coerente col comportamento Phase 3.

---

## apiManagerProxy e State Management

### Come migrare apiManagerProxy

| Option | Description | Selected |
|--------|-------------|----------|
| Stub apiManagerProxy | Mantiene interfaccia, loadAllStates/sendAllStates lavorano con IndexedDB locale. SharedWorker continua per UI. | ✓ |
| Bypassa apiManagerProxy | Riscrivi index.ts per caricare state direttamente da IndexedDB. | |
| Tu decidi | Lascia a Claude la scelta tecnica. | |

**User's choice:** Stub apiManagerProxy
**Notes:** Boot path strutturalmente invariato — meno rischio di rompere il flusso di avvio.

---

## Scope e Confini della Fase

### Profondità della pulizia

| Option | Description | Selected |
|--------|-------------|----------|
| Disabilita + stub | Zero connessioni Telegram. Stub MTProto/networker/apiManager. Rimappa ConnectionStatus. NO rimozione codice morto. | ✓ |
| Disabilita + pulizia parziale | Stessa cosa + rimuovi file MTProto più grandi per ridurre bundle. | |
| Pulizia completa | Rimuovi tutto il codice Telegram non usato. Alto rischio. | |

**User's choice:** Disabilita + stub
**Notes:** Scope conservativo — obiettivo unico è eliminare connessioni Telegram.

### layer.d.ts (664KB tipi MTProto)

| Option | Description | Selected |
|--------|-------------|----------|
| Mantieni per ora | Centinaia di componenti importano tipi da @layer. Pulizia futura. | ✓ |
| Rimuovi e sostituisci | Crea tipi Nostra.chat nativi e migra tutti gli import. | |
| Tu decidi | Basato sull'analisi dipendenze. | |

**User's choice:** Mantieni per ora
**Notes:** Troppi import da @layer — migrazione tipi è un progetto a sé.

---

## Claude's Discretion

- Dettagli implementativi degli stub per networkerFactory, apiManager, transport layer
- Come wiring relay pool status events in ConnectionStatusComponent
- Livello di stubbing (NetworkerFactory vs networker/transport individuali)

## Deferred Ideas

- Full MTProto code removal (future cleanup phase)
- Native Nostra.chat types to replace @layer imports
- SharedWorker simplification
- Bundle size optimization (schema.ts 505KB, layer.d.ts 664KB)
