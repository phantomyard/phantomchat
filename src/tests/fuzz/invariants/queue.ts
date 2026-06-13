// @ts-nocheck
import type {Invariant, FuzzContext, InvariantResult, UserHandle} from '../types';

const COLLECT_QUEUE_LEN = async() => {
  const q = (window as any).__nostraChatAPI?.offlineQueue;
  const queueLen = q?.getQueueLength ? q.getQueueLength() : 0;
  return {queueLen};
};

export const offlineQueuePurged: Invariant = {
  id: 'INV-offline-queue-purged',
  tier: 'medium',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const u: UserHandle = ctx.users[id];
      const snap = await u.page.evaluate(COLLECT_QUEUE_LEN);
      if(snap.queueLen > 0) {
        return {ok: false, message: `offline queue not purged on ${id}: ${snap.queueLen} pending`, evidence: {user: id, queueLen: snap.queueLen}};
      }
    }
    return {ok: true};
  }
};
