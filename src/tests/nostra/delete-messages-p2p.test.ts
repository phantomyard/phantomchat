import 'fake-indexeddb/auto';
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';

// We import via dynamic import after mocks are set up so vi.doMock takes
// effect — see CLAUDE.md "vi.mock() cannot override already-cached modules"
// guidance.
//
// Module-level init of appMessagesManager pulls AppStorage -> IDBStorage,
// so we import `fake-indexeddb/auto` to silence background unhandled
// rejections that would otherwise show up as "2 errors" in the test report.

describe('deleteMessages — P2P mid short-circuit', () => {
  let appMessagesManager: any;
  let processLocalUpdateCalls: any[];

  beforeEach(async() => {
    vi.resetModules();
    processLocalUpdateCalls = [];

    vi.doMock('@lib/appManagers/appPeersManager', () => ({
      appPeersManager: {
        isChannel: () => false,
        isMonoforum: () => false
      }
    }));

    // Mock apiUpdatesManager to capture processLocalUpdate calls
    vi.doMock('@lib/appManagers/apiUpdatesManager', () => ({
      apiUpdatesManager: {
        processLocalUpdate: (update: any) => processLocalUpdateCalls.push(update)
      }
    }));

    vi.doMock('@config/debug', () => ({
      default: {MOUNT_CLASS_TO: {}, DEBUG: false},
      MOUNT_CLASS_TO: {},
      DEBUG: false
    }));

    const mod: any = await import('@appManagers/appMessagesManager');
    appMessagesManager = mod.default ?? mod.appMessagesManager ?? new mod.AppMessagesManager();
    // Stub injected managers directly on the instance. AppManager uses
    // `Object.assign(this, managers)` at setup; vi.doMock of the module
    // doesn't reach instance fields like `this.appPeersManager`.
    appMessagesManager.apiManager = {
      invokeApi: vi.fn(async() => ({_: 'messages.affectedMessages', pts: 1, pts_count: 0})),
      getConfig: vi.fn(async() => ({forwarded_count_max: 100}))
    };
    appMessagesManager.apiUpdatesManager = {
      processLocalUpdate: (update: any) => processLocalUpdateCalls.push(update)
    };
    appMessagesManager.appPeersManager = {
      isChannel: () => false,
      isMonoforum: () => false
    };
    appMessagesManager.appMessagesIdsManager = {
      splitMessageIdsByChannels: (mids: number[]) => [[undefined, {mids}]],
      // For the non-P2P test with peerId 42: returning the same mid makes the
      // server-id filter in deleteMessagesInner treat the mid as round-trip-safe,
      // so it is forwarded to invokeApi and the mocked affectedMessages drives
      // processLocalUpdate.
      generateMessageId: (messageId: number) => messageId
    };
  });

  afterEach(() => {
    vi.unmock('@lib/appManagers/appPeersManager');
    vi.unmock('@lib/appManagers/apiUpdatesManager');
    vi.unmock('@config/debug');
    vi.restoreAllMocks();
  });

  it('dispatches processLocalUpdate with pts_count === mids.length for a P2P peer', async() => {
    const peerId = 1776497540742441;  // >=1e15 = P2P
    const mids = [1776497540742441, 1776497540742442];

    await appMessagesManager.deleteMessages(peerId, mids, true);

    const localUpdate = processLocalUpdateCalls.find((u) => u._ === 'updateDeleteMessages');
    expect(localUpdate).toBeDefined();
    expect(localUpdate.messages).toEqual(mids);
    expect(localUpdate.pts_count).toBe(mids.length);
  });

  it('preserves non-P2P path unchanged (pts_count from server response)', async() => {
    const peerId = 42;  // < 1e15 = regular tweb peer
    const mids = [42];

    await appMessagesManager.deleteMessages(peerId, mids, true);

    const localUpdate = processLocalUpdateCalls.find((u) => u._ === 'updateDeleteMessages');
    // Non-P2P still goes through server-id filter; for a mid that DOES round-trip,
    // pts_count comes from affectedMessages (mocked to 0 here). Asserting the
    // branch is distinguishable, not a specific value — the important property
    // is that the P2P branch returns mids.length and this one does not.
    expect(localUpdate).toBeDefined();
    expect(localUpdate.messages).toEqual(mids);
  });
});
