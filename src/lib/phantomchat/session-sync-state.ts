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
const verifiedChats = new Set<number>();
let verifiedGroups = false;
const listeners = new Set<Listener>();
let retryGroups: (() => Promise<boolean>) | undefined;
let retryChat: ((peerId: number) => Promise<void>) | undefined;

export function refreshSessionSyncViews(): void {
  for(const listener of listeners) listener();
}

export function enableSessionSync(retry: () => Promise<boolean>): void {
  resetSessionSync();
  enabled = true;
  groups = 'syncing';
  chats.clear();
  retryGroups = retry;
  refreshSessionSyncViews();
}

export function setGroupsSyncStatus(status: SessionSyncStatus): void {
  groups = status;
  if(status === 'ready') verifiedGroups = true;
  refreshSessionSyncViews();
}

export function getGroupsSyncStatus(): SessionSyncStatus {
  return enabled ? groups : 'ready';
}

export function setChatSyncStatus(peerId: number, status: SessionSyncStatus): void {
  chats.set(peerId, status);
  if(status === 'ready') verifiedChats.add(peerId);
  refreshSessionSyncViews();
}

export function getChatSyncStatus(peerId: number): SessionSyncStatus {
  if(!enabled || !peerId) return 'ready';
  if(peerId < 0 && groups !== 'ready') return groups;
  return chats.get(peerId) ?? 'ready';
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
  verifiedChats.delete(peerId);
  setChatSyncStatus(peerId, 'syncing');
}

export function markGroupsSyncStale(): void {
  verifiedGroups = false;
  setGroupsSyncStatus('syncing');
}

export function reconcileSessionGroups(): Promise<boolean> {
  return retryGroups?.() ?? Promise.resolve(false);
}

export function isChatSyncTracked(peerId: number): boolean { return chats.has(peerId); }

export function canSendToSyncedChat(peerId: number): boolean {
  const status = getChatSyncStatus(peerId);
  if(chats.get(peerId) === 'syncing') return false;
  if(status === 'ready') return true;
  // Preserve existing offline queueing only after this running client proved
  // the chat current. A cold cached thread or a known remote change cannot
  // inherit that permission from a prior session or failed query.
  return (status === 'offline' || status === 'failed') && verifiedChats.has(peerId) &&
    (peerId > 0 || verifiedGroups);
}

export function resetSessionSync(): void {
  generation++;
  verifiedGroups = false;
  verifiedChats.clear();
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
    setGroupsSyncStatus('syncing');
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
        flight = undefined;
        if(epoch === generation) setGroupsSyncStatus(ok ? 'ready' :
          typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'failed');
      }
      return ok;
    })();
    return flight;
  };
}
