// @ts-nocheck
import type {Invariant, FuzzContext, InvariantResult} from '../types';

export const noNip04: Invariant = {
  id: 'INV-no-nip04',
  tier: 'regression',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    const relay: any = ctx.relay;
    if(!relay?.getAllEvents) return {ok: true}; // in unit tests without relay
    const events = await relay.getAllEvents();
    const nip04 = events.filter((e: any) => e.kind === 4);
    if(nip04.length > 0) {
      return {ok: false, message: `found ${nip04.length} kind 4 (NIP-04) events on relay — Nostra must use NIP-44 (kind 1059 gift-wrap)`, evidence: {kindCounts: {nip04: nip04.length, total: events.length}}};
    }
    return {ok: true};
  }
};

const DUMP_IDENTITY_IDB = async() => {
  try {
    const req = indexedDB.open('Nostra.chat');
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if(!db.objectStoreNames.contains('nostra_identity')) {
      db.close();
      return '';
    }
    const tx = db.transaction('nostra_identity', 'readonly');
    const store = tx.objectStore('nostra_identity');
    const all: any[] = await new Promise((resolve, reject) => {
      const r = store.getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return JSON.stringify(all);
  } catch {
    return '';
  }
};

export const idbSeedEncrypted: Invariant = {
  id: 'INV-idb-seed-encrypted',
  tier: 'regression',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const u: any = ctx.users[id];
      const dump = await u.page.evaluate(DUMP_IDENTITY_IDB);
      if(/\bnsec1[0-9a-z]{20,}/.test(dump)) {
        return {ok: false, message: `plaintext nsec1… found in nostra_identity IDB on ${id}`, evidence: {user: id, dumpSample: dump.slice(0, 200)}};
      }
      // 12-word seed phrase heuristic: four space-separated words >=3 chars each
      if(/\b[a-z]{3,12}\b(?:\s+\b[a-z]{3,12}\b){3,}/.test(dump)) {
        const hasCrypto = /ciphertext|encrypted|aesgcm|iv/i.test(dump);
        if(!hasCrypto) {
          return {ok: false, message: `plaintext seed phrase pattern found in nostra_identity IDB on ${id} (no ciphertext markers)`, evidence: {user: id, dumpSample: dump.slice(0, 200)}};
        }
      }
    }
    return {ok: true};
  }
};

export const editPreservesMidTimestamp: Invariant = {
  id: 'INV-edit-preserves-mid-timestamp',
  tier: 'regression',
  async check(ctx: FuzzContext, action?: any): Promise<InvariantResult> {
    if(!action || action.name !== 'editRandomOwnBubble' || action.skipped) return {ok: true};
    const before = action.meta?.beforeSnapshot;
    const editedMid = action.meta?.editedMid;
    if(!before || !editedMid) return {ok: true};
    const user = ctx.users[action.args.user as 'userA' | 'userB'];
    const after = await user.page.evaluate((m: string) => {
      const b = document.querySelector(`.bubbles-inner .bubble[data-mid="${m}"]`);
      if(!b) return null;
      return {mid: (b as HTMLElement).dataset.mid, timestamp: (b as HTMLElement).dataset.timestamp};
    }, String(editedMid));
    if(!after) return {ok: false, message: `edited bubble mid=${editedMid} not found post-edit`, evidence: {before}};
    if(after.mid !== before.mid) {
      return {ok: false, message: `edit changed mid: ${before.mid} → ${after.mid}`, evidence: {before, after}};
    }
    if(after.timestamp !== before.timestamp) {
      return {ok: false, message: `edit changed timestamp: ${before.timestamp} → ${after.timestamp}`, evidence: {before, after}};
    }
    return {ok: true};
  }
};

const COLLECT_EDIT_ROWS = async() => {
  try {
    const req = indexedDB.open('nostra-messages');
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction('messages', 'readonly');
    const store = tx.objectStore('messages');
    const all: any[] = await new Promise((resolve, reject) => {
      const r = store.getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return all.filter((row: any) => row.editedAt != null);
  } catch { return []; }
};

export const editAuthorCheck: Invariant = {
  id: 'INV-edit-author-check',
  tier: 'regression',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const u: any = ctx.users[id];
      const rows = await u.page.evaluate(COLLECT_EDIT_ROWS);
      for(const row of rows) {
        if(row.editAuthorPubkey && row.senderPubkey && row.editAuthorPubkey !== row.senderPubkey) {
          return {ok: false, message: `edit author mismatch on mid=${row.mid} (${id}): edit by ${row.editAuthorPubkey} vs original sender ${row.senderPubkey}`, evidence: {user: id, row}};
        }
      }
    }
    return {ok: true};
  }
};

export const virtualPeerIdStable: Invariant = {
  id: 'INV-virtual-peer-id-stable',
  tier: 'regression',
  async check(ctx: FuzzContext, action?: any): Promise<InvariantResult> {
    if(!action || action.name !== 'reloadPage') return {ok: true};
    const userId = action.args.user;
    const snapshotKey = `preReloadPeerMap-${userId}`;
    const before = ctx.snapshots.get(snapshotKey) as Record<string, number> | undefined;
    if(!before) return {ok: true};
    const u: any = ctx.users[userId];
    const after: Record<string, number> = await u.page.evaluate(async() => {
      const proxy = (window as any).apiManagerProxy;
      const peers = proxy?.mirrors?.peers || {};
      const map: Record<string, number> = {};
      for(const [peerId, p] of Object.entries<any>(peers)) {
        if(p?.p2pPubkey) map[p.p2pPubkey] = Number(peerId);
      }
      return map;
    });
    for(const [pubkey, beforeId] of Object.entries(before)) {
      const afterId = after[pubkey];
      if(afterId === undefined) continue;
      if(afterId !== beforeId) {
        return {ok: false, message: `peer id changed across reload: pubkey ${pubkey.slice(0, 12)}… ${beforeId} → ${afterId}`, evidence: {pubkey, beforeId, afterId}};
      }
    }
    return {ok: true};
  }
};
