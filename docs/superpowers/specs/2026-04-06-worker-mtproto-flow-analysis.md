# Analisi Comparativa: Worker↔Main Thread — tweb vanilla vs nostra.chat

**Data:** 2026-04-06
**Obiettivo:** Capire perché il Virtual MTProto rompe context menu bolle, search, getHistory, deleteMessages

---

## 1. Architettura Vanilla tweb: Il Flusso Corretto

### Il contratto fondamentale

In vanilla tweb, **il Worker è la source of truth**. Tutto il data flow segue questo pattern:

```
UI (main) ──invoke──→ apiManagerProxy ──MessagePort──→ Worker (appMessagesManager)
                                                            │
                                                     MTProto networker
                                                            │
                                                     Telegram servers
                                                            │
                                                     ← response ←
                                                            │
                                                    saveMessages()
                                                            │
                                                  setMessageToStorage()
                                                            │
                                              MTProtoMessagePort.invokeVoid('mirror', ...)
                                                            │
                                                    ← fire-and-forget ←
                                                            │
                                              apiManagerProxy.mirrors.messages[key]
                                                            │
                                                        UI reads
```

**Punti chiave:**
1. Il Worker chiama `saveMessages()` che popola `messagesStorageByPeerId[peerId]`
2. `saveMessages()` chiama `setMessageToStorage()` che fa `invokeVoid('mirror', ...)` verso il main thread
3. Il main thread aggiorna `apiManagerProxy.mirrors.messages[storageKey][mid]`
4. La UI (context menu, bubbles, search) legge **sincronamente** dai mirrors

### messages.getHistory (vanilla)

```
bubbles.ts → managers.appMessagesManager.getHistory()
           → fillHistoryStorage() → requestHistory()
           → apiManager.invokeApiSingle('messages.getHistory', params)
           → MTProto networker → Telegram server
           ← MessagesMessages {messages[], users[], chats[], count}
           → saveApiResult() → saveMessages() per ogni messaggio
           → setMessageToStorage() → mirror verso main thread
           → historyStorage aggiornato con SlicedArray
           ← UI re-render con dati dai mirrors
```

**Il Worker ha i messaggi nella sua storage. Il main thread ha copie nei mirrors.**

### messages.deleteMessages (vanilla)

```
contextMenu.ts → canDeleteMessage(message)  // verifica locale sui mirrors
              → PopupDeleteMessages
              → managers.appMessagesManager.deleteMessages(peerId, mids)
              → apiManager.invokeApi('messages.deleteMessages', {id, revoke})
              ← AffectedMessages {pts, pts_count}
              → processLocalUpdate({_: 'updateDeleteMessages', messages, pts})
              → deleteMessageFromStorage() → invokeVoid('mirror', {value: undefined})
              → main thread rimuove da mirrors
              → UI dispatch 'history_delete' → rimuove bubble dal DOM
```

**Il Worker processa la risposta, cancella dalla propria storage, notifica il main thread.**

### messages.search (vanilla)

```
appSearch.ts → managers.appMessagesManager.getHistory({query, inputFilter})
            → requestHistory() → 'messages.search' method
            → Worker MTProto call → risultati
            → saveMessages() per ogni risultato
            → mirror verso main thread
            → UI renderizza da mirrors
```

### Context Menu (vanilla)

```
right-click → contextMenu.ts
           → chat.getMessageByPeer(peerId, mid)
           → mirrors.messages[storageKey][mid]  // lookup SINCRONO
           → canDeleteMessage(message)  // controlla message.pFlags
           → canEditMessage(message)
           → canForwardMessage(message)
           → mostra opzioni abilitate
```

**Tutto sincrono, tutto dai mirrors, che sono stati popolati dal Worker via saveMessages()→mirror.**

---

## 2. Architettura nostra.chat: Dove Si Rompe

### Il problema fondamentale

nostra.chat ha **invertito la direzione del data flow** senza completare il ciclo:

```
                              Main thread
                                  │
                        NostraMTProtoServer ←── message-store.ts (IndexedDB)
                                  │
                         risposta sintetica
                                  │
                                  ↓
                        ❌ MAI chiamato saveMessages()
                        ❌ MAI popolato Worker storage
                        ❌ MAI eseguito mirror pipeline
                                  │
                     Worker ha storage VUOTA
                     mirrors.messages = {}  (eccetto inject manuali)
```

### Il doppio binario

Il codice ha **due percorsi paralleli** che non si parlano:

