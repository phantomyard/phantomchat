# MessagePort Bridge: Worker↔Main Virtual MTProto

**Data:** 2026-04-06
**Status:** Approvato

## Problema

Il Worker è cieco: `NOSTRA_STATIC` ritorna `{messages: []}` per tutti i metodi che richiedono dati reali. `NostraMTProtoServer` vive solo sul main thread. Il Worker non chiama mai `saveMessages()`, i mirrors restano vuoti, e tutte le feature che leggono dai mirrors si rompono (context menu, search, getHistory, deleteMessages).

## Soluzione

Un bridge RPC via `SuperMessagePort` che permette al Worker di chiamare `NostraMTProtoServer.handleMethod()` sul main thread e ricevere risposte reali. Il Worker le processa normalmente con `saveMessages()` → mirror pipeline → UI.

## Componenti

### 1. Worker side — `nostraIntercept()` modificato

**File:** `src/lib/appManagers/apiManager.ts`

`nostraIntercept()` cambia da lookup statico a RPC bridge per i metodi dinamici:

```typescript
private nostraIntercept(method: string, params: any): any {
  // Main thread: usa il server locale (invariato)
  if(this.nostraMTProtoServer) {
    return this.nostraMTProtoServer.handleMethod(method, params);
  }

  // Worker: metodi statici restano locali (nessun round-trip)
  const staticResponse = ApiManager.NOSTRA_STATIC[method];
  if(staticResponse !== undefined) return staticResponse;

  // Worker: metodi dinamici passano per il bridge
  if(ApiManager.NOSTRA_BRIDGE_METHODS.has(method)) {
    return MTProtoMessagePort.getInstance<false>()
      .invoke('nostraBridge', {method, params});
  }

  // Action methods → true
  if(ApiManager.NOSTRA_ACTION_PREFIXES.some((p) => method.includes(p))) return true;

  return {pFlags: {}};
}
```

**`NOSTRA_BRIDGE_METHODS`** (metodi che richiedono dati reali):

```typescript
private static readonly NOSTRA_BRIDGE_METHODS = new Set([
  'messages.getHistory',
  'messages.getDialogs',
  'messages.getPinnedDialogs',
  'messages.search',
  'messages.deleteMessages',
  'messages.sendMessage',
  'messages.sendMedia',
  'contacts.getContacts',
  'users.getUsers',
  'users.getFullUser'
]);
```

**`NOSTRA_STATIC`** ridotto — rimuove i metodi bridged, mantiene solo risposte strutturali fisse:

```typescript
private static readonly NOSTRA_STATIC: Record<string, any> = {
  'messages.getSearchCounters': [],
  'messages.getSavedDialogs': {_: 'messages.savedDialogs', dialogs: [], messages: [], chats: [], users: []},
  'messages.getPinnedSavedDialogs': {_: 'messages.savedDialogs', dialogs: [], messages: [], chats: [], users: []},
  'messages.getDialogFilters': {_: 'messages.dialogFilters', pFlags: {}, filters: []},
  'messages.getSuggestedDialogFilters': [],
  'messages.readHistory': {_: 'messages.affectedMessages', pts: 1, pts_count: 0},
  'messages.getStickers': {_: 'messages.stickers', hash: 0, stickers: []},
  'messages.getAllStickers': {_: 'messages.allStickers', hash: 0, sets: []},
  'messages.getEmojiKeywordsDifference': {_: 'emojiKeywordsDifference', lang_code: 'en', from_version: 0, version: 1, keywords: []},
  'contacts.getTopPeers': {_: 'contacts.topPeersDisabled'},
  'updates.getState': {_: 'updates.state', pts: 1, qts: 0, date: Math.floor(Date.now() / 1000), seq: 1, unread_count: 0},
  'updates.getDifference': {_: 'updates.differenceEmpty', date: Math.floor(Date.now() / 1000), seq: 1},
  'photos.getUserPhotos': {_: 'photos.photos', photos: [], users: []},
  'stories.getAllStories': {_: 'stories.allStories', pFlags: {}, count: 0, state: '', peer_stories: [], chats: [], users: [], stealth_mode: {_: 'storiesStealthMode', pFlags: {}}},
  'stories.getPeerStories': {_: 'stories.peerStories', stories: {_: 'peerStories', pFlags: {}, peer: {_: 'peerUser', user_id: 0}, stories: []}, chats: [], users: []},
  'account.getContentSettings': {_: 'account.contentSettings', pFlags: {}},
  'account.getNotifySettings': {_: 'peerNotifySettings', pFlags: {}, flags: 0},
  'account.getPassword': {_: 'account.password', pFlags: {has_password: false}, new_algo: {_: 'passwordKdfAlgoUnknown'}, new_secure_algo: {_: 'securePasswordKdfAlgoUnknown'}, secure_random: new Uint8Array(0)},
  'account.getPrivacy': {_: 'account.privacyRules', rules: [{_: 'privacyValueAllowAll'}], chats: [], users: []},
  'help.getConfig': {/* stesso oggetto config già presente — omesso per brevità */},
  'help.getAppConfig': {_: 'help.appConfig', hash: 0, config: {_: 'jsonObject', value: []}},
  'langpack.getDifference': {_: 'langPackDifference', lang_code: 'en', from_version: 0, version: 1, strings: []}
};
```

