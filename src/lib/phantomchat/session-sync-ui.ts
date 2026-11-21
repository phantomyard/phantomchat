import {i18n} from '@lib/langPack';
import {
  getChatSyncStatus, getGroupsSyncStatus, retrySessionSync, subscribeSessionSync, canSendToSyncedChat
} from './session-sync-state';

/** Transient progress/error feedback; settled views keep their normal layout. */
export function mountSessionSyncStatus(host: HTMLElement, peer?: () => number): () => void {
  const slot = document.createElement('div');
  slot.className = 'session-sync-status';
  slot.setAttribute('role', 'status');
  slot.setAttribute('aria-live', 'polite');
  const label = document.createElement('span');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.append(i18n('SessionSync.Retry'));
  retry.addEventListener('click', () => retrySessionSync(peer?.()));
  slot.append(label, retry);
  host.prepend(slot);
  let previous: string;
  const unsubscribe = subscribeSessionSync(() => {
    const status = peer ? getChatSyncStatus(peer()) : getGroupsSyncStatus();
    const canQueue = !!peer && canSendToSyncedChat(peer());
    const identity = `${status}:${canQueue}`;
    if(identity === previous) return;
    previous = identity;
    slot.dataset.state = status;
    slot.hidden = status === 'ready';
    if(status === 'ready') label.replaceChildren();
    else label.replaceChildren(i18n(status === 'syncing' ?
      peer ? 'SessionSync.Messages' : 'SessionSync.Sessions' :
      status === 'offline' ? canQueue ? 'SessionSync.OfflineQueue' : 'SessionSync.Offline' :
      canQueue ? 'SessionSync.FailedQueue' : 'SessionSync.Failed'));
    retry.hidden = status !== 'failed' && status !== 'offline';
  });
  return () => { unsubscribe(); slot.remove(); };
}

/** Keep the visible cached list still while a remote delta is materialised.
 * The live DOM keeps all listeners; the inert snapshot is removed in finally.
 */
export async function withStableSessionList<T>(apply: () => Promise<T>): Promise<T> {
  const live = document.getElementById('folders-container');
  if(!live || live.dataset.syncApplying) return apply();
  const snapshot = live.cloneNode(true) as HTMLElement;
  snapshot.removeAttribute('id');
  snapshot.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
  snapshot.setAttribute('aria-hidden', 'true');
  snapshot.inert = true;
  snapshot.classList.add('session-sync-snapshot');
  snapshot.style.height = `${live.getBoundingClientRect().height}px`;
  live.dataset.syncApplying = 'true';
  live.setAttribute('aria-busy', 'true');
  live.before(snapshot);
  const sourceScrollers = live.querySelectorAll('.scrollable');
  snapshot.querySelectorAll('.scrollable').forEach((node, index) => { node.scrollTop = sourceScrollers[index]?.scrollTop ?? 0; });
  live.style.visibility = 'hidden';
  try {
    return await apply();
  } finally {
    snapshot.remove();
    live.style.visibility = '';
    delete live.dataset.syncApplying;
    live.removeAttribute('aria-busy');
  }
}
