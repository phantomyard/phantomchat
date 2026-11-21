import {createSyncRecovery} from './session-sync-recovery';

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

/** Clear only metadata deltas that this catalog pass actually applied. */
export function settleGroupsSyncPeers(peerIds: Iterable<number>): void {
  for(const peerId of peerIds) staleGroups.delete(peerId);
  refreshSessionSyncViews();
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
  return true;
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

/** Single-flight metadata recovery, including a trailing pass for live nudges. */
export function createGroupsReconciler(run: (signal: AbortSignal, force: boolean) => Promise<boolean>): () => Promise<boolean> {
  let epoch: number;
  const recover = createSyncRecovery({
    run,
    status: setGroupsSyncStatus,
    current: () => epoch === undefined || epoch === generation,
    cleanup: onSessionSyncCleanup
  });
  return () => {
    epoch ??= generation;
    return recover();
  };
}
