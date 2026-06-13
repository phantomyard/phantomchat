/**
 * api-manager-stub
 *
 * Monkey-patches apiManager.invokeApi() to route P2P traffic to Nostra.chat
 * instead of MTProto when the feature flag is enabled.
 *
 * Side-effect: importing this module installs the hook.
 */

import ctx from '@environment/ctx';
import {NostraBridge} from './nostra-bridge';
import type {ApiManager} from '@appManagers/apiManager';
import type {MethodDeclMap} from '@layer';
import type {InvokeApiOptions} from '@types';
import type {ChatAPI} from './chat-api';

// Re-export ApiManager type for consumers who need it
export type {ApiManager} from '@appManagers/apiManager';

const P2P_METHODS = /(?:messages\.sendMessage|messages\.getHistory|users\.getFullUser)/;

type InvokeApiMethod = keyof MethodDeclMap;

function getApiManager(): ApiManager | undefined {
  return (ctx as Window & {apiManager?: ApiManager}).apiManager;
}

/** Get ChatAPI from window (set by onboarding integration) */
function getChatAPI(): ChatAPI | undefined {
  return (window as any).__nostraChatAPI as ChatAPI | undefined;
}

const stub = {
  installed: false,
  _original: null as ApiManager['invokeApi'] | null
};

/**
 * Build a synthetic User object for a P2P virtual user.
 * Mirrors appUsersManager.injectP2PUser but usable in the stub.
 */
function buildSyntheticUser(userId: number, pubkey: string, avatar: string) {
  return {
    _: 'user' as const,
    id: userId,
    pFlags: {} as Record<string, boolean>,
    first_name: 'P2P User',
    last_name: '',
    username: '',
    phone: '',
    status: {_: 'userStatusOnline'},
    p2pPubkey: pubkey,
    p2pAvatar: avatar
  };
}

/**
 * Extract peerId from a messages.getHistory request.
 * Supports inputPeerUser and inputPeerChannel variants.
 */
function extractPeerIdFromGetHistory(req: any): number | null {
  if(!req || !req.peer) return null;
  const peer = req.peer as any;
  if(peer._ === 'inputPeerUser') return peer.user_id;
  if(peer._ === 'inputPeerChannel') return peer.channel_id;
  if(peer._ === 'inputPeerChat') return peer.chat_id;
  return null;
}

/**
 * Extract userId from a users.getFullUser request.
 */
function extractUserIdFromGetFullUser(req: any): number | null {
  if(!req || !req.id) return null;
  const id = req.id as any;
  if(id._ === 'inputUser') return id.user_id;
  return null;
}

/**
 * Install the apiManager monkey-patch.
 * Safe to call multiple times — returns false if already installed.
 */
