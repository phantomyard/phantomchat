/** Main-thread freshness evidence. Cached history may paint while sending waits. */
export type SessionSyncStatus = 'syncing' | 'ready' | 'failed' | 'offline';
type Listener = () => void;
let enabled = false;
let generation = 0;
const cleanups = new Set<() => void>();

export function sessionSyncGeneration(): number { return generation; }
export function onSessionSyncCleanup(cleanup: () => void): void { cleanups.add(cleanup); }
let groups: SessionSyncStatus = 'syncing';
const chats = new Map<number, SessionSyncStatus>();
const staleChats = new Set<number>();
const staleGroups = new Set<number>();
const listeners = new Set<Listener>();
let retryGroups: (() => Promise<boolean>) | undefined;
let retryChat: ((peerId: number) => Promise<void>) | undefined;

export function refreshSessionSyncViews(): void {
  for(const listener of listeners) listener();
}

export function enableSessionSync(retry: () => Promise<boolean>): void {
  resetSessionSync();
  enabled = true;
  groups = typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'syncing';
  chats.clear();
  retryGroups = retry;
  refreshSessionSyncViews();
}

export function setGroupsSyncStatus(status: SessionSyncStatus): void {
  groups = status;
  if(status === 'ready') staleGroups.clear();
  refreshSessionSyncViews();
}

export function getGroupsSyncStatus(): SessionSyncStatus {
  return enabled ? groups : 'ready';
}

export function setChatSyncStatus(peerId: number, status: SessionSyncStatus): void {
  chats.set(peerId, status);
  if(status === 'ready') staleChats.delete(peerId);
  refreshSessionSyncViews();
}

export function getChatSyncStatus(peerId: number): SessionSyncStatus {
  if(!enabled || !peerId) return 'ready';
  if(staleGroups.has(peerId) && groups !== 'ready') return groups;
  const chat = chats.get(peerId) ?? 'ready';
  if(chat !== 'ready') return chat;
  return peerId < 0 ? groups : chat;
}

export function subscribeSessionSync(listener: Listener): () => void {
  listeners.add(listener);
  listener();
  return () => listeners.delete(listener);
}

export function registerChatSyncRetry(retry: (peerId: number) => Promise<void>): void {
  retryChat = retry;
}

export function retrySessionSync(peerId?: number): void {
  if(peerId) void retryChat?.(peerId);
  else void retryGroups?.();
}

export function markChatSyncStale(peerId: number): void {
  staleChats.add(peerId);
  setChatSyncStatus(peerId, 'syncing');
}

export function markGroupsSyncStale(peerIds: Iterable<number>): void {
  for(const peerId of peerIds) staleGroups.add(peerId);
  setGroupsSyncStatus('syncing');
}

export function reconcileSessionGroups(): Promise<boolean> {
  return retryGroups?.() ?? Promise.resolve(false);
}

export function isChatSyncTracked(peerId: number): boolean { return chats.has(peerId); }

export function canSendToSyncedChat(peerId: number): boolean {
  if(!enabled || !peerId) return true;
  if(staleChats.has(peerId) || staleGroups.has(peerId)) return false;
  // A failed/offline query is not evidence of a remote change. Keep the
  // existing send/queue path available with explicit cached-data feedback.
  return chats.get(peerId) !== 'syncing';
}

export function resetSessionSync(): void {
  generation++;
  staleGroups.clear();
  staleChats.clear();
  for(const cleanup of cleanups) cleanup();
  cleanups.clear();
  enabled = false;
  groups = 'syncing';
  chats.clear();
  retryGroups = undefined;
  retryChat = undefined;
  refreshSessionSyncViews();
}

/** Single-flight, including a trailing pass when a nudge arrives mid-query. */
export function createGroupsReconciler(run: () => Promise<boolean>): () => Promise<boolean> {
  let flight: Promise<boolean> | undefined;
  let again = false;
  return () => {
    if(flight) {
      again = true;
      return flight;
    }
    const epoch = generation;
    if(typeof navigator !== 'undefined' && navigator.onLine === false) {
      setGroupsSyncStatus('offline');
      return Promise.resolve(false);
    }
    setGroupsSyncStatus('syncing');
    const feedback = setTimeout(() => {
      if(epoch === generation) setGroupsSyncStatus('failed');
    }, 30_000);
    flight = (async() => {
      let ok = false;
      try {
        do {
          again = false;
          ok = false;
          ok = await run();
        } while(again);
      } catch(error) {
        console.warn('[session-sync] groups reconcile failed', error);
      } finally {
        clearTimeout(feedback);
        flight = undefined;
        if(epoch === generation) setGroupsSyncStatus(ok ? 'ready' :
          typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'failed');
      }
      return ok;
    })();
    return flight;
  };
}
