# Future Context Menu Features

Funzionalita da implementare per il context menu delle chat Nostra. Ogni item e un progetto separato che richiede il proprio ciclo spec/plan/implementation.

## 1. Scheduled Messages

Permettere all'utente di programmare l'invio di un messaggio a un orario futuro.

**Requisiti:**
- UI: opzione "Schedule" nel menu di invio (long-press sul bottone send)
- Date/time picker nativo
- Messaggi schedulati visibili in una sezione dedicata (come tweb vanilla `ChatType.Scheduled`)
- Storage locale: IndexedDB con timer. Al momento dell'invio, `chatAPI.sendText()` normale
- Gestione offline: se il device e offline all'orario programmato, inviare al prossimo avvio
- Cancellazione/modifica prima dell'invio

**Complessita:** Media — tweb ha gia l'infrastruttura `ChatType.Scheduled`, va solo collegata al send P2P.

## 2. Forward (copy-paste semantico)

Permettere di inoltrare un messaggio a un altro contatto. In Nostra non c'e server relay per forward nativo — il forward e una copia del contenuto con attribuzione.

**Requisiti:**
- UI: opzione "Forward" nel context menu del bubble
- Peer picker: dialog per scegliere il destinatario tra i contatti
- Il messaggio inoltrato deve mostrare "Forwarded from [nome]" come header
- Contenuto: testo copiato integralmente. Per media (futuro): re-upload necessario
- Nessun link al messaggio originale (non esiste un message ID globale in Nostra)

**Complessita:** Bassa — e essenzialmente un send con prefisso/metadata extra.

## 3. View Reactions

Mostrare chi ha reagito a un messaggio con quale emoji.

**Requisiti:**
- Protocollo: definire un formato NIP-17 per le reazioni (kind 7 wrappato in gift-wrap?)
- Invio: long-press su bubble → emoji picker → pubblica reazione via relay
- Ricezione: subscription alle reazioni per i messaggi nella chat corrente
- UI: badge emoji sotto il bubble (come Telegram), click per vedere chi ha reagito
- Aggregazione: conteggio per emoji, lista utenti per emoji
- Storage: persiste in message-store come metadata del messaggio

**Complessita:** Alta — richiede nuovo tipo di evento Nostr, subscription dedicata, UI componente nuovo.

## Priorita suggerita

1. Forward (bassa complessita, alta utilita)
2. Scheduled Messages (media complessita, infrastruttura tweb riutilizzabile)
3. View Reactions (alta complessita, richiede design protocollo)
