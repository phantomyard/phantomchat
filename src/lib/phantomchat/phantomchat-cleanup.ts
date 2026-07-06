/**
 * Centralized cleanup of all PhantomChat data.
 * Runs in the main thread where DB connections are held.
 *
 * Two modes:
 *   clearAllPhantomChatData()  — full wipe (logout)
 *   clearAllExceptSeed()  — wipe everything EXCEPT the encrypted identity
 *                           (`PhantomChat.chat` IndexedDB + `phantomchat_identity` LS key)
 */

import {clearPeerProfileCache} from './peer-profile-cache';
import {logSwallow} from './log-swallow';
import {clearConversationKeyCache} from './nostr-crypto';
import {unsubscribePush} from '@lib/phantomchat/phantomchat-push-client';
import {destroy as destroyPushStorage} from '@lib/phantomchat/phantomchat-push-storage';
import {loadIdentity} from '@lib/phantomchat/identity';

// All PhantomChat IndexedDB database names
const PHANTOMCHAT_DB_NAMES = [
  'phantomchat-messages',
  'phantomchat-message-requests',
  'phantomchat-virtual-peers',
  'phantomchat-groups',
  'phantomchat-reactions',
  'PhantomChatPool',
  'PhantomChat.chat',
  'phantomchat-push',
  'phantomchat-local-media'
];

// All PhantomChat localStorage keys
const PHANTOMCHAT_LS_KEYS = [
  'phantomchat_identity',
  'phantomchat-relay-config',
  'phantomchat-last-seen-timestamp',
  'phantomchat:read-receipts-enabled',
  'phantomchat-folders-last-published',
  'phantomchat-folders-last-modified',
  'phantomchat-profile-cache',
  'phantomchat.update.installedVersion',
  'phantomchat.update.installedSwUrl',
  'phantomchat.update.lastAcceptedVersion',
  'phantomchat.update.lastIntegrityCheck',
  'phantomchat.update.lastIntegrityResult',
  'phantomchat.update.lastIntegrityDetails',
  'phantomchat.update.pendingFinalization',
  'phantomchat.update.pendingManifest',
  'phantomchat.update.flowState'
];

// The seed lives here — kept by `clearAllExceptSeed()`
const SEED_DB_NAME = 'PhantomChat.chat';
const SEED_LS_KEY = 'phantomchat_identity';

/**
 * Force-close all open connections to a database by triggering a version upgrade.
 * When we open with a higher version, the browser sends `versionchange` to all
 * existing connections. We hook `onversionchange` on our own connection to close it,
 * and other well-behaved connections will close too. Connections that don't handle
 * `versionchange` will be force-closed by the browser when we abort the upgrade.
 */
function forceCloseDB(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(name, 999999);
      req.onupgradeneeded = () => {
        req.transaction.abort();
      };
      req.onsuccess = () => {
        try { req.result.close(); } catch(e) { logSwallow('Cleanup.forceCloseDB.close', e); }
        resolve();
      };
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    } catch(e) {
      logSwallow('Cleanup.forceCloseDB.open', e);
      resolve();
    }
  });
}

function deleteDB(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(false);
    } catch(e) {
      logSwallow('Cleanup.deleteDB', e);
      resolve(false);
    }
  });
}

