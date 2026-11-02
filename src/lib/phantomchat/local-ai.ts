/**
 * Renderer side of the #276 embed: everything that needs the principal's key or
 * the app's own stores. The rules live in the main process (electron/localAi).
 *
 * This file only ever runs for real inside the desktop app. Every entry point
 * degrades to "nothing here" on the PWA and on desktop builds from before #276.
 */
import {createGiftWrap, createRumor, createSeal} from './nostr-crypto';
import {getLocalAiApi, type LocalAiApi, type ExternalAiView, type LocalToolGroupInfo} from './desktop-api';
import {isSessionPeer} from './group-types';
import {toolMessageContent, toolMessageTags} from './local-tools-wire';

type RelayPoolLike = {
  publishRawEvent(event: any): Promise<unknown>;
  getPrivateKey(): Uint8Array | null | undefined;
  getRelays?(): {url: string}[];
};

let ownPubkey: string | null = null;
let relayPool: RelayPoolLike | null = null;
let unsubscribe: (() => void) | null = null;

export async function initLocalAi(owner: string, pool: RelayPoolLike | null | undefined): Promise<void> {
  const api = getLocalAiApi();
  if(!api) return;
  ownPubkey = owner;
  relayPool = pool ?? null;
  const relays = relayPool?.getRelays?.().map((relay) => relay.url) ?? [];
  await api['set-context'](owner, relays);

  unsubscribe?.();
  unsubscribe = api.onEvent((event) => {
    if(event.type === 'tools-activity') {
      void import('./local-tools-indicator').then(({setLocalToolsRunning}) => setLocalToolsRunning(event.running));
    }
  });

  // Tell the contacts allowed in that this PC is back.
  const [enabled, capability] = await Promise.all([api['local-access-enabled'](), api['capability']()]);
  await Promise.all(enabled.map((pubkey) => sendToolMessage(pubkey, capability)));
}

/** One message to one contact, to that contact only. No copy to your own devices. */
export async function sendToolMessage(recipient: string, message: unknown): Promise<void> {
  const secretKey = relayPool?.getPrivateKey();
  if(!relayPool || !secretKey) return;
  const rumor = createRumor(toolMessageContent(message), secretKey, toolMessageTags(recipient));
  await relayPool.publishRawEvent(createGiftWrap(createSeal(rumor, secretKey, recipient), recipient));
}

async function groupInfo(groupId: unknown): Promise<LocalToolGroupInfo | null> {
  if(typeof groupId !== 'string') return null;
  const {getGroupStore} = await import('./group-store');
  const group = await getGroupStore().get(groupId);
  return group ? {isSession: isSessionPeer(group.peerId), members: group.members} : null;
}

/**
 * A verified rumor from `msg.from`: the unwrap bound it to that npub's signature.
 * Main decides whether it gets anything back. Normally that is nothing.
 */
export async function handleLocalToolsRumor(msg: {from: string; content: string}): Promise<void> {
  const api = getLocalAiApi();
  if(!api) return;
  let payload: any;
  try {
    payload = JSON.parse(msg.content);
  } catch{
    return;
  }

  const {getMessageRequestStore} = await import('./message-requests');
  if(await getMessageRequestStore().isBlocked(msg.from).catch(() => false)) return;

  const replies = await api['tool-message'](msg.from, payload, await groupInfo(payload?.groupId));
  await Promise.all(replies.map((reply) => sendToolMessage(msg.from, reply)));
}

async function pubkeyOf(userId: number): Promise<string | null> {
  const {getPubkey} = await import('./virtual-peers-db');
  return (await getPubkey(userId)) ?? null;
}

export async function localAccessState(userId: number): Promise<{available: boolean; enabled: boolean}> {
  const api = getLocalAiApi();
  const {isP2PPeerId} = await import('./bridge-invariants');
  if(!api || !isP2PPeerId(userId)) return {available: false, enabled: false};
  const pubkey = await pubkeyOf(userId);
  if(!pubkey) return {available: false, enabled: false};
  return {available: true, enabled: (await api['local-access-enabled']()).includes(pubkey)};
}

