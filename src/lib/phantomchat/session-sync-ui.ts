import {i18n} from '@lib/langPack';
import {
  getChatSyncStatus, getGroupsSyncStatus, subscribeSessionSync
} from './session-sync-state';

/** Transient progress/error feedback; settled views keep their normal layout. */
export function mountSessionSyncStatus(host: HTMLElement, peer?: () => number): () => void {
  const slot = document.createElement('div');
  slot.className = `session-sync-status${peer ? ' session-sync-chat' : ''}`;
  slot.setAttribute('role', 'status');
  slot.setAttribute('aria-live', 'polite');
  const label = document.createElement('span');
  slot.append(label);
  host.prepend(slot);
  let previous: string;
  const unsubscribe = subscribeSessionSync(() => {
    const status = peer ? getChatSyncStatus(peer()) : getGroupsSyncStatus();
    const identity = status;
    if(identity === previous) return;
    previous = identity;
    slot.dataset.state = status;
    slot.hidden = status === 'ready' || status === 'offline';
    if(slot.hidden) label.replaceChildren();
    else label.replaceChildren(i18n('SessionSync.Messages'));
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
  const reveal = () => {
    if(!snapshot.parentNode) return;
    snapshot.remove();
    live.style.visibility = '';
    delete live.dataset.syncApplying;
    live.removeAttribute('aria-busy');
  };
  // A stuck persistence/worker call must never leave the live list inaccessible.
  const safety = setTimeout(reveal, 30_000);
  try {
    return await apply();
  } finally {
    clearTimeout(safety);
    reveal();
  }
}
