// @ts-nocheck
import type {Invariant, FuzzContext, InvariantResult, UserHandle} from '../types';

const COLLECT_MIRRORS_VS_IDB = async() => {
  const proxy = (window as any).apiManagerProxy;
  const mirrors = proxy?.mirrors?.messages || {};
  const mirrorMids: number[] = [];
  for(const key of Object.keys(mirrors)) {
    if(!key.endsWith('_history')) continue;
    for(const mid of Object.keys(mirrors[key] || {})) mirrorMids.push(Number(mid));
  }
  const idbMids: number[] = [];
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
    for(const row of all) if(row.mid != null) idbMids.push(Number(row.mid));
    db.close();
  } catch{ /* fresh db, treat as empty */ }
  return {mirrorMids, idbMids};
};

const COLLECT_PEERS = async() => {
  const proxy = (window as any).apiManagerProxy;
  const peersMap = proxy?.mirrors?.peers || {};
  return {peers: Object.entries(peersMap).map(([peerId, u]: any) => ({peerId: Number(peerId), first_name: u?.first_name}))};
};

export const mirrorsIdbCoherent: Invariant = {
  id: 'INV-mirrors-idb-coherent',
  tier: 'medium',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const u: UserHandle = ctx.users[id];
      const snap = await u.page.evaluate(COLLECT_MIRRORS_VS_IDB);
      const idbSet = new Set(snap.idbMids);
      // Exclude in-flight temp mids (fractional) — they live briefly in the
      // mirror before the VMT renames them to the real timestamp-derived mid.
      // Absent from IDB by design during send. Real P2P mids are integers
      // >= 2^50 (see generateTempMessageId integer fallback for FIND-cfd24d69).
      const missing = snap.mirrorMids.filter((m) => Number.isInteger(m) && !idbSet.has(m));
      if(missing.length > 0) {
        return {ok: false, message: `mirror mids not in idb on ${id}: ${missing.slice(0, 5).join(',')}`, evidence: {user: id, missing}};
      }
    }
    return {ok: true};
  }
};

const COLLECT_IDB_IDENTITY = async() => {
  const rows: Array<{eventId: string; mid: any; twebPeerId: any; timestamp: any}> = [];
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
    for(const row of all) {
      rows.push({
        eventId: row.eventId,
        mid: row.mid,
        twebPeerId: row.twebPeerId,
        timestamp: row.timestamp
      });
    }
    db.close();
  } catch{ /* fresh db, treat as empty */ }
  return {rows};
};

/**
 * INV-stored-message-identity-complete — every row in `nostra-messages`
 * MUST carry the full identity triple {mid, twebPeerId, timestamp} at rest.
 *
 * This is the write-path guard that keeps the invariant
 * INV-mirrors-idb-coherent honest: a row without mid is a silent source
 * for downstream ghost mids (root cause of FIND-e49755c1). The fuzzer
 * scans IDB after every medium-tier check and fails fast if any row is
 * partial.
 *
 * Synthetic contact-init rows (`eventId` starts with `contact-init-`)
 * historically carried mid=0 as a marker; they are excluded from the
 * strictness check because they never render as bubbles.
 */
export const storedMessageIdentityComplete: Invariant = {
  id: 'INV-stored-message-identity-complete',
  tier: 'medium',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const u: UserHandle = ctx.users[id];
      const snap = await u.page.evaluate(COLLECT_IDB_IDENTITY);
      for(const row of snap.rows) {
        if(typeof row.eventId === 'string' && row.eventId.startsWith('contact-init-')) continue;
        const problems: string[] = [];
        if(row.mid == null) problems.push('mid');
        if(row.twebPeerId == null) problems.push('twebPeerId');
        if(row.timestamp == null) problems.push('timestamp');
        if(problems.length > 0) {
          return {
            ok: false,
            message: `stored message missing ${problems.join('+')} on ${id}: eventId=${String(row.eventId).slice(0, 16)}`,
            evidence: {user: id, eventId: row.eventId, problems, row}
          };
        }
      }
    }
    return {ok: true};
  }
};

const HEX_FALLBACK = /^[0-9a-f]{8}/;

export const peersComplete: Invariant = {
  id: 'INV-peers-complete',
  tier: 'medium',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const u: UserHandle = ctx.users[id];
      const snap = await u.page.evaluate(COLLECT_PEERS);
      for(const p of snap.peers) {
        if(p.first_name && HEX_FALLBACK.test(p.first_name)) {
          return {ok: false, message: `peer ${p.peerId} first_name is hex fallback on ${id}: ${p.first_name}`, evidence: {user: id, peerId: p.peerId, firstName: p.first_name}};
        }
      }
    }
    return {ok: true};
  }
};
