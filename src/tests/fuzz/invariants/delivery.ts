// @ts-nocheck
import type {Invariant, FuzzContext, UserHandle, InvariantResult, Action} from '../types';

const PROPAGATION_MS = 2000;

export const deliveryUiMatchesTracker: Invariant = {
  id: 'INV-delivery-ui-matches-tracker',
  tier: 'cheap',
  async check(ctx: FuzzContext, action?: Action): Promise<InvariantResult> {
    // Propagation window: if the last action was a send, give 2s for the tick
    // to settle before we compare.
    if(action?.name === 'sendText') {
      const sentAt = (action.meta?.sentAt as number) || 0;
      if(Date.now() - sentAt < PROPAGATION_MS) return {ok: true};
    }

    for(const id of ['userA', 'userB'] as const) {
      const res = await checkOne(ctx.users[id], id);
      if(!res.ok) return res;
    }
    return {ok: true};
  }
};

async function checkOne(user: UserHandle, id: 'userA' | 'userB'): Promise<InvariantResult> {
  const payload = await user.page.evaluate(() => {
    const tracker = (window as any).__nostraChatAPI?.deliveryTracker;
    const states: Record<string, string> = tracker?.getAllStates
      ? tracker.getAllStates()
      : (tracker?.states ? Object.fromEntries(tracker.states) : {});

    const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid].is-out, .bubbles-inner .bubble[data-mid].is-own'));
    const domStates: Array<{mid: string; cls: string}> = bubbles.map((b) => {
      const el = b as HTMLElement;
      const classes = Array.from(el.classList);
      let cls = 'unknown';
      if(classes.includes('is-read')) cls = 'read';
      else if(classes.includes('is-delivered')) cls = 'delivered';
      else if(classes.includes('is-sent')) cls = 'sent';
      else if(classes.includes('is-sending')) cls = 'sending';
      return {mid: el.dataset.mid || '', cls};
    });

    return {states, domStates};
  });

  for(const d of payload.domStates) {
    const trackerState = payload.states[d.mid];
    if(trackerState === undefined) continue; // tracker unaware — separate invariant
    // Monotonic ordering of states: sending < sent < delivered < read. DOM can
    // be at or ABOVE tracker (DOM is slow); DOM below tracker is the bug.
    const order = ['sending', 'sent', 'delivered', 'read'];
    const di = order.indexOf(d.cls);
    const ti = order.indexOf(trackerState);
    if(di === -1 || ti === -1) continue;
    if(di < ti) {
      return {
        ok: false,
        message: `bubble ${d.mid} DOM state '${d.cls}' below tracker state '${trackerState}' on ${id}`,
        evidence: {mid: d.mid, domState: d.cls, trackerState, user: id}
      };
    }
  }
  return {ok: true};
}

const COLLECT_DELIVERY_STATE = async() => {
  const chatAPI = (window as any).__nostraChatAPI;
  const tracker = chatAPI?.deliveryTracker;
  const states: Record<string, string> = tracker?.getAllStates
    ? tracker.getAllStates()
    : (tracker?.states ? Object.fromEntries(tracker.states) : {});
  // Tracker keys can be numeric mids OR compound app-ids like "chat-XXX-N"
  // (per CLAUDE.md). Only the numeric ones should be checked for
  // DOM/IDB coherence — compound ids are internal routing state.
  const trackerMids = Object.keys(states)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
  const domMids = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'))
    .map((b) => Number((b as HTMLElement).dataset.mid)).filter((n) => !Number.isNaN(n));
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
  } catch{ /* ignore */ }
  return {trackerMids, domMids, idbMids};
};

export const deliveryTrackerNoOrphans: Invariant = {
  id: 'INV-delivery-tracker-no-orphans',
  tier: 'medium',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const u: UserHandle = ctx.users[id];
      const snap = await u.page.evaluate(COLLECT_DELIVERY_STATE);
      const known = new Set<number>([...snap.domMids, ...snap.idbMids]);
      const orphans = snap.trackerMids.filter((m) => !known.has(m));
      if(orphans.length > 0) {
        return {ok: false, message: `deliveryTracker has orphan mids on ${id}: ${orphans.slice(0, 5).join(',')}`, evidence: {user: id, orphans}};
      }
    }
    return {ok: true};
  }
};
