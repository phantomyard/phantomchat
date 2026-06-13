/**
 * nostra-pending-flush.ts
 *
 * Manages a queue of pending incoming messages for peers whose chat
 * is not yet open. When the chat opens (peer_changed), flushes them
 * via history_append + direct bubble injection fallback.
 * Extracted from nostra-onboarding-integration.ts for testability.
 */

import {MOUNT_CLASS_TO} from '@config/debug';
import rootScope from '@lib/rootScope';

export interface PendingFlushManager {
  /** Enqueue a message for a peer */
  enqueue(peerId: number, msg: any): void;
  /** Flush pending messages for a peer */
  flush(peerId: number): void;
  /** Attach peer_changed listener on appImManager */
  attachListener(onPeerOpened?: (peerId: number) => void): void;
  /** Start periodic flush interval (1s) */
  startPeriodicFlush(): void;
  /** Get pending count for a peer (for testing) */
  getPendingCount(peerId: number): number;
  /** Stop periodic flush and cleanup */
  destroy(): void;
}

export function createPendingFlush(): PendingFlushManager {
  const pendingMessages = new Map<number, any[]>();
  const flushedForChat = new WeakSet<object>();
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const flushedMids = new Set<string>();

  const flush = (numericPeerId: number) => {
    const pending = pendingMessages.get(numericPeerId);
    if(!pending?.length) return;

    for(const msg of pending) {
      const mid = msg.mid || msg.id;
      const dedupKey = `${numericPeerId}_${mid}`;

      // Skip if this mid was already flushed (prevents duplicate bubbles
      // from the retry delays in attachListener)
      if(flushedMids.has(dedupKey)) continue;
      flushedMids.add(dedupKey);

      // dispatch history_append for real-time bubble rendering
      try {
        rootScope.dispatchEvent('history_append' as any, {
          storageKey: `${numericPeerId}_history`,
          message: msg,
          peerId: numericPeerId
        });
      } catch(e: any) { console.debug('[PendingFlush]', e?.message); }
    }

    // Clear pending only if chat is active for this peer
    const im = MOUNT_CLASS_TO.appImManager;
    if(im?.chat && +(im.chat as any).peerId === numericPeerId) {
      pendingMessages.delete(numericPeerId);
    }
  };

  const attachListener = (onPeerOpened?: (peerId: number) => void) => {
    const tryAttach = () => {
      const im = MOUNT_CLASS_TO.appImManager;
      if(!im?.addEventListener) {
        setTimeout(tryAttach, 1000);
        return;
      }
      im.addEventListener('peer_changed', (chat: any) => {
        const peerId = chat?.peerId;
        if(!peerId) return;
        const numId = typeof peerId === 'number' ? peerId : +peerId;
        // Retry flush with increasing delays — bubbles.ts needs loadedAll.bottom=true
        for(const delay of [500, 2000, 5000]) {
          setTimeout(() => flush(numId), delay);
        }
        if(onPeerOpened) {
          setTimeout(() => onPeerOpened(numId), 800);
        }
      });
    };
    tryAttach();
  };

  const startPeriodicFlush = () => {
    intervalId = setInterval(() => {
      if(!pendingMessages.size) return;
      try {
        const im = MOUNT_CLASS_TO.appImManager;
        const currentPeerId = im?.chat?.peerId;
        if(!currentPeerId) return;
        const currentStr = '' + currentPeerId;
        for(const [key] of pendingMessages) {
          if('' + key === currentStr) {
            flush(key);
            break;
          }
        }
      } catch(e: any) { console.debug('[PendingFlush] periodic:', e?.message); }
    }, 1000);
  };

  return {
    enqueue(peerId: number, msg: any) {
      if(!pendingMessages.has(peerId)) pendingMessages.set(peerId, []);
      pendingMessages.get(peerId)!.push(msg);
    },
    flush,
    attachListener,
    startPeriodicFlush,
    getPendingCount(peerId: number) {
      return pendingMessages.get(peerId)?.length ?? 0;
    },
    destroy() {
      if(intervalId) clearInterval(intervalId);
      pendingMessages.clear();
    }
  };
}