export function installApiManagerStub(): boolean {
  if(stub.installed) return false;

  const apiManager = getApiManager();
  if(!apiManager) {
    console.warn('[Nostra.chat] apiManager stub: apiManager not found on ctx — stub not installed');
    return false;
  }

  // Store reference to the original unbound method
  stub._original = apiManager.invokeApi.bind(apiManager);

  // Replace invokeApi with our wrapper

  (apiManager as any).invokeApi = async function<T extends InvokeApiMethod>(
    method: T,

    ...args: [MethodDeclMap[T]['req']?, InvokeApiOptions?]

  ): Promise<any> {
    const [req] = args as [any, InvokeApiOptions?];

    // --- messages.getHistory: route through ChatAPI ---
    if(method === 'messages.getHistory') {
      const peerId = extractPeerIdFromGetHistory(req);
      if(peerId === null) {
        console.warn(`[Nostra.chat] MTProto disabled: ${method} rejected (null peerId)`);
        return Promise.reject({type: 'MTPROTO_DISABLED', code: 503, description: `Method ${method} is not available - MTProto connections disabled`});
      }

      const bridge = NostraBridge.getInstance();
      const pubkey = await bridge.reverseLookup(peerId).catch((): null => null);

      if(pubkey === null) {
        console.warn(`[Nostra.chat] MTProto disabled: ${method} rejected (unknown peer ${peerId})`);
        return Promise.reject({type: 'MTPROTO_DISABLED', code: 503, description: `Method ${method} is not available - MTProto connections disabled`});
      }

      console.log(`[NostraStub] routing messages.getHistory for peerId=${peerId} (${pubkey.slice(0, 8)}...)`);

      const chatAPI = getChatAPI();
      if(!chatAPI) {
        console.warn(`[Nostra.chat] MTProto disabled: ${method} rejected (ChatAPI unavailable)`);
        return Promise.reject({type: 'MTPROTO_DISABLED', code: 503, description: `Method ${method} is not available - MTProto connections disabled`});
      }

      const history = chatAPI.getHistory();

      // Transform ChatMessage[] → tweb messages.messages format
      // For now, history is empty (no relay persistence in S04) — return empty wrapper
      const messages: any[] = [];
      const users: any[] = [];

      // Include the peer as a synthetic user
      const avatar = bridge.deriveAvatarFromPubkeySync(pubkey);
      users.push(buildSyntheticUser(peerId, pubkey, avatar));

      return {
        _: 'messages.messages',
        count: messages.length,
        messages,
        users,
        chats: []
      };
    }

    // --- users.getFullUser: route through NostraBridge ---
    if(method === 'users.getFullUser') {
      const userId = extractUserIdFromGetFullUser(req);
      if(userId === null) {
        console.warn(`[Nostra.chat] MTProto disabled: ${method} rejected (null userId)`);
        return Promise.reject({type: 'MTPROTO_DISABLED', code: 503, description: `Method ${method} is not available - MTProto connections disabled`});
      }

      const bridge = NostraBridge.getInstance();
      const pubkey = await bridge.reverseLookup(userId).catch((): null => null);

      if(pubkey === null) {
        console.warn(`[Nostra.chat] MTProto disabled: ${method} rejected (unknown user ${userId})`);
        return Promise.reject({type: 'MTPROTO_DISABLED', code: 503, description: `Method ${method} is not available - MTProto connections disabled`});
      }

      console.log(`[NostraStub] routing users.getFullUser for userId=${userId} (${pubkey.slice(0, 8)}...)`);

      const avatar = bridge.deriveAvatarFromPubkeySync(pubkey);
      const syntheticUser = buildSyntheticUser(userId, pubkey, avatar);

      // Return a synthetic UserFull-like structure
      // tweb expects users.getFullUser to return full user info including profile photos, bot info, etc.
      return {
        users: [syntheticUser]
      };
    }

    // --- messages.getDialogs: return empty dialog list ---
    if(method === 'messages.getDialogs') {
      console.log(`[NostraStub] returning empty dialogs for ${method}`);
      return {
        _: 'messages.dialogs',
        count: 0,
        dialogs: [],
        messages: [],
        users: [],
        chats: []
      };
    }

    // --- contacts.getContacts: return empty contacts ---
    if(method === 'contacts.getContacts') {
      console.log(`[NostraStub] returning empty contacts for ${method}`);
      return {
        _: 'contacts.contacts',
        contacts: [],
        saved_count: 0,
        users: []
      };
    }

    // --- updates.getState / updates.getDifference: return minimal state ---
    if(method === 'updates.getState') {
      return {
        _: 'updates.state',
        pts: 1,
        qts: 0,
        date: Math.floor(Date.now() / 1000),
        seq: 0,
        unread_count: 0
      };
    }

    if(method === 'updates.getDifference') {
      return {
        _: 'updates.differenceEmpty',
        date: Math.floor(Date.now() / 1000),
        seq: 0
      };
    }

    // --- ALL other methods: reject (MTProto disabled) ---
    console.warn(`[Nostra.chat] MTProto disabled: ${method} rejected`);
    return Promise.reject({
      type: 'MTPROTO_DISABLED',
      code: 503,
      description: `Method ${method} is not available - MTProto connections disabled`
    });
  };

  stub.installed = true;
  console.log('[Nostra.chat] apiManager stub installed');
  return true;
}

/**
 * Uninstall the stub and restore the original invokeApi.
 * For testing / hot-reload use cases.
 */
export function uninstallApiManagerStub(): boolean {
  if(!stub.installed || !stub._original) return false;

  const apiManager = getApiManager();
  if(apiManager) {
    (apiManager as any).invokeApi = stub._original;
  }

  stub.installed = false;
  stub._original = null;
  return true;
}

/**
 * Returns true if the stub is currently installed.
 */
export function isStubInstalled(): boolean {
  return stub.installed;
}

// Stub is installed by createManagers.ts after apiManager is on ctx