### 2. Main thread side — listener `nostraBridge`

**File:** `src/lib/apiManagerProxy.ts`

Aggiunge `nostraBridge` al listener map di `MTProtoMessagePort`:

```typescript
// In addMultipleEventsListeners():
nostraBridge: async({method, params}: {method: string, params: any}) => {
  if(!this.nostraMTProtoServer) {
    throw new Error('[apiManagerProxy] nostraBridge: server not registered');
  }
  return this.nostraMTProtoServer.handleMethod(method, params);
}
```

E un setter per registrare il server:

```typescript
private nostraMTProtoServer: NostraMTProtoServer;

public setNostraMTProtoServer(server: NostraMTProtoServer) {
  this.nostraMTProtoServer = server;
}
```

**File:** `src/lib/mainWorker/mainMessagePort.ts`

Aggiunge `nostraBridge` ai tipi del port:

```typescript
// In MasterToWorkerListeners (main → Worker direction):
// No change needed — Worker invokes, main responds

// In WorkerToMasterListeners (Worker → main direction):
nostraBridge: (payload: {method: string, params: any}) => any;
```

### 3. NostraMTProtoServer — metodi aggiuntivi

**File:** `src/lib/nostra/virtual-mtproto-server.ts`

Il server gestisce già: `getHistory`, `search`, `deleteMessages`, `getDialogs`, `getContacts`.

Aggiungere:

**`sendMessage`**: Riceve params MTProto standard, estrae peer+text, chiama ChatAPI per inviare via Nostr relay, salva in message-store, ritorna:
```typescript
{
  _: 'updates',
  updates: [{
    _: 'updateNewMessage',
    message: createdTwebMessage,
    pts: nextPts,
    pts_count: 1
  }],
  users: [senderUser],
  chats: [],
  date: timestamp,
  seq: 0
}
```

**`sendMedia`**: Stesso pattern, gestisce file attachment via Nostr relay.

**`users.getUsers`**: Lookup in virtual-peers-db, ritorna array di User objects.

**`users.getFullUser`**: Lookup + profile data, ritorna UserFull.

### 4. Registrazione del server

**File:** `src/pages/nostra-onboarding-integration.ts`

Cambia da:
```typescript
const server = new NostraMTProtoServer();
(window as any).__nostraMTProtoServer = server;
```
A:
```typescript
const server = new NostraMTProtoServer();
const proxy = MOUNT_CLASS_TO.apiManagerProxy;
proxy.setNostraMTProtoServer(server);
```

### 5. Cleanup hack UI — revert verso vanilla

Con il bridge attivo, questi hack diventano inutili perché i dati sono nei mirrors tramite il pipeline standard `saveMessages()` → mirror:

**`src/components/chat/contextMenu.ts`:**
- Rimuovere blocco `catch(err)` con fallback P2P e creazione messaggio sintetico (linee 456-503)
- Rimuovere `pid >= 1e15` nel verify delete (linee 1101-1104)
- Rimuovere catch in `filterButtons` con fallback solo-delete (linee 1270-1281)
- Rimuovere try/catch su `getMidsByMid` (linee 1833-1838)

**`src/components/chat/input.ts`:**
- Rimuovere `sendP2PMessage()` method (~35 righe)
- Rimuovere routing `pid >= 1e15` in send flow (~15 righe)
- Il send vanilla passa per `appMessagesManager.sendMessage()` → Worker → bridge → server

