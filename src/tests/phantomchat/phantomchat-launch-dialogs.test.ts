/**
 * Launch dialog hygiene: one-shot preview refresh, desktop-only top-chat open,
 * and chat-open relay catch-up wiring.
 */

import '../setup';
import {describe, it, expect, vi} from 'vitest';
import {
  refreshDialogPreviews,
  openTopChatOnDesktop,
  onChatOpenedCatchUp,
  isChatDeepLink,
  installLaunchDialogs,
  wirePreviewRefreshReruns
} from '@lib/phantomchat/phantomchat-launch-dialogs';

const noSleep = () => Promise.resolve();

describe('refreshDialogPreviews', () => {
  it('reloads every cached dialog once, groups included, de-duplicated', async() => {
    const reloadConversation = vi.fn().mockResolvedValue(undefined);
    const n = await refreshDialogPreviews({
      getDialogs: async() => [{peerId: 11}, {peerId: -22}, {peerId: 11}, {peerId: 0}],
      reloadConversation
    });
    expect(n).toBe(2);
    expect(reloadConversation.mock.calls.map((c) => c[0])).toEqual([11, -22]);
  });

  it('one failing reload does not stop the others or throw', async() => {
    const reloadConversation = vi.fn((peerId: number) => {
      if(peerId === 1) throw new Error('sync boom');
      if(peerId === 2) return Promise.reject(new Error('async boom'));
      return Promise.resolve();
    });
    await expect(refreshDialogPreviews({
      getDialogs: async() => [{peerId: 1}, {peerId: 2}, {peerId: 3}],
      reloadConversation
    })).resolves.toBe(3);
    expect(reloadConversation).toHaveBeenCalledTimes(3);
  });

  it('a failed dialog read is a no-op', async() => {
    const reloadConversation = vi.fn();
    await expect(refreshDialogPreviews({
      getDialogs: () => Promise.reject(new Error('worker down')),
      reloadConversation
    })).resolves.toBe(0);
    expect(reloadConversation).not.toHaveBeenCalled();
  });
});

describe('openTopChatOnDesktop', () => {
  const base = () => ({
    getDialogs: vi.fn(async() => [{peerId: 101}, {peerId: 202}]),
    isMobile: vi.fn(() => false),
    currentPeerId: vi.fn((): number | undefined => undefined),
    launchedWithDeepLink: false,
    openPeer: vi.fn(),
    sleep: noSleep
  });

  it('opens the first dialog on desktop', async() => {
    const deps = base();
    expect(await openTopChatOnDesktop(deps)).toBe(101);
    expect(deps.openPeer).toHaveBeenCalledWith(101);
  });

  it('never opens on mobile', async() => {
    const deps = {...base(), isMobile: () => true};
    expect(await openTopChatOnDesktop(deps)).toBeNull();
    expect(deps.getDialogs).not.toHaveBeenCalled();
    expect(deps.openPeer).not.toHaveBeenCalled();
  });

  it('never overrides a chat the user already opened', async() => {
    const deps = {...base(), currentPeerId: () => 555};
    expect(await openTopChatOnDesktop(deps)).toBeNull();
    expect(deps.openPeer).not.toHaveBeenCalled();
  });

  it('never overrides a deep link', async() => {
    const deps = {...base(), launchedWithDeepLink: true};
    expect(await openTopChatOnDesktop(deps)).toBeNull();
    expect(deps.getDialogs).not.toHaveBeenCalled();
    expect(deps.openPeer).not.toHaveBeenCalled();
  });

  it('waits for a first-ever dialog list, then opens its top chat', async() => {
    const deps = base();
    deps.getDialogs
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([]);
    expect(await openTopChatOnDesktop({...deps, attempts: 5})).toBe(101);
    expect(deps.getDialogs).toHaveBeenCalledTimes(3);
  });

  it('gives up quietly when no dialogs ever arrive', async() => {
    const deps = {...base(), getDialogs: vi.fn(async() => [] as {peerId: number}[])};
    expect(await openTopChatOnDesktop({...deps, attempts: 3})).toBeNull();
    expect(deps.getDialogs).toHaveBeenCalledTimes(3);
    expect(deps.openPeer).not.toHaveBeenCalled();
  });

  it('a chat picked while it was waiting wins', async() => {
    let picked: number | undefined;
    const deps = base();
    deps.getDialogs.mockImplementationOnce(async() => {
      picked = 999; // user clicks a chat while the list read is in flight
      return [{peerId: 101}];
    });
    const r = await openTopChatOnDesktop({...deps, currentPeerId: () => picked});
    expect(r).toBeNull();
    expect(deps.openPeer).not.toHaveBeenCalled();
  });
});