| Contesto | Chi risponde | Storage | Mirror |
|----------|-------------|---------|--------|
| **Worker** | `NOSTRA_STATIC` → `{messages: [], count: 0}` | Sempre vuota | Niente da mirrorare |
| **Main thread** | `NostraMTProtoServer.getHistory()` → messaggi reali da IndexedDB | Solo IndexedDB | Inject manuale solo per incoming |

Il Worker è cieco. Quando `appMessagesManager` nel Worker chiama `getHistory`, riceve sempre `{messages: []}` da `NOSTRA_STATIC`. Non salva nulla, non mirrora nulla.

### Dettaglio per feature rotta

#### 2.1 messages.getHistory — Worker cieco

**Worker context** (`apiManager.ts:610`):
```typescript
'messages.getHistory': {_: 'messages.messages', messages: [], users: [], chats: [], count: 0}
```

**Main thread** (`virtual-mtproto-server.ts:395`):
```typescript
private async getHistory(params): Promise<any> {
  // Legge da message-store.ts (IndexedDB)
  // Costruisce oggetti Message sintetici via NostraPeerMapper.createTwebMessage()
  // Ritorna {_: 'messages.messages', messages: [...], users: [...], count: N}
}
```

**Gap:** La main thread ha i dati ma non li passa mai al Worker. Il Worker non esegue mai `saveMessages()` perché riceve array vuoto. I mirrors restano vuoti.

**Workaround attuale:** `nostra-onboarding-integration.ts:170-174` inietta manualmente nel mirror PER I SOLI MESSAGGI INCOMING in real-time:
```typescript
proxy.mirrors.messages[storageKey][msg.id] = msg;
```

Ma questa injection:
- Non avviene per messaggi storici (scroll up, reload)
- Non popola `historyStorage` (SlicedArray) del Worker
- Non chiama `saveMessages()` → il Worker non sa che il messaggio esiste

#### 2.2 messages.deleteMessages — Cancellazione monca

**Worker** (`NOSTRA_STATIC:619`): ritorna `{pts: 1, pts_count: 0}` → il Worker processa `updateDeleteMessages` ma non ha il messaggio in storage → no-op.

**Main thread** (`virtual-mtproto-server.ts:657`): cancella da IndexedDB → OK per persistenza Nostra.

**Gap:**
1. Il Worker non ha mai avuto il messaggio in `messagesStorageByPeerId` → `deleteMessageFromStorage()` è un no-op
2. Non viene fatto `invokeVoid('mirror', {value: undefined})` → il mirror mantiene il messaggio (se era stato iniettato manualmente)
3. La UI non riceve `history_delete` → il bubble resta visibile

#### 2.3 messages.search — Risultati fantasma

**Worker** (`NOSTRA_STATIC:611`): ritorna `{messages: [], count: 0}` → search results sempre vuoti.

**Main thread** (`virtual-mtproto-server.ts:454`): cerca in IndexedDB, trova risultati, ma:
- `appMessagesManager` nel Worker non vede mai questi risultati
- `saveMessages()` mai chiamato
- I risultati non entrano nei mirrors

**Risultato:** Search non funziona per chat P2P.

#### 2.4 Context Menu — Dati mancanti

Il context menu fa lookup sincrono in `mirrors.messages[storageKey][mid]`:

```typescript
this.message = this.chat.getMessageByPeer(this.messagePeerId, mid);
```

**Scenario 1 — Messaggio incoming (real-time):** Il mirror è stato iniettato manualmente da `nostra-onboarding-integration.ts`. Il context menu trova il messaggio. **Funziona parzialmente** — ma l'oggetto sintetico potrebbe mancare di campi che vanilla tweb popola in `saveMessages()`.

**Scenario 2 — Messaggio storico (reload, scroll):** Il mirror NON è stato iniettato. Il context menu non trova il messaggio. **Non funziona.**

**Scenario 3 — Messaggio eliminato:** Il mirror ha ancora il messaggio (nessuno lo ha rimosso). Il context menu mostra opzioni per un messaggio cancellato. **Comportamento errato.**

---

## 3. Diagramma delle Discrepanze