**`src/components/dialogsContextMenu.ts`:**
- Rimuovere `deleteP2PChat()` method (~50 righe)
- Rimuovere routing P2P in `onDeleteClick()` (~15 righe)
- Rimuovere `pid >= 1e15` in `checkIfCanDelete()` (linea 291-293)

**`src/pages/nostra-onboarding-integration.ts`:**
- Rimuovere inject manuale in `mirrors.messages[]` (linee 170-174)
- Rimuovere dispatch manuale `history_append` (linee 176-179)
- Rimuovere `setTimeout` con push dialogs/users in mirrors (linee 188-210+)
- Il boot diventa: crea server → registra su apiManagerProxy → fine. Il Worker chiederà i dati da solo quando serve.

**`src/components/chat/selection.ts`:**
- Rimuovere hack P2P per selezione messaggi

## Data Flow

### Lettura (getHistory, search, getDialogs)

```
bubbles.ts → appMessagesManager.getHistory()          [Worker]
  → apiManager.invokeApi('messages.getHistory', params) [Worker]
  → nostraIntercept() → NOSTRA_BRIDGE_METHODS.has() ✓   [Worker]
  → port.invoke('nostraBridge', {method, params})        [Worker → Main]
  → apiManagerProxy listener                             [Main]
  → NostraMTProtoServer.handleMethod()                   [Main]
  → legge IndexedDB, crea Message[] tweb-nativi          [Main]
  ← ritorna {messages: [...], users: [...], count: N}    [Main → Worker]
  ← Worker riceve risposta                               [Worker]
  → saveMessages() per ogni messaggio                    [Worker]
  → setMessageToStorage() → invokeVoid('mirror', ...)    [Worker → Main]
  → mirrors.messages[storageKey][mid] = messaggio        [Main]
  → UI legge dai mirrors                                 [Main]
```

### Scrittura (sendMessage)

```
input.ts → appMessagesManager.sendMessage()             [Worker]
  → apiManager.invokeApi('messages.sendMessage', params) [Worker]
  → nostraIntercept() → bridge                           [Worker → Main]
  → server.sendMessage() → ChatAPI.send() via relay      [Main]
  → salva in message-store                               [Main]
  ← ritorna {_: 'updates', updates: [...]}               [Main → Worker]
  ← Worker riceve updates                                [Worker]
  → processUpdates() → saveMessages()                    [Worker]
  → mirror → UI                                          [Worker → Main]
```

### Cancellazione (deleteMessages)

```
contextMenu.ts → PopupDeleteMessages                    [Main]
  → appMessagesManager.deleteMessages()                  [Worker]
  → apiManager.invokeApi('messages.deleteMessages', ...) [Worker]
  → nostraIntercept() → bridge                           [Worker → Main]
  → server.deleteMessages() → cancella da IndexedDB      [Main]
  ← ritorna {pts, pts_count}                             [Main → Worker]
  ← Worker riceve risposta                               [Worker]
  → processLocalUpdate('updateDeleteMessages')           [Worker]
  → deleteMessageFromStorage()                           [Worker]
  → invokeVoid('mirror', {value: undefined})             [Worker → Main]
  → mirror rimuove messaggio → UI aggiorna               [Main]
```

## Error Handling

- Se `NostraMTProtoServer.handleMethod()` lancia errore → il bridge lo propaga come Promise rejection al Worker → `invokeApi` rifiuta → UI mostra errore standard tweb
- Se il main thread non risponde → `SuperMessagePort` timeout built-in → rejection
- Nessun fallback a `NOSTRA_STATIC` per metodi bridged — un errore è un errore reale, non da mascherare

## Testing

- **Unit test bridge:** mock `MTProtoMessagePort`, verifica che `nostraIntercept` chiama bridge per metodi dinamici e `NOSTRA_STATIC` per statici
- **Unit test server.sendMessage():** verifica che chiama ChatAPI e ritorna `updates` corretto
- **Integration test:** Worker→Bridge→Server→IndexedDB round-trip per getHistory
- Test esistenti in `src/tests/nostra/` (virtual-mtproto-server, nostra-sync, peer-mapper) restano validi

## Scope escluso

- Refactoring di `NostraMTProtoServer` oltre ai metodi aggiunti
- Modifica di file vanilla tweb non elencati nel cleanup
- Tor/relay UI (topbar.ts, nostraStatus.ts) — sono modifiche UI necessarie, non hack
- Group chat — il bridge funziona per gruppi quando il server li gestirà