describe('onChatOpenedCatchUp', () => {
  it('catches up a 1:1 chat by its pubkey', async() => {
    const catchUp = vi.fn().mockResolvedValue('ran');
    const resolvePubkey = vi.fn().mockResolvedValue('ab'.repeat(32));
    expect(await onChatOpenedCatchUp({peerId: 42}, {resolvePubkey, catchUp})).toBe('ran');
    expect(resolvePubkey).toHaveBeenCalledWith(42);
    expect(catchUp).toHaveBeenCalledWith('ab'.repeat(32));
  });

  it('accepts a bare numeric payload', async() => {
    const catchUp = vi.fn().mockResolvedValue('skipped');
    await onChatOpenedCatchUp(42, {resolvePubkey: async() => 'pk', catchUp});
    expect(catchUp).toHaveBeenCalledWith('pk');
  });

  it('ignores groups, closed chats and unknown peers', async() => {
    const catchUp = vi.fn();
    // Even a group whose id would resolve to a pubkey is never caught up here.
    expect(await onChatOpenedCatchUp({peerId: -5}, {resolvePubkey: async() => 'pk', catchUp})).toBeNull();
    const resolvePubkey = vi.fn().mockResolvedValue(null);
    expect(await onChatOpenedCatchUp({peerId: 0}, {resolvePubkey, catchUp})).toBeNull();
    expect(await onChatOpenedCatchUp(undefined, {resolvePubkey, catchUp})).toBeNull();
    expect(await onChatOpenedCatchUp({peerId: 7}, {resolvePubkey, catchUp})).toBeNull();
    expect(catchUp).not.toHaveBeenCalled();
  });

  it('swallows lookup failures', async() => {
    await expect(onChatOpenedCatchUp({peerId: 7}, {
      resolvePubkey: () => Promise.reject(new Error('idb')),
      catchUp: vi.fn()
    })).resolves.toBeNull();
  });
});

describe('isChatDeepLink', () => {
  it('treats empty / root hashes as no deep link', () => {
    for(const h of ['', '#', '#/im', '#/', undefined, null]) expect(isChatDeepLink(h as any)).toBe(false);
  });

  it('treats a chat-targeting hash as a deep link', () => {
    for(const h of ['#@alice', '#1234567890123456', '#?tgaddr=tg%3A%2F%2Fresolve', '#/im?p=123']) {
      expect(isChatDeepLink(h)).toBe(true);
    }
  });
});

describe('installLaunchDialogs wiring', () => {
  it('hooks peer_changed to the ChatAPI catch-up and runs both launch passes', async() => {
    const listeners: Record<string, (p: unknown) => void> = {};
    const appImManager = {
      addEventListener: vi.fn((ev: string, cb: any) => { listeners[ev] = cb; }),
      setInnerPeer: vi.fn(),
      chat: undefined as any
    };
    const reloadConversation = vi.fn().mockResolvedValue(undefined);
    const rootScope = {managers: {
      dialogsStorage: {getFolderDialogs: vi.fn().mockResolvedValue([{peerId: 77}])},
      appMessagesManager: {reloadConversation}
    }};
    const chatAPI = {catchUpConversation: vi.fn().mockResolvedValue('ran')};

    installLaunchDialogs({rootScope, appImManager, chatAPI, launchedWithDeepLink: false, isMobile: () => false});

    await vi.waitFor(() => expect(reloadConversation).toHaveBeenCalledWith(77));
    await vi.waitFor(() => expect(appImManager.setInnerPeer).toHaveBeenCalledWith({peerId: 77}));
    expect(rootScope.managers.dialogsStorage.getFolderDialogs).toHaveBeenCalledWith(0);
    // Groups (3) too — Chats (0) excludes group chats, so folder 0 alone would
    // leave every group's preview unrefreshed.
    expect(rootScope.managers.dialogsStorage.getFolderDialogs).toHaveBeenCalledWith(3);
    expect(listeners.peer_changed).toBeTypeOf('function');
  });

  it('re-runs the preview refresh when the backfill pass completes (cold-profile convergence)', async() => {
    const listeners: Record<string, (p: unknown) => void> = {};
    const appImManager = {
      addEventListener: vi.fn((ev: string, cb: any) => { listeners[ev] = cb; }),
      setInnerPeer: vi.fn(),
      chat: undefined as any
    };
    const reloadConversation = vi.fn().mockResolvedValue(undefined);
    const rootScope = {
      managers: {
        dialogsStorage: {getFolderDialogs: vi.fn().mockResolvedValue([{peerId: 77}])},
        appMessagesManager: {reloadConversation}
      },
      addEventListener: vi.fn((ev: string, cb: any) => { listeners[ev] = cb; })
    };
    const chatAPI = {catchUpConversation: vi.fn().mockResolvedValue('ran')};

    installLaunchDialogs({rootScope, appImManager, chatAPI, launchedWithDeepLink: false, isMobile: () => false});

    // Boot refresh ran once.
    await vi.waitFor(() => expect(reloadConversation).toHaveBeenCalledTimes(1));
    expect(listeners.phantomchat_backfill_complete).toBeTypeOf('function');

    // The backfill completing re-runs the refresh against the now-filled store.
    listeners.phantomchat_backfill_complete!(undefined);
    await vi.waitFor(() => expect(reloadConversation).toHaveBeenCalledTimes(2));
  });

  it('survives a rootScope without addEventListener (test stubs)', () => {
    const appImManager = {
      addEventListener: vi.fn(),
      setInnerPeer: vi.fn(),
      chat: undefined as any
    };
    const reloadConversation = vi.fn().mockResolvedValue(undefined);
    expect(() => installLaunchDialogs({
      rootScope: {managers: {
        dialogsStorage: {getFolderDialogs: vi.fn().mockResolvedValue([])},
        appMessagesManager: {reloadConversation}
      }},
      appImManager,
      chatAPI: {catchUpConversation: vi.fn().mockResolvedValue('ran')},
      launchedWithDeepLink: false,
      isMobile: () => false
    })).not.toThrow();
  });
});

