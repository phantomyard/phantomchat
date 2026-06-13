# Phase 6: Broadcast Channels - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-03
**Phase:** 06-broadcast-channels
**Areas discussed:** Channel data model, UX creazione/sottoscrizione, Permessi/moderazione, Rendering messaggi

---

## Channel Data Model

### Storage strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Relay-first | No IndexedDB, cache temporanea, vuoto finche relay risponde | |
| Hybrid | IndexedDB locale per channel sottoscritti + sync relay | X |
| Relay-only | Nessuna persistenza, query relay ogni volta | |

**User's choice:** Hybrid (coerente con pattern gruppi Phase 5)

### Metadata source of truth

| Option | Description | Selected |
|--------|-------------|----------|
| Relay-authoritative | Kind 41 dal relay e la source of truth, UI aggiorna dopo relay | X |
| Optimistic local | UI aggiorna subito, pubblica kind 41 in background | |

**User's choice:** Relay-authoritative
**Notes:** Channel sono pubblici, relay e la source of truth naturale. Latenza update metadata irrilevante.

---

## UX Creazione e Sottoscrizione

### Creazione channel

| Option | Description | Selected |
|--------|-------------|----------|
| Stesso FAB | FAB > "New Channel" (gia nel menu, da collegare) | X |
| Sezione dedicata | Tab separato per i channel | |

**User's choice:** Stesso FAB (stile Telegram)

### Sottoscrizione

| Option | Description | Selected |
|--------|-------------|----------|
| Link/ID condivisibile | Incolla ID/link nel campo "Join Channel" | X |
| Link + ricerca relay | Come sopra + ricerca globale per nome | |
| Solo link | Solo link diretto, nessun campo join | |

**User's choice:** Link/ID condivisibile, no ricerca in v1

---

## Permessi e Moderazione

### Chi pubblica

| Option | Description | Selected |
|--------|-------------|----------|
| Solo owner | Solo il creatore del channel | |
| Owner + delegati | Owner designa admin che pubblicano | X |

**User's choice:** Owner + delegati

### Meccanismo delega

| Option | Description | Selected |
|--------|-------------|----------|
| Lista admin in metadata | Array pubkey admin nel kind 41 | X |
| NIP-26 delegation | Delegation token per ogni admin | |

**User's choice:** Lista admin nel kind 41
**Notes:** Semplice, verificabile, nessuna dipendenza da NIP non consolidati.

### Edit/Delete messaggi

| Option | Description | Selected |
|--------|-------------|----------|
| No edit/delete | Immutabile | |
| Delete only | NIP-09 kind 5 best-effort | |
| Edit + delete | Kind 42 replacement + NIP-09 | X |

**User's choice:** Edit + delete, coerente con decisioni Phase 4 per i messaggi cancellati
**Notes:** Edit via kind 42 con tag `e` referenzia originale. Delete a 3 livelli (locale, kind 5, relay).

---

## Rendering Messaggi

### Layout

| Option | Description | Selected |
|--------|-------------|----------|
| Bolle chat | Stesse bolle 1:1 e gruppi | |
| Stile Telegram channel | Full-width senza bolle, header channel, media preview grandi | X |
| Ibrido | Bolle con indicatore "channel post" | |

**User's choice:** Stile Telegram channel — layout dedicato

### View count

| Option | Description | Selected |
|--------|-------------|----------|
| Nessun view count | Ometti del tutto | |
| Subscriber count statico | Mostra numero subscriber noti | |
| Kind 7 reaction (NIP-25) | Subscriber pubblicano reaction, conteggio pubkey uniche | X |
| Pseudonimo HKDF | Receipt anonimo con chiave derivata per channel | |

**User's choice:** Kind 7 reaction (NIP-25)
**Notes:** Valutata alternativa HKDF per privacy anonima. Comparazione dettagliata presentata. Utente ha scelto NIP-25 per semplicita, compatibilita relay nativa, e interoperabilita con altri client Nostr. Privacy accettabile per channel pubblici. HKDF pseudonym notato come idea differita per v2.

---

## Claude's Discretion

- Schema IndexedDB ChannelStore
- Formato bech32 per channel ID sharing
- Implementazione renderer channel post
- Logica sync relay per channel messages
- UX del "Join Channel" field
- Icona megafono per chat list
- UI admin list nell'info sidebar

## Deferred Ideas

- Channel discovery/search (richiede supporto relay full-text)
- Private/invite-only channels (encryption layer)
- Comments/threads su channel posts
- Anonymous view count via HKDF pseudonyms (valutato, rimandato per complessita)
- Opt-out view tracking per subscriber
