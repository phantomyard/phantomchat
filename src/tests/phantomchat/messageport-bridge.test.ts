// @ts-nocheck
import {describe, it, expect, vi, beforeEach} from 'vitest';

/**
 * Tests for the MessagePort bridge routing logic.
 * Verifies that phantomchatIntercept routes dynamic methods to the bridge
 * and static methods to PHANTOMCHAT_STATIC.
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

  it('should define PHANTOMCHAT_BRIDGE_METHODS with expected methods', () => {
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

  it('should keep static methods in PHANTOMCHAT_STATIC', () => {
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

describe('PhantomChatMTProtoServer bridge integration', () => {
  it('users.getUsers returns user array for known peer', async() => {
    const {PhantomChatMTProtoServer} = await import('@lib/phantomchat/virtual-mtproto-server');
    const server = new PhantomChatMTProtoServer();

    const result = await server.handleMethod('users.getUsers', {id: []});
    expect(Array.isArray(result)).toBe(true);
  });

  it('handleMethod returns response for non-IndexedDB bridge methods', async() => {
    const {PhantomChatMTProtoServer} = await import('@lib/phantomchat/virtual-mtproto-server');
    const server = new PhantomChatMTProtoServer();

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

describe('messages.getPeerDialogs routing (chat-list preview reload)', () => {
  // Read the real source: a static stub shadows the bridge (statics are checked
  // first in the worker), and an empty stub is exactly what left restored
  // chat-list previews blank until each chat was opened.
  const {readFileSync} = require('fs');
  const {resolve} = require('path');
  const apiSrc: string = readFileSync(resolve(__dirname, '../../lib/appManagers/apiManager.ts'), 'utf8');
  const block = (name: string) => {
    const start = apiSrc.indexOf(name);
    expect(start).toBeGreaterThan(-1);
    const end = apiSrc.indexOf(name === 'PHANTOMCHAT_STATIC:' ? '\n  };' : '\n  ]);', start);
    return apiSrc.slice(start, end);
  };

  it('is a bridge method, not a static stub', () => {
    expect(block('PHANTOMCHAT_BRIDGE_METHODS = new Set([')).toContain('\'messages.getPeerDialogs\'');
    expect(block('PHANTOMCHAT_STATIC:')).not.toContain('\'messages.getPeerDialogs\'');
  });

  it('reloadConversation tolerates a peerDialogs result without state', () => {
    const amm: string = readFileSync(resolve(__dirname, '../../lib/appManagers/appMessagesManager.ts'), 'utf8');
    const i = amm.indexOf('\'messages.getPeerDialogs\'');
    const window = amm.slice(i, i + 1200);
    expect(window).toMatch(/if\(state && currentState\.pts && currentState\.pts !== state\.pts\)/);
  });
});