describe('wirePreviewRefreshReruns', () => {
  it('runs on the injected schedule, bounded', async() => {
    const scheduled: Array<{fn: () => void; ms: number}> = [];
    const run = vi.fn().mockResolvedValue(3);
    wirePreviewRefreshReruns({
      run,
      schedule: (fn, ms) => scheduled.push({fn, ms}),
      delaysMs: [100, 200]
    });
    // Wiring alone runs nothing — the install-time run is previewsReady's.
    expect(run).toHaveBeenCalledTimes(0);
    expect(scheduled.map((s) => s.ms)).toEqual([100, 200]);

    scheduled[0].fn();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    scheduled[1].fn();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    // No further scheduled runs exist — the schedule is bounded.
    expect(scheduled).toHaveLength(2);
  });

  it('coalesces overlapping requests into one trailing run', async() => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const run = vi.fn().mockImplementation(() => gate.then(() => 1));
    const scheduled: Array<{fn: () => void; ms: number}> = [];
    const backfillCbs: Array<() => void> = [];
    wirePreviewRefreshReruns({
      run,
      schedule: (fn, ms) => scheduled.push({fn, ms}),
      delaysMs: [100],
      onBackfillComplete: (fn) => { backfillCbs.push(fn); }
    });

    expect(run).toHaveBeenCalledTimes(0); // wiring alone runs nothing

    scheduled[0].fn();  // first run starts, gated mid-flight
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    backfillCbs[0]!();  // event fires while the run is in flight
    backfillCbs[0]!();  // and again — must collapse

    release();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });

  it('a drain-progress row after the last fixed timer still re-runs', async() => {
    // #234 review: the fixed timers can expire before a deep drain reaches the
    // newest message of a quieter conversation. Progress must come from the
    // pool's per-page event, not from the bounded schedule.
    const scheduled: Array<{fn: () => void; ms: number}> = [];
    const run = vi.fn().mockResolvedValue(1);
    const progressCbs: Array<() => void> = [];
    wirePreviewRefreshReruns({
      run,
      schedule: (fn, ms) => scheduled.push({fn, ms}),
      delaysMs: [100, 200],
      onBackfillProgress: (fn) => { progressCbs.push(fn); }
    });

    scheduled[0].fn();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    scheduled[1].fn();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(scheduled).toHaveLength(2); // schedule exhausted

    // The next drain page lands AFTER the last timer: the event drives it.
    progressCbs[0]!();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
  });

  it('coalesces overlapping progress events into one trailing run', async() => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const run = vi.fn().mockImplementation(() => gate.then(() => 1));
    const progressCbs: Array<() => void> = [];
    wirePreviewRefreshReruns({
      run,
      schedule: () => {},
      delaysMs: [],
      onBackfillProgress: (fn) => { progressCbs.push(fn); }
    });

    expect(run).toHaveBeenCalledTimes(0); // wiring alone runs nothing

    progressCbs[0]!(); // run starts, gated mid-flight
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    progressCbs[0]!(); // page lands while the run is in flight
    progressCbs[0]!(); // and again — must collapse

    release();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });

  it('a failing re-run does not break later ones', async() => {
    const scheduled: Array<{fn: () => void; ms: number}> = [];
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(2);
    wirePreviewRefreshReruns({
      run,
      schedule: (fn, ms) => scheduled.push({fn, ms}),
      delaysMs: [100, 200]
    });

    scheduled[0].fn();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    scheduled[1].fn();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });
});
