/**
 * Persistent store for NIP-25 reaction rows.
 *
 * Rows are keyed by the compound (targetEventId, fromPubkey, emoji) so that
 * a user adding multiple emoji on the same target produces multiple distinct
 * rows, while duplicate same-emoji publishes (e.g. self-echo from relay) are
 * idempotent. Each row preserves the originating kind-7 `reactionEventId` so
 * a later kind-5 delete can target it.
 *
 * Schema — IDB `nostra-reactions`, store `reactions`:
 *   keyPath: 'compoundKey' (= `${targetEventId}|${fromPubkey}|${emoji}`)
 *   indexes: by targetEventId, by fromPubkey
 */

export interface ReactionRow {
  /** compoundKey = `${targetEventId}|${fromPubkey}|${emoji}` — IDB keyPath */
  compoundKey?: string;
  targetEventId: string;
  /** tweb message id (derived) of the target for downstream dispatch. */
  targetMid: number;
  /** peerId of the chat the target belongs to. */
  targetPeerId: number;
  fromPubkey: string;
  emoji: string;
  /** kind-7 event id — used by kind-5 delete to remove this reaction. */
  reactionEventId: string;
  createdAt: number;
}

const DB_NAME = 'nostra-reactions';
const STORE = 'reactions';
const DB_VERSION = 1;

class NostraReactionsStore {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    if(this.db) return;
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if(!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, {keyPath: 'compoundKey'});
          os.createIndex('byTarget', 'targetEventId', {unique: false});
          os.createIndex('byFromPubkey', 'fromPubkey', {unique: false});
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private compound(row: Pick<ReactionRow, 'targetEventId' | 'fromPubkey' | 'emoji'>): string {
    return `${row.targetEventId}|${row.fromPubkey}|${row.emoji}`;
  }

  async add(row: ReactionRow): Promise<void> {
    await this.init();
    const compoundKey = this.compound(row);
    const tx = this.db!.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    await new Promise<void>((resolve, reject) => {
      // First-write-wins: check existing before put.
      const getReq = os.get(compoundKey);
      getReq.onsuccess = () => {
        if(getReq.result) return resolve(); // idempotent
        const putReq = os.put({...row, compoundKey});
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async getByTarget(targetEventId: string): Promise<ReactionRow[]> {
    await this.init();
    const tx = this.db!.transaction(STORE, 'readonly');
    const os = tx.objectStore(STORE);
    const idx = os.index('byTarget');
    return new Promise<ReactionRow[]>((resolve, reject) => {
      const req = idx.getAll(targetEventId);
      req.onsuccess = () => resolve(req.result as ReactionRow[]);
      req.onerror = () => reject(req.error);
    });
  }

  async getByFromPubkey(fromPubkey: string): Promise<ReactionRow[]> {
    await this.init();
    const tx = this.db!.transaction(STORE, 'readonly');
    const os = tx.objectStore(STORE);
    const idx = os.index('byFromPubkey');
    return new Promise<ReactionRow[]>((resolve, reject) => {
      const req = idx.getAll(fromPubkey);
      req.onsuccess = () => resolve(req.result as ReactionRow[]);
      req.onerror = () => reject(req.error);
    });
  }

  async removeByReactionEventId(reactionEventId: string): Promise<void> {
    await this.init();
    const tx = this.db!.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    await new Promise<void>((resolve, reject) => {
      const req = os.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if(!cur) return resolve();
        if((cur.value as ReactionRow).reactionEventId === reactionEventId) {
          cur.delete();
        }
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async getAll(): Promise<ReactionRow[]> {
    await this.init();
    const tx = this.db!.transaction(STORE, 'readonly');
    const os = tx.objectStore(STORE);
    return new Promise<ReactionRow[]>((resolve, reject) => {
      const req = os.getAll();
      req.onsuccess = () => resolve(req.result as ReactionRow[]);
      req.onerror = () => reject(req.error);
    });
  }

  async destroy(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}

export const nostraReactionsStore = new NostraReactionsStore();

if(typeof window !== 'undefined') {
  (window as any).__nostraReactionsStore = nostraReactionsStore;
}
