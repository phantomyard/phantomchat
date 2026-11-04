/**
 * Page side of Local tools for Phantom contacts (phantombot #747, contacts
 * redesign): everything that needs the principal's key or the app's stores.
 * The gate and protocol are the desktop main process's (electron/localTools).
 *
 * Only does anything inside a desktop build that has `localTools`; on the PWA
 * and older installs every entry point is a no-op.
 */
import {createGiftWrap, createRumor, createSeal} from './nostr-crypto';
import {isSessionPeer} from './group-types';
import {toolMessageContent, toolMessageTags} from './local-tools-wire';

type RelayPoolLike = {
  publishRawEvent(event: any): Promise<unknown>;
  getPrivateKey(): Uint8Array | null | undefined;
};

export interface DesktopLocalToolsApi {
  setOwner(ownerPubkey: string): Promise<{enabled: string[]; capability: unknown}>;
  enabled(): Promise<string[]>;
  set(pubkey: string, on: boolean, contactName: string): Promise<{enabled: boolean; notify: unknown}>;
  message(sender: string, payload: unknown, group: {isSession: boolean; members: string[]} | null): Promise<unknown[]>;
}

export function getLocalToolsApi(): DesktopLocalToolsApi | null {
  const api = typeof window !== 'undefined' ? (window as any).phantomchatDesktop?.localTools : undefined;
  return api && typeof api.message === 'function' ? api as DesktopLocalToolsApi : null;
}

let relayPool: RelayPoolLike | null = null;

/** At boot: tell main who is signed in, and tell allowed phantoms this PC is back. */
export async function initLocalTools(owner: string, pool: RelayPoolLike | null | undefined): Promise<void> {
  const api = getLocalToolsApi();
  if(!api) return;
  relayPool = pool ?? null;
  const {enabled, capability} = await api.setOwner(owner);
  if(capability) await Promise.all(enabled.map((pubkey) => sendToolMessage(pubkey, capability).catch(() => {})));
}

/** One message to one contact only. No copy to my own devices. */
export async function sendToolMessage(recipient: string, message: unknown): Promise<void> {
  const secretKey = relayPool?.getPrivateKey();
  if(!relayPool || !secretKey) return;
  const rumor = createRumor(toolMessageContent(message), secretKey, toolMessageTags(recipient));
  await relayPool.publishRawEvent(createGiftWrap(createSeal(rumor, secretKey, recipient), recipient));
}

async function groupInfo(groupId: unknown): Promise<{isSession: boolean; members: string[]} | null> {
  if(typeof groupId !== 'string') return null;
  const {getGroupStore} = await import('./group-store');
  const group = await getGroupStore().get(groupId);
  return group ? {isSession: isSessionPeer(group.peerId), members: group.members} : null;
}

/**
 * A rumor the unwrap bound to `msg.from`'s signature. Main decides whether it
 * gets anything back; usually it is nothing.
 */
export async function handleLocalToolsRumor(msg: {from: string; content: string}): Promise<void> {
  const api = getLocalToolsApi();
  if(!api) return;
  let payload: any;
  try {
    payload = JSON.parse(msg.content);
  } catch{
    return;
  }
  const {getMessageRequestStore} = await import('./message-requests');
  if(await getMessageRequestStore().isBlocked(msg.from).catch(() => false)) return;
  const replies = await api.message(msg.from, payload, await groupInfo(payload?.groupId));
  for(const reply of replies) await sendToolMessage(msg.from, reply);
}

/**
 * Flip a Phantom contact's Local tools. ON shows main's native Allow dialog.
 * Returns the state main ended up with (false when declined or unavailable).
 */
export async function setPhantomLocalTools(pubkey: string, on: boolean, contactName: string): Promise<boolean> {
  const api = getLocalToolsApi();
  if(!api) return false;
  const {enabled, notify} = await api.set(pubkey, on, contactName);
  if(notify) await sendToolMessage(pubkey, notify).catch(() => {});
  return enabled;
}
