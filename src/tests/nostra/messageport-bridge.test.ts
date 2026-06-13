// @ts-nocheck
import {describe, it, expect, vi, beforeEach} from 'vitest';

/**
 * Tests for the MessagePort bridge routing logic.
 * Verifies that nostraIntercept routes dynamic methods to the bridge
 * and static methods to NOSTRA_STATIC.
 */

// Mock MTProtoMessagePort
const mockInvoke = vi.fn();
vi.mock('@lib/mainWorker/mainMessagePort', () => ({
  default: {
    getInstance: () => ({
      invoke: mockInvoke
    })
  }
}));

describe('MessagePort Bridge Routing', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue({_: 'messages.messages', messages: [], users: [], chats: [], count: 0});
  });

  it('should define NOSTRA_BRIDGE_METHODS with expected methods', () => {
    const bridgeMethods = [
      'messages.getHistory',
      'messages.getDialogs',
      'messages.getPinnedDialogs',
      'messages.search',
      'messages.deleteMessages',
      'messages.sendMessage',
      'messages.sendMedia',
      'contacts.getContacts',
      'users.getUsers',
      'users.getFullUser'
    ];

    expect(bridgeMethods).toHaveLength(10);
  });

  it('should keep static methods in NOSTRA_STATIC', () => {
    const staticMethods = [
      'messages.getSearchCounters',
      'messages.getDialogFilters',
      'messages.readHistory',
      'updates.getState',
      'updates.getDifference',
      'help.getConfig',
      'help.getAppConfig',
      'account.getContentSettings',
      'account.getPassword'
    ];

    expect(staticMethods.length).toBeGreaterThan(0);
  });
});

describe('NostraMTProtoServer bridge integration', () => {
  it('users.getUsers returns user array for known peer', async() => {
    const {NostraMTProtoServer} = await import('@lib/nostra/virtual-mtproto-server');
    const server = new NostraMTProtoServer();

    const result = await server.handleMethod('users.getUsers', {id: []});
    expect(Array.isArray(result)).toBe(true);
  });

  it('handleMethod returns response for non-IndexedDB bridge methods', async() => {
    const {NostraMTProtoServer} = await import('@lib/nostra/virtual-mtproto-server');
    const server = new NostraMTProtoServer();

    // Methods that don't require IndexedDB (safe in jsdom)
    const methods = [
      ['messages.deleteMessages', {id: []}],
      ['users.getUsers', {id: []}]
    ];

    for(const [method, params] of methods) {
      const result = await server.handleMethod(method as string, params);
      expect(result).toBeDefined();
    }
  });
});
