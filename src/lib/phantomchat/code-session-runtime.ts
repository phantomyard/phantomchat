/**
 * code-session-runtime — live turn state for the Code rail (Working / Done /
 * Interrupted, and the elapsed counter).
 *
 * NOT SYNCED, deliberately. "This turn is running" and "you have not read the
 * answer yet" are facts about THIS device; publishing them would let one device
 * clear another's Done badge.
 *
 * Signals (both already exist in the app):
 *  - a send into a session's group chat starts the turn;
 *  - phantomchat's kind-20001 typing ticks land as `peer_typings` with the
 *    group's peer id — non-empty means Working, empty means the turn ended.
 *    tweb also auto-expires a typing entry after 6s, so a vanished phantom
 *    ends its turn without a stop marker.
 *  - a hard cap (`WORKING_HARD_TIMEOUT_MS`) ends a turn that never reports
 *    back, so a dead phantom cannot pin a row in Working forever.
 *
 * The pure transitions live in lib/code-mode (startTurn / applyTypingTick /
 * endTurn / markSessionRead); this module only wires them to storage, the
 * clock and the event bus.
 */

import {
  WORKING_HARD_TIMEOUT_MS,
  applyTypingTick,
  endTurn,
  isSessionWorking,
  markSessionRead,
  startTurn,
  type CodeSessionRuntime
} from '@lib/code-mode';
import {getAllSessionRuntime, setSessionRuntime} from './code-sessions-db';

const LOG_PREFIX = '[CodeSessionRuntime]';

/** How often the hard-cap sweeper runs. Cheap: it walks a small map. */
const SWEEP_INTERVAL_MS = 15_000;

export type RuntimeListener = (groupId: string) => void;

export class CodeSessionRuntimeTracker {
  private state: Record<string, CodeSessionRuntime> = {};
  private listeners = new Set<RuntimeListener>();

  /** group peer id → groupId, rebuilt from the session records by the caller. */
  private peerToGroup = new Map<number, string>();
  private openGroup?: string;

