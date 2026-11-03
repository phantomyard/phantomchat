/**
 * Per-contact preferences for the contacts redesign: the contact TYPE
 * (Phantom | Human | Provider) and the Local tools switch.
 *
 * Why a database of its own, not two new fields on the virtual-peers mapping:
 *   - `storeMapping` rebuilds the mapping record from a fixed field list on
 *     every upsert (the receive path calls it per message), so an extra field
 *     there would be silently wiped.
 *   - Adding a store to `phantomchat-virtual-peers` means a DB version bump,
 *     and an older build opening a newer-version database fails outright —
 *     a Stable rollback would lose the contact list. A separate database is
 *     simply ignored by older builds.
 *
 * Local only for now: these prefs are NOT carried by contacts-sync. A contact
 * with no row falls back to {@link resolveContactKind}: a kind-0 `bot` flag
 * means Phantom, anything else keeps today's look (Phantom sigil, no badge).
 */

export type ContactKind = 'phantom' | 'human' | 'provider';

export const CONTACT_KINDS: readonly ContactKind[] = ['phantom', 'human', 'provider'];

export interface ContactPrefs {
  /** Nostr hex pubkey (lowercase). */
  pubkey: string;
  kind?: ContactKind;
  /** Local tools on this PC offered to the contact. Phantom/Provider only. */
  localTools?: boolean;
  updatedAt: number;
}

const DB_NAME = 'phantomchat-contact-prefs';
const DB_VERSION = 1;
const STORE = 'prefs';

let dbPromise: Promise<IDBDatabase> | null = null;
const cache = new Map<string, ContactPrefs | null>();
const listeners = new Set<(prefs: ContactPrefs) => void>();

function openDB(): Promise<IDBDatabase> {
  if(!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = () => {
        const db = req.result;
        if(!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, {keyPath: 'pubkey'});
        }
      };
    });
  }
  return dbPromise;
}

export function isContactKind(value: unknown): value is ContactKind {
  return typeof value === 'string' && (CONTACT_KINDS as readonly string[]).includes(value);
}

function normalizePubkey(pubkey: string): string {
  return (pubkey || '').trim().toLowerCase();
}

export async function getContactPrefs(pubkey: string): Promise<ContactPrefs | undefined> {
  const key = normalizePubkey(pubkey);
  if(!key) return undefined;
  if(cache.has(key)) return cache.get(key) || undefined;
  try {
    const db = await openDB();
    const row = await new Promise<ContactPrefs | undefined>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result as ContactPrefs | undefined);
    });
    cache.set(key, row || null);
    return row;
  } catch(err) {
    // Prefs are cosmetic + opt-in: a broken store must never break a chat.
    console.warn('[contact-prefs] read failed', err);
    return undefined;
  }
}

/**
 * Merge `patch` into the stored prefs. Only fields present in the patch
 * change; `kind` is validated so a bad value can never be persisted.
 */
export async function setContactPrefs(
  pubkey: string,
  patch: {kind?: ContactKind; localTools?: boolean}
): Promise<ContactPrefs> {
  const key = normalizePubkey(pubkey);
  if(!/^[0-9a-f]{64}$/.test(key)) throw new Error('contact-prefs: expected a hex pubkey');
  if(patch.kind !== undefined && !isContactKind(patch.kind)) {
    throw new Error('contact-prefs: unknown contact kind');
  }
  const db = await openDB();
  const next = await new Promise<ContactPrefs>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const getReq = store.get(key);
    let record: ContactPrefs;
    getReq.onerror = () => reject(getReq.error);
    getReq.onsuccess = () => {
      const existing = getReq.result as ContactPrefs | undefined;
      record = {
        pubkey: key,
        kind: patch.kind ?? existing?.kind,
        localTools: patch.localTools ?? existing?.localTools,
        updatedAt: Date.now()
      };
      store.put(record);
    };
    tx.oncomplete = () => resolve(record);
    tx.onabort = () => reject(tx.error || new Error('contact-prefs write aborted'));
  });
  cache.set(key, next);
  listeners.forEach((listener) => {
    try { listener(next); } catch{}
  });
  return next;
}

/**
 * Put a contact's prefs back to an earlier snapshot: `previous` undefined means
 * there was no row, so the row is removed. Used to undo a prefs write when the
 * contact add it was made for fails.
 */
export async function restoreContactPrefs(pubkey: string, previous: ContactPrefs | undefined): Promise<void> {
  if(!previous) return clearContactPrefs(pubkey);
  const key = normalizePubkey(pubkey);
  if(!key) return;
  const record: ContactPrefs = {...previous, pubkey: key};
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('contact-prefs restore aborted'));
  });
  cache.set(key, record);
  listeners.forEach((listener) => {
    try { listener(record); } catch{}
  });
}

/** Drop a contact's prefs (used when the contact itself is deleted). */
export async function clearContactPrefs(pubkey: string): Promise<void> {
  const key = normalizePubkey(pubkey);
  if(!key) return;
  cache.delete(key);
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } catch(err) {
    console.warn('[contact-prefs] clear failed', err);
  }
}

export function onContactPrefsChange(listener: (prefs: ContactPrefs) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The effective type of a contact: the stored choice wins; otherwise a kind-0
 * `bot` flag means Phantom; otherwise undefined (a legacy contact, rendered
 * exactly as before this feature).
 */
export function resolveContactKind(stored: ContactKind | undefined, isBot: boolean): ContactKind | undefined {
  if(stored) return stored;
  return isBot ? 'phantom' : undefined;
}

/** Local tools only exist for contacts that run on a phantombot engine. */
export function kindSupportsLocalTools(kind: ContactKind | undefined): boolean {
  return kind === 'phantom' || kind === 'provider';
}

/** Test seam: forget the in-memory cache and DB handle. */
export function _resetContactPrefsForTests(): void {
  cache.clear();
  listeners.clear();
  const pending = dbPromise;
  dbPromise = null;
  pending?.then((db) => db.close(), () => {});
}
