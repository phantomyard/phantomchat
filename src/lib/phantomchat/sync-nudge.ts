/**
 * Sync nudge: "my contacts just changed, look now". A self-addressed gift-wrap
 * sent to my OWN devices right after a contacts-sync publish lands, so a
 * sibling device reconciles at once instead of on its 30-minute timer. That is
 * what makes a delete (or an add, or a rename) show up on every device within
 * seconds.
 *
 * The nudge carries no data. The sibling reads the snapshot from the relay
 * through the normal CRDT reconcile, which is the only path allowed to change
 * contacts. A lost, duplicated or replayed nudge only costs one extra
 * idempotent reconcile.
 *
 * Wire shape follows the Local tools convention (local-tools-wire.ts): the
 * `control` tag makes an older PhantomChat client drop it as a control message
 * of a type it does not know, so it never renders as a bubble anywhere.
 *
 * Imports nothing heavy, so the receive path can recognise it cheaply.
 */
import type {SyncDomain} from './phantomchat-sync-triggers';

export const SYNC_NUDGE_TAG = 'phantomchat-sync-nudge';

/** Nudges older than this are relay replays: the reconcile they ask for has long happened. */
export const SYNC_NUDGE_MAX_AGE_SECONDS = 10 * 60;

const NUDGE_DOMAINS: readonly SyncDomain[] = ['contacts'];

/** Random per page load: a device ignores its own nudge. */
export const SYNC_NUDGE_DEVICE_ID = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);

export interface SyncNudge {
  domain: SyncDomain;
  deviceId: string;
}

export function syncNudgeTags(ownPubkey: string, domain: SyncDomain): string[][] {
  return [['p', ownPubkey], [SYNC_NUDGE_TAG, domain], ['control', 'true']];
}

export function syncNudgeContent(domain: SyncDomain, deviceId: string = SYNC_NUDGE_DEVICE_ID): string {
  return JSON.stringify({type: SYNC_NUDGE_TAG, domain, deviceId});
}

/** The nudge in a rumor, or null when it is not one. Tag and body must agree. */
export function parseSyncNudge(tags: string[][] | undefined, content: string | undefined): SyncNudge | null {
  if(!Array.isArray(tags)) return null;
  const tag = tags.find((t) => Array.isArray(t) && t[0] === SYNC_NUDGE_TAG);
  if(!tag) return null;
  try {
    const body = JSON.parse(content || '');
    if(body?.type !== SYNC_NUDGE_TAG || body.domain !== tag[1]) return null;
    if(!(NUDGE_DOMAINS as readonly string[]).includes(body.domain)) return null;
    if(typeof body.deviceId !== 'string' || !body.deviceId) return null;
    return {domain: body.domain, deviceId: body.deviceId};
  } catch{
    return null;
  }
}

/** Any rumor carrying the nudge tag, valid or not: never a chat message. */
export function isSyncNudgeRumor(tags: string[][] | undefined): boolean {
  return Array.isArray(tags) && tags.some((t) => Array.isArray(t) && t[0] === SYNC_NUDGE_TAG);
}

export interface SyncNudgePool {
  getPrivateKey(): Uint8Array | null | undefined;
  getPublicKey?(): string | null | undefined;
  publishRawEvent(event: unknown): Promise<unknown>;
}

/** Gift-wrap the nudge to my own pubkey: my other devices hear it, nobody else. */
export async function sendSyncNudge(pool: SyncNudgePool | null | undefined, ownPubkey: string, domain: SyncDomain): Promise<void> {
  const secretKey = pool?.getPrivateKey();
  if(!pool || !secretKey || !ownPubkey) return;
  const {createGiftWrap, createRumor, createSeal} = await import('./nostr-crypto');
  const rumor = createRumor(syncNudgeContent(domain), secretKey, syncNudgeTags(ownPubkey, domain));
  await pool.publishRawEvent(createGiftWrap(createSeal(rumor, secretKey, ownPubkey), ownPubkey));
}
