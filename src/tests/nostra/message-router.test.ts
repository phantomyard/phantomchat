// @ts-nocheck
import {describe, it, expect, vi, beforeEach} from 'vitest';

const mockEvent = {
  id: 'abc123',
  pubkey: 'sender111',
  created_at: 1700000000,
  kind: 1059,
  tags: [],
  content: 'encrypted',
  sig: 'sig111'
};

const recipientPubkey = 'recipient222';
const contactPubkey = 'contact333';

describe('MessageRouter', () => {
  let router;
  let meshManager;
  let relayPublish;
  let getContactsForPeer;

  beforeEach(async() => {
    vi.resetModules();
    const {MessageRouter} = await import('@lib/nostra/message-router');

    meshManager = {
      getStatus: vi.fn().mockReturnValue('disconnected'),
      getConnectedPeers: vi.fn().mockReturnValue([]),
      send: vi.fn().mockReturnValue(false)
    };
    relayPublish = vi.fn().mockResolvedValue(true);
    getContactsForPeer = vi.fn().mockReturnValue([]);

    router = new MessageRouter({
      meshManager,
      relayPublish,
      getContactsForPeer
    });
  });

  it('routes via mesh-direct when recipient is connected', async() => {
    meshManager.getStatus.mockReturnValue('connected');
    meshManager.send.mockReturnValue(true);

    const result = await router.route(mockEvent, recipientPubkey);

    expect(result.path).toBe('mesh-direct');
    expect(result.delivered).toBe(true);
    expect(meshManager.send).toHaveBeenCalledWith(
      recipientPubkey,
      JSON.stringify(['EVENT', mockEvent])
    );
  });

  it('routes via mesh-forward when mutual contact is connected', async() => {
    meshManager.getStatus.mockReturnValue('disconnected');
    meshManager.getConnectedPeers.mockReturnValue([contactPubkey]);
    meshManager.send.mockReturnValue(true);
    getContactsForPeer.mockReturnValue([contactPubkey]);

    const result = await router.route(mockEvent, recipientPubkey);

    expect(result.path).toBe('mesh-forward');
    expect(result.delivered).toBe(true);
    expect(meshManager.send).toHaveBeenCalledWith(
      contactPubkey,
      JSON.stringify(['EVENT', mockEvent])
    );
  });

  it('falls back to relay-external when no mesh path available', async() => {
    const result = await router.route(mockEvent, recipientPubkey);

    expect(result.path).toBe('relay-external');
    expect(result.delivered).toBe(true);
    expect(relayPublish).toHaveBeenCalledWith(mockEvent);
  });

  it('also publishes to relay as backup on mesh-direct success', async() => {
    meshManager.getStatus.mockReturnValue('connected');
    meshManager.send.mockReturnValue(true);

    await router.route(mockEvent, recipientPubkey);

    // relay publish called as fire-and-forget backup
    expect(relayPublish).toHaveBeenCalledWith(mockEvent);
  });

  it('includes forwardedVia pubkey in mesh-forward result', async() => {
    meshManager.getStatus.mockReturnValue('disconnected');
    meshManager.getConnectedPeers.mockReturnValue([contactPubkey]);
    meshManager.send.mockReturnValue(true);
    getContactsForPeer.mockReturnValue([contactPubkey]);

    const result = await router.route(mockEvent, recipientPubkey);

    expect(result.forwardedVia).toBe(contactPubkey);
  });

  it('returns delivered:false when relayPublish fails on relay-external', async() => {
    relayPublish.mockResolvedValue(false);

    const result = await router.route(mockEvent, recipientPubkey);

    expect(result.path).toBe('relay-external');
    expect(result.delivered).toBe(false);
  });

  it('tries direct first, then forward, then relay in priority order', async() => {
    // Recipient connected but send fails -> should fall through to forward -> then relay
    meshManager.getStatus.mockImplementation((pubkey) => {
      return pubkey === recipientPubkey ? 'connected' : 'disconnected';
    });
    meshManager.send.mockReturnValue(false); // direct send fails
    meshManager.getConnectedPeers.mockReturnValue([]); // no connected contacts
    getContactsForPeer.mockReturnValue([contactPubkey]);

    const result = await router.route(mockEvent, recipientPubkey);

    // direct send attempted
    expect(meshManager.send).toHaveBeenCalledWith(
      recipientPubkey,
      expect.any(String)
    );
    // relay fallback used
    expect(result.path).toBe('relay-external');
    expect(relayPublish).toHaveBeenCalledWith(mockEvent);
  });

  it('falls through to mesh-forward when direct send fails', async() => {
    meshManager.getStatus.mockReturnValue('connected');
    meshManager.send.mockReturnValueOnce(false); // direct send fails
    meshManager.getConnectedPeers.mockReturnValue(['carlo']);
    meshManager.send.mockReturnValueOnce(true); // forward succeeds

    const {MessageRouter} = await import('@lib/nostra/message-router');
    const router = new MessageRouter({
      meshManager,
      relayPublish,
      getContactsForPeer: vi.fn().mockReturnValue(['carlo'])
    });

    const event = {id: 'e1', pubkey: 'alice', kind: 1059, created_at: 0, content: 'x', tags: [], sig: 's'};
    const result = await router.route(event, 'bob');

    expect(result.path).toBe('mesh-forward');
    expect(result.forwardedVia).toBe('carlo');
  });

  it('relay backup error does not affect mesh-direct result', async() => {
    meshManager.getStatus.mockReturnValue('connected');
    meshManager.send.mockReturnValue(true);
    relayPublish.mockRejectedValue(new Error('relay down'));

    const event = {id: 'e2', pubkey: 'alice', kind: 1059, created_at: 0, content: 'x', tags: [], sig: 's'};
    const result = await router.route(event, 'bob');

    // Should still report mesh-direct success despite relay failure
    expect(result.path).toBe('mesh-direct');
    expect(result.delivered).toBe(true);
  });

  it('routes to relay when mutual contacts exist but none connected', async() => {
    meshManager.getConnectedPeers.mockReturnValue([]); // nobody online

    const {MessageRouter} = await import('@lib/nostra/message-router');
    const router = new MessageRouter({
      meshManager,
      relayPublish,
      getContactsForPeer: vi.fn().mockReturnValue(['carlo', 'dave']) // have contacts but none connected
    });

    const event = {id: 'e3', pubkey: 'alice', kind: 1059, created_at: 0, content: 'x', tags: [], sig: 's'};
    const result = await router.route(event, 'bob');

    expect(result.path).toBe('relay-external');
  });
});