async function displayName(userId: number, pubkey: string): Promise<string> {
  try {
    const rootScope = (await import('@lib/rootScope')).default;
    const user = await rootScope.managers.appUsersManager.getUser(userId);
    const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ');
    if(name) return name;
  } catch{ /* fall through */ }
  return `${pubkey.slice(0, 8)}…`;
}

/** Returns the state main ended up with. The Allow dialog is main's, not ours. */
export async function setLocalAccess(userId: number, on: boolean): Promise<boolean> {
  const api = getLocalAiApi();
  const pubkey = await pubkeyOf(userId);
  if(!api || !pubkey) return false;
  const {enabled, notify} = await api['set-local-access'](pubkey, on, await displayName(userId, pubkey));
  if(notify) await sendToolMessage(pubkey, notify).catch(() => {});
  return enabled;
}

async function addContact(api: LocalAiApi, view: ExternalAiView, pin: boolean): Promise<void> {
  const {addP2PContact} = await import('./add-p2p-contact');
  const added = await addP2PContact({
    pubkey: view.pubkey,
    nickname: view.name,
    deliberate: true,
    source: 'external-ai'
  });
  // A chat-list row needs a message. Added first, so this is not a stranger's.
  await api['greet-external-ai'](view.pubkey);
  if(pin) await pinWhenListed(added.peerIdTweb);
}

/** The dialog appears once the greeting has come back over the relays. */
async function pinWhenListed(peerId: PeerId, attempts = 60): Promise<void> {
  const rootScope = (await import('@lib/rootScope')).default;
  for(let i = 0; i < attempts; i++) {
    // A row can be listed before the worker has its dialog, and pinning needs that.
    await rootScope.managers.appMessagesManager.reloadConversation(peerId).catch((): undefined => undefined);
    const dialog = await rootScope.managers.appMessagesManager.getDialogOnly(peerId).catch((): undefined => undefined);
    if(dialog) {
      try {
        if(!(dialog as any).pFlags?.pinned) await rootScope.managers.appMessagesManager.toggleDialogPin({peerId});
      } catch(err) {
        console.warn('[LocalAi] could not pin the new External AI:', err);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.warn('[LocalAi] the new External AI never reached the chat list, so it is not pinned');
}

/** From the "New External AI" button. */
export async function createExternalAi(api: LocalAiApi = getLocalAiApi()!): Promise<ExternalAiView> {
  const created = await api['create-external-ai']();
  if(created.ok === false) throw new Error(created.error);
  await addContact(api, created.value, false);
  return created.value;
}

/** After a provider is configured: the first one comes by itself, pinned. */
export async function ensureFirstExternalAi(api: LocalAiApi = getLocalAiApi()!): Promise<ExternalAiView | null> {
  const created = await api['create-first-external-ai']();
  if(created.ok === false) throw new Error(created.error);
  if(created.value) await addContact(api, created.value, true);
  return created.value;
}

export async function hostedExternalAi(userId: number): Promise<ExternalAiView | null> {
  const api = getLocalAiApi();
  if(!api) return null;
  const pubkey = await pubkeyOf(userId);
  if(!pubkey) return null;
  return (await api['list-external-ai']()).find((ai) => ai.pubkey === pubkey) ?? null;
}

export async function renameHostedExternalAi(userId: number, first: string, last: string): Promise<void> {
  const api = getLocalAiApi();
  const hosted = await hostedExternalAi(userId);
  if(!api || !hosted) return;
  const name = [first, last].map((part) => part?.trim()).filter(Boolean).join(' ');
  if(name && name !== hosted.name) await api['update-external-ai'](hosted.pubkey, {name});
}

/**
 * True when the contact may be deleted. Anything not hosted here is ordinary. For
 * one hosted here, main asks natively and destroys the nsec and history on a yes.
 */
export async function confirmHostedDelete(pubkey: string): Promise<boolean> {
  const api = getLocalAiApi();
  if(!api) return true;
  const hosted = (await api['list-external-ai']()).some((ai) => ai.pubkey === pubkey);
  return hosted ? api['delete-external-ai'](pubkey) : true;
}
