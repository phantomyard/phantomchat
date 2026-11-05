/**
 * The sync-nudge receive gate (chat-api-receive.ts step 0c) decides which
 * rumors may make this client reconcile. Every rumor with the nudge tag is
 * dropped as a non-message; only a fresh nudge from my own pubkey, sent by a
 * DIFFERENT device of mine, calls handleSyncNudge.
 */
import '../setup';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const handleSyncNudge = vi.fn();
vi.mock('@lib/phantomchat/phantomchat-sync-triggers', () => ({handleSyncNudge}));

const ME = 'a'.repeat(64);
const STRANGER = 'b'.repeat(64);
const SIBLING_DEVICE = 'sibling-device-1';

function ctx() {
  const log: any = vi.fn();
  log.warn = vi.fn();
  log.error = vi.fn();
  return {ownId: ME, history: [] as any[], activePeer: null as string | null, deliveryTracker: null as null, offlineQueue: null as null, onMessage: vi.fn(), onEdit: vi.fn(), log};
}

async function nudge(from: string, opts: {deviceId?: string, ageSeconds?: number} = {}) {
  const {syncNudgeTags, syncNudgeContent} = await import('@lib/phantomchat/sync-nudge');
  return {
    id: 'e'.repeat(64),
    from,
    content: syncNudgeContent('contacts', opts.deviceId ?? SIBLING_DEVICE),
    timestamp: Math.floor(Date.now() / 1000) - (opts.ageSeconds ?? 0),
    tags: syncNudgeTags(ME, 'contacts')
  } as any;
}

describe('sync nudge on the receive path', () => {
  beforeEach(() => handleSyncNudge.mockClear());

  it('a fresh nudge from a sibling device of mine reconciles once', async() => {
    const {handleRelayMessage} = await import('@lib/phantomchat/chat-api-receive');
    const c = ctx();
    const res = await handleRelayMessage(await nudge(ME), c);
    expect(res).toEqual({action: 'skipped', reason: 'sync_nudge'});
    expect(handleSyncNudge).toHaveBeenCalledTimes(1);
    expect(handleSyncNudge).toHaveBeenCalledWith('contacts');
    expect(c.onMessage).not.toHaveBeenCalled();
  });

  it('a nudge from a foreign pubkey is dropped without reconciling', async() => {
    const {handleRelayMessage} = await import('@lib/phantomchat/chat-api-receive');
    const c = ctx();
    const res = await handleRelayMessage(await nudge(STRANGER), c);
    expect(res).toEqual({action: 'skipped', reason: 'sync_nudge'});
    expect(handleSyncNudge).not.toHaveBeenCalled();
    expect(c.onMessage).not.toHaveBeenCalled();
  });

  it('this device\'s own nudge is ignored', async() => {
    const {handleRelayMessage} = await import('@lib/phantomchat/chat-api-receive');
    const {SYNC_NUDGE_DEVICE_ID} = await import('@lib/phantomchat/sync-nudge');
    const res = await handleRelayMessage(await nudge(ME, {deviceId: SYNC_NUDGE_DEVICE_ID}), ctx());
    expect(res).toEqual({action: 'skipped', reason: 'sync_nudge'});
    expect(handleSyncNudge).not.toHaveBeenCalled();
  });

  it('a stale relay replay is ignored', async() => {
    const {handleRelayMessage} = await import('@lib/phantomchat/chat-api-receive');
    const {SYNC_NUDGE_MAX_AGE_SECONDS} = await import('@lib/phantomchat/sync-nudge');
    // Inside the 3-day created_at window, outside the nudge freshness window.
    const res = await handleRelayMessage(await nudge(ME, {ageSeconds: SYNC_NUDGE_MAX_AGE_SECONDS + 60}), ctx());
    expect(res).toEqual({action: 'skipped', reason: 'sync_nudge'});
    expect(handleSyncNudge).not.toHaveBeenCalled();
  });

  it('a malformed nudge (tag without a valid body) is dropped as a non-message', async() => {
    const {handleRelayMessage} = await import('@lib/phantomchat/chat-api-receive');
    const c = ctx();
    const bad = {...(await nudge(ME)), content: 'hello'};
    const res = await handleRelayMessage(bad, c);
    expect(res).toEqual({action: 'skipped', reason: 'sync_nudge'});
    expect(handleSyncNudge).not.toHaveBeenCalled();
    expect(c.onMessage).not.toHaveBeenCalled();
  });
});