```
                    VANILLA TWEB                          NOSTRA.CHAT
                    ──────────                          ─────────────

  UI (main)         reads mirrors ✓                   reads mirrors ✓
       │                                                     │
  mirrors           populated by Worker ✓             populated SOLO per
       │            via saveMessages()→mirror          incoming real-time ✗
       │                                              (inject manuale)
  Worker            has messages in storage ✓          storage VUOTA ✗
       │            saveMessages() called ✓            saveMessages() MAI ✗
       │                                              (NOSTRA_STATIC → [])
  MTProto/API       real Telegram server ✓            NOSTRA_STATIC (Worker)
                                                      NostraMTProtoServer (main)
                                                      ← DISCONNESSI →
```

---

## 4. Root Cause Analysis

### Causa radice unica

**Il Worker non riceve mai le risposte reali del Virtual MTProto Server.** Il server vive sul main thread (`this.nostraMTProtoServer` è null nel Worker). Il Worker usa solo `NOSTRA_STATIC` che ritorna array vuoti.

### Perché questo è un problema architetturale

In vanilla tweb, il flusso è:
```
Worker → invokeApi() → rete → risposta → saveMessages() → mirror
```

In nostra.chat, il flusso è interrotto:
```
Worker → invokeApi() → NOSTRA_STATIC → {messages: []} → saveMessages() su array vuoto → niente mirror

Main thread ha i dati reali in NostraMTProtoServer ma NON li passa al Worker
```

Il workaround attuale in `nostra-onboarding-integration.ts` copre solo il caso incoming real-time, non:
- History scroll (messaggi storici)
- Reload della pagina (tutti i messaggi)
- Search
- Delete (cascading al mirror)

---

## 5. Approccio Risolutivo Raccomandato

### Principio: Il Worker deve ricevere risposte MTProto corrette

Il fix deve fare in modo che quando il Worker chiama `invokeApi('messages.getHistory', ...)`, riceva la stessa risposta che il `NostraMTProtoServer` genererebbe sul main thread. Così il flusso normale di tweb si attiva:

```
Worker → invokeApi() → ??? → risposta REALE → saveMessages() → mirror → UI
```

### Opzione A: MessagePort bridge (Worker ↔ Main MTProto Server)

```
Worker                              Main Thread
  │                                      │
  invokeApi('messages.getHistory')       │
  │                                      │
  ─── postMessage({method, params}) ──→  │
  │                                NostraMTProtoServer.handleMethod()
  │                                      │
  ←── postMessage({result}) ───────────  │
  │                                      │
  saveMessages(result.messages)          │
  setMessageToStorage() → mirror ──────→ mirrors.messages[]
```

**Pro:** Segue il contratto vanilla. Il Worker processa le risposte normalmente.
**Contro:** Ogni call attraversa il Worker↔main boundary due volte (andata e ritorno).

### Opzione B: Worker-side IndexedDB access

Dare al Worker accesso diretto a `message-store.ts` e una copia leggera di `NostraPeerMapper`. Il Worker risponde a se stesso senza passare dal main thread.

**Pro:** Zero latency crossing.
**Contro:** IndexedDB è accessibile dai Workers, ma `virtual-peers-db.ts` usa attualmente solo il main thread. Richiederebbe refactoring del peer mapping.

### Opzione C: Arricchire NOSTRA_STATIC con dati reali (ibrido)

Trasformare `nostraIntercept` nel Worker da statico a dinamico: quando il Worker riceve una risposta dal main thread (via MessagePort per i metodi che servono), la processa normalmente.

Questo è essenzialmente l'Opzione A con focus minimale sui metodi critici:
- `messages.getHistory` → bridge
- `messages.search` → bridge
- `messages.deleteMessages` → bridge + cascading cleanup
- Il resto → NOSTRA_STATIC come ora

### Raccomandazione: Opzione A (MessagePort bridge) per i metodi critici

È l'approccio che richiede meno cambiamenti al codice esistente e rispetta il contratto di tweb. Il Worker chiama, il main thread risponde con dati reali, il Worker li processa come farebbe con una risposta Telegram.

---

## 6. Metodi Critici da Bridgare

| Metodo | Priorità | Perché |
|--------|----------|--------|
| `messages.getHistory` | P0 | Senza questo, lo scroll e il reload non funzionano |
| `messages.search` | P0 | Search completamente rotto |
| `messages.deleteMessages` | P1 | Delete visuale non funziona (dati non nel Worker) |
| `messages.getDialogs` | P1 | Lista chat da caricare al reload |
| `contacts.getContacts` | P2 | Contatti Nostr |

I restanti metodi in `NOSTRA_STATIC` possono restare statici — non dipendono da dati P2P reali.
