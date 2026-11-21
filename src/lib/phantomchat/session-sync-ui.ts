import {i18n} from '@lib/langPack';
import {
  getChatSyncStatus, getGroupsSyncStatus, subscribeSessionSync
} from './session-sync-state';

// Background recovery may continue indefinitely while relays are unavailable.
// Spend one display budget per unsettled episode, not one per retry.
export const SYNC_PROGRESS_DELAY_MS = 4_000;
export const SYNC_PROGRESS_VISIBLE_MS = 10_000;

/** Transient progress only; failure/backoff is never labelled active syncing. */
export function mountSessionSyncStatus(host: HTMLElement, peer?: () => number): () => void {
  const slot = document.createElement('div');
  slot.className = `session-sync-status${peer ? ' session-sync-chat' : ''}`;
  slot.setAttribute('role', 'status');
  slot.setAttribute('aria-live', 'polite');
  const label = document.createElement('span');
  slot.append(label);
  host.prepend(slot);
  let identity: number;
  let started: number | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const render = () => {
    const nextIdentity = peer ? peer() : 0;
    if(identity !== nextIdentity) {
      identity = nextIdentity;
      started = undefined;
    }
    const status = peer ? getChatSyncStatus(identity) : getGroupsSyncStatus();
    clearTimeout(timer);
    if(status === 'ready') started = undefined;
    if(status === 'syncing') started ??= Date.now();
    const remaining = started === undefined ? 0 : SYNC_PROGRESS_VISIBLE_MS - (Date.now() - started);
    slot.dataset.state = status;
    const delay = started === undefined ? 0 : SYNC_PROGRESS_DELAY_MS - (Date.now() - started);
    slot.hidden = status !== 'syncing' || delay > 0 || remaining <= 0;
    if(status === 'syncing' && delay > 0) timer = setTimeout(render, delay);
    if(slot.hidden) label.replaceChildren();
    else {
      label.replaceChildren(i18n('SessionSync.Messages'));
      timer = setTimeout(render, remaining);
    }
  };
  const unsubscribe = subscribeSessionSync(render);
  return () => { clearTimeout(timer); unsubscribe(); slot.remove(); };
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
