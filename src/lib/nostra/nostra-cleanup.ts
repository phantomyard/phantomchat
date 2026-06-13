/**
 * Centralized cleanup of all Nostra data.
 * Runs in the main thread where DB connections are held.
 *
 * Two modes:
 *   clearAllNostraData()  — full wipe (logout)
 *   clearAllExceptSeed()  — wipe everything EXCEPT the encrypted identity
 *                           (`Nostra.chat` IndexedDB + `nostra_identity` LS key)
 */

import {clearPeerProfileCache} from './peer-profile-cache';
import {logSwallow} from './log-swallow';
import {clearConversationKeyCache} from './nostr-crypto';
import {unsubscribePush} from '@lib/nostra/nostra-push-client';
import {destroy as destroyPushStorage} from '@lib/nostra/nostra-push-storage';
import {loadIdentity} from '@lib/nostra/identity';

// All Nostra IndexedDB database names
const NOSTRA_DB_NAMES = [
  'nostra-messages',
  'nostra-message-requests',
  'nostra-virtual-peers',
  'nostra-groups',
  'nostra-reactions',
  'NostraPool',
  'Nostra.chat',
  'nostra-push'
];

// All Nostra localStorage keys
const NOSTRA_LS_KEYS = [
  'nostra_identity',
  'nostra-relay-config',
  'nostra-last-seen-timestamp',
  'nostra:read-receipts-enabled',
  'nostra-folders-last-published',
  'nostra-folders-last-modified',
  'nostra-profile-cache',
  'nostra.update.installedVersion',
  'nostra.update.installedSwUrl',
  'nostra.update.lastAcceptedVersion',
  'nostra.update.lastIntegrityCheck',
  'nostra.update.lastIntegrityResult',
  'nostra.update.lastIntegrityDetails',
  'nostra.update.pendingFinalization',
  'nostra.update.pendingManifest',
  'nostra.update.flowState'
];

// The seed lives here — kept by `clearAllExceptSeed()`
const SEED_DB_NAME = 'Nostra.chat';
const SEED_LS_KEY = 'nostra_identity';

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

async function clearNostraData(opts: {keepSeed: boolean}): Promise<string[]> {
  const dbNames = opts.keepSeed ?
    NOSTRA_DB_NAMES.filter((n) => n !== SEED_DB_NAME) :
    NOSTRA_DB_NAMES;
  const lsKeys = opts.keepSeed ?
    NOSTRA_LS_KEYS.filter((k) => k !== SEED_LS_KEY) :
    NOSTRA_LS_KEYS;

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
    const chatAPI = (globalThis as any).__nostraChatAPI;
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

  // 1. Close open DB connections held by singletons (none of these touch Nostra.chat)
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
      if(k && k.startsWith('nostra-push-vapid-')) toRemove.push(k);
    }
    for(const k of toRemove) localStorage.removeItem(k);
  } catch(e) { logSwallow('Cleanup.vapidLs', e); }

  clearPeerProfileCache();

  return failed;
}

/**
 * Close all open Nostra DB connections, delete all databases, clear localStorage.
 * Returns list of database names that failed to delete.
 */
export function clearAllNostraData(): Promise<string[]> {
  return clearNostraData({keepSeed: false});
}

/**
 * Same as `clearAllNostraData()` but preserves the encrypted identity:
 * keeps the `Nostra.chat` IndexedDB database and the `nostra_identity`
 * localStorage key. Used by the "Reset Local Data" flow so the user can
 * re-enter the app with the same seed.
 */
export function clearAllExceptSeed(): Promise<string[]> {
  return clearNostraData({keepSeed: true});
}