async function clearPhantomChatData(opts: {keepSeed: boolean}): Promise<string[]> {
  const dbNames = opts.keepSeed ?
    PHANTOMCHAT_DB_NAMES.filter((n) => n !== SEED_DB_NAME) :
    PHANTOMCHAT_DB_NAMES;
  const lsKeys = opts.keepSeed ?
    PHANTOMCHAT_LS_KEYS.filter((k) => k !== SEED_LS_KEY) :
    PHANTOMCHAT_LS_KEYS;

  // 0a. Unregister from push relay before tearing down the IDB the unregister needs
  //     to read from. Best-effort — never crash cleanup on network failure.
  //     Wrapped in a 1.5s timeout race so an IDB stuck in 'blocked' state
  //     (or slow network) doesn't stall logout/reset.
  try {
    await Promise.race([
      (async() => {
        const identity = await loadIdentity();
        if(identity?.privateKey) {
          await unsubscribePush({privkeyHex: identity.privateKey});
        }
      })(),
      new Promise<void>((resolve) => setTimeout(resolve, 1500))
    ]);
  } catch(e: any) {
    logSwallow('Cleanup.unsubscribePush', e);
  }

  // 0. Tear down the live ChatAPI / relay pool so the key bytes get zeroed
  //    before we delete the IndexedDB that backs the identity. Disconnecting
  //    inside the cleanup path is what triggers `privateKeyBytes.fill(0)` in
  //    NostrRelayPool.disconnect(). Swallow everything — cleanup must not
  //    fail on a missing/initialized pool.
  try {
    const chatAPI = (globalThis as any).__phantomchatChatAPI;
    if(chatAPI && typeof chatAPI.disconnect === 'function') {
      chatAPI.disconnect();
    }
  } catch(e) { logSwallow('Cleanup.chatAPIDisconnect', e); }

  // Drop every cached conversation key (NIP-44 ECDH secret). The cache is
  // keyed on sha256(senderPriv), so the raw hex was already never retained,
  // but the *derived* keys still live in memory until we clear them here.
  try {
    clearConversationKeyCache();
  } catch(e) { logSwallow('Cleanup.clearConvKeyCache', e); }

  // Terminate the gift-wrap unwrap worker — it holds a copy of the recipient
  // secret key (sent at init) and would otherwise outlive the identity.
  try {
    const {disposeNostrUnwrapClient} = await import('./nostr-unwrap-client');
    disposeNostrUnwrapClient();
  } catch(e) { logSwallow('Cleanup.disposeUnwrapWorker', e); }

  // Tear down presence (#52): stop the ping / stale-check / sweep timers and
  // clear tracked liveness so a logout doesn't leak intervals or state.
  try {
    const {destroyPresence} = await import('./phantomchat-presence');
    destroyPresence();
  } catch(e) { logSwallow('Cleanup.destroyPresence', e); }
  // NB: the local media store ('phantomchat-local-media', own voice notes /
  // images held for instant playback) is wiped via PHANTOMCHAT_DB_NAMES below
  // — deleteDB handles it without opening a connection (which could hang on a
  // version-change block).

  // 1. Close open DB connections held by singletons (none of these touch PhantomChat.chat)
  const closes: Promise<void>[] = [];
  try {
    const {getMessageStore} = await import('./message-store');
    closes.push(getMessageStore().destroy());
  } catch(e) { logSwallow('Cleanup.messageStore', e); }
  try {
    const {getMessageRequestStore} = await import('./message-requests');
    closes.push(getMessageRequestStore().destroy());
  } catch(e) { logSwallow('Cleanup.messageRequestStore', e); }
  try {
    const {getVirtualPeersDB} = await import('./virtual-peers-db');
    closes.push(getVirtualPeersDB().destroy());
  } catch(e) { logSwallow('Cleanup.virtualPeersDB', e); }
  try {
    const {getGroupStore} = await import('./group-store');
    closes.push(getGroupStore().destroy());
  } catch(e) { logSwallow('Cleanup.groupStore', e); }
  try {
    closes.push(destroyPushStorage());
  } catch(e) { logSwallow('Cleanup.pushStorage', e); }
  await Promise.allSettled(closes);

  // 2. Force-close any remaining connections
  await Promise.allSettled(dbNames.map((name) => forceCloseDB(name)));

  // 3. Delete databases
  const results = await Promise.all(
    dbNames.map(async(name) => ({name, ok: await deleteDB(name)}))
  );
  const failed = results.filter((r) => !r.ok).map((r) => r.name);

  // 4. Clear localStorage keys
  for(const key of lsKeys) {
    try {
      localStorage.removeItem(key);
    } catch(e) { logSwallow('Cleanup.removeLSKey:' + key, e); }
  }

  // Sweep cached VAPID public keys (keyed by endpointBase, not in the static list).
  try {
    const toRemove: string[] = [];
    for(let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if(k && k.startsWith('phantomchat-push-vapid-')) toRemove.push(k);
    }
    for(const k of toRemove) localStorage.removeItem(k);
  } catch(e) { logSwallow('Cleanup.vapidLs', e); }

  clearPeerProfileCache();

  return failed;
}

/**
 * Close all open PhantomChat DB connections, delete all databases, clear localStorage.
 * Returns list of database names that failed to delete.
 */
export function clearAllPhantomChatData(): Promise<string[]> {
  return clearPhantomChatData({keepSeed: false});
}

/**
 * Same as `clearAllPhantomChatData()` but preserves the encrypted identity:
 * keeps the `PhantomChat.chat` IndexedDB database and the `phantomchat_identity`
 * localStorage key. Used by the "Reset Local Data" flow so the user can
 * re-enter the app with the same seed.
 */
export function clearAllExceptSeed(): Promise<string[]> {
  return clearPhantomChatData({keepSeed: true});
}
