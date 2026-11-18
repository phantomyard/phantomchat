/**
 * Ask the browser to keep this origin's storage (IndexedDB message history,
 * identity, settings) out of automatic eviction.
 *
 * Without this, a PWA's storage is "best-effort": the browser may clear it under
 * disk pressure or after a long idle period, and the user's local history would
 * then only survive as far as the relays still hold it. Chromium (and so the
 * Electron desktop shell) grants or denies silently from engagement heuristics;
 * Firefox may show a one-time permission prompt. Never throws, and a denial is
 * not an error — storage still works, it just stays best-effort.
 */
export type PersistentStorageResult = 'persisted' | 'granted' | 'denied' | 'unsupported' | 'error';

type StorageLike = {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
};

export async function requestPersistentStorage(
  storage: StorageLike | undefined = typeof navigator !== 'undefined' ? navigator.storage : undefined
): Promise<PersistentStorageResult> {
  if(!storage || typeof storage.persist !== 'function') return 'unsupported';
  try {
    if(typeof storage.persisted === 'function' && await storage.persisted()) return 'persisted';
    const granted = await storage.persist();
    const result: PersistentStorageResult = granted ? 'granted' : 'denied';
    console.log('[PersistentStorage] persist():', result);
    return result;
  } catch(err) {
    console.warn('[PersistentStorage] persist() failed:', (err as Error)?.message);
    return 'error';
  }
}