  /** groupIds with a persisted write in flight (coalesces activity churn). */
  private writing = new Set<string>();
  /** groupIds whose state moved again while a write was in flight. */
  private dirty = new Set<string>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    /** Injectable for tests so the transition logic needs no IndexedDB. */
    private readonly write: (groupId: string, runtime: CodeSessionRuntime | undefined) => Promise<void> = setSessionRuntime
  ) {}

  async hydrate(): Promise<void> {
    try {
      this.state = await getAllSessionRuntime();
    } catch(err) {
      console.warn(LOG_PREFIX, 'hydrate failed', err);
      this.state = {};
    }
  }

  /**
   * Register the sessions' group peer ids so typing ticks can be attributed.
   *
   * Callers pass the group's USER peer id (what `createGroup` hands back), but
   * the app reports activity — `peer_typings`, `message_sent` — against the
   * group's CHAT peer id (the negative form). Both are registered so either
   * spelling resolves to the session.
   */
  setSessionPeers(entries: Iterable<{groupId: string, peerId: number}>): void {
    this.peerToGroup.clear();
    for(const {groupId, peerId} of entries) {
      if(!groupId || !Number.isFinite(peerId)) continue;
      this.peerToGroup.set(peerId, groupId);

      const asChat = +(peerId as unknown as {toPeerId?: (chat: boolean) => number}).toPeerId?.(true);
      if(Number.isFinite(asChat) && asChat !== peerId) this.peerToGroup.set(asChat, groupId);
    }
  }

  get(groupId: string): CodeSessionRuntime | undefined {
    return this.state[groupId];
  }

  /** Which session owns a group peer id (0/unknown → undefined). */
  groupIdForPeer(peerId: number): string | undefined {
    return this.peerToGroup.get(peerId);
  }

  snapshot(): Record<string, CodeSessionRuntime> {
    return {...this.state};
  }

  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(groupId: string): void {
    for(const listener of this.listeners) {
      try {
        listener(groupId);
      } catch(err) {
        console.warn(LOG_PREFIX, 'listener threw', err);
      }
    }
  }

  private commit(groupId: string, runtime: CodeSessionRuntime | undefined): void {
    if(runtime) this.state[groupId] = runtime;
    else delete this.state[groupId];

    // Listeners hear EVERY transition: a typing tick must repaint the row even
    // while an earlier write is still in flight.
    this.emit(groupId);
    void this.persist(groupId);
  }

  /**
   * Write-behind persistence. A typing tick lands every ~2s, so the write is
   * coalesced per session: while one is in flight the state is marked dirty and
   * written again as soon as it settles, so the LAST transition always reaches
   * IndexedDB (a dropped final write would resurrect a stale Working row on the
   * next boot).
   */
  private async persist(groupId: string): Promise<void> {
    if(this.writing.has(groupId)) {
      this.dirty.add(groupId);
      return;
    }

    this.writing.add(groupId);
    try {
      do {
        this.dirty.delete(groupId);
        await this.write(groupId, this.state[groupId]);
      } while(this.dirty.has(groupId));
    } catch(err) {
      console.warn(LOG_PREFIX, 'persist failed', groupId, err);
    } finally {
      this.writing.delete(groupId);
    }
  }

  /** The user sent a prompt into this session. */
  markSent(groupId: string): void {
    this.commit(groupId, startTurn(this.state[groupId], this.now()));
  }

  /**
   * `peer_typings` for a group peer. Non-empty = the phantom is working;
   * empty = the turn ended (tweb expired the entry or a STOP marker arrived).
   */
  /**
   * Which session the user is LOOKING AT. A turn that ends while its row is
   * open is read by definition, so it must not paint a Done badge the user
   * then has to clear by re-opening the row they never left.
   */
  setOpenGroup(groupId: string | null | undefined): void {
    this.openGroup = groupId || undefined;
  }

  handleTypings(peerId: number, typingCount: number): void {
    const groupId = this.peerToGroup.get(peerId);
    if(!groupId) return;

    const runtime = this.state[groupId];
    const now = this.now();

    if(typingCount > 0) {
      this.commit(groupId, applyTypingTick(runtime, now));
      return;
    }

    // Only a turn that was actually running can END; a stray empty tick for an
    // idle session must not paint a Done badge.
    if(!runtime?.workingSince || !isSessionWorking(runtime, now)) return;
    this.commit(groupId, endTurn(runtime, 'done', now, {unread: groupId !== this.openGroup}));
  }

  /** Reading a session clears its Done/Interrupted badge. */
  markRead(groupId: string): void {
    const runtime = this.state[groupId];
    if(!runtime?.end && !runtime?.unread) return;
    this.commit(groupId, markSessionRead(runtime, this.now()));
  }

  /** Forget a session entirely (deleted). */
  forget(groupId: string): void {
    if(!this.state[groupId]) return;
    this.commit(groupId, undefined);
  }

  /**
   * End turns that blew the hard cap. Returns the groupIds that were
   * interrupted, so the caller can log/surface it.
   */
  sweep(): string[] {
    const now = this.now();
    const interrupted: string[] = [];

    for(const groupId of Object.keys(this.state)) {
      const runtime = this.state[groupId];
      const since = runtime?.workingSince || 0;
      if(!since) continue;
      if(now - since < WORKING_HARD_TIMEOUT_MS) continue;
      this.commit(groupId, endTurn(runtime, 'interrupted', now, {unread: false}));
      interrupted.push(groupId);
    }

    return interrupted;
  }
}

export const codeSessionRuntime = new CodeSessionRuntimeTracker();

/**
 * Wire the tracker to the app: typing ticks in, a sweeper out. Returns a
 * teardown for the caller (the inbox owns the lifecycle while mounted).
 */
export function attachRuntimeEvents(rootScope: {
  addEventListener: (event: any, listener: any) => void;
  removeEventListener: (event: any, listener: any) => void;
}, tracker: CodeSessionRuntimeTracker = codeSessionRuntime): () => void {
  const onTypings = (payload: {peerId?: number, typings?: unknown[]}) => {
    if(!payload || typeof payload.peerId !== 'number') return;
    tracker.handleTypings(payload.peerId, Array.isArray(payload.typings) ? payload.typings.length : 0);
  };

  rootScope.addEventListener('peer_typings' as any, onTypings);
  const timer = setInterval(() => {
    const interrupted = tracker.sweep();
    if(interrupted.length) {
      console.warn(LOG_PREFIX, 'interrupted (hard cap):', interrupted);
    }
  }, SWEEP_INTERVAL_MS);

  return () => {
    rootScope.removeEventListener('peer_typings' as any, onTypings);
    clearInterval(timer);
  };
}
