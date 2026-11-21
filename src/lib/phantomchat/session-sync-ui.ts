import {i18n} from '@lib/langPack';
import {
  getChatSyncStatus, getGroupsSyncStatus, retrySessionSync, subscribeSessionSync
} from './session-sync-state';
import type {SessionSyncStatus} from './session-sync-state';

/** Persistent status slot avoids moving the composer or sidebar as it settles. */
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
  let previous: SessionSyncStatus;
  const unsubscribe = subscribeSessionSync(() => {
    const status = peer ? getChatSyncStatus(peer()) : getGroupsSyncStatus();
    if(status === previous) return;
    previous = status;
    slot.dataset.state = status;
    label.replaceChildren(i18n(status === 'syncing' ?
      peer ? 'SessionSync.Messages' : 'SessionSync.Sessions' :
      status === 'offline' ? 'SessionSync.Offline' :
      status === 'failed' ? 'SessionSync.Failed' : 'SessionSync.Ready'));
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
