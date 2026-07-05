/**
 * renameP2PContact — canonical helper for renaming a P2P (Nostr) contact.
 *
 * The stock tweb Edit Contact → Save path calls
 * `appUsersManager.addContact` → `invokeApi('contacts.addContact')`, but the
 * local virtual-MTProto server has no handler for `contacts.addContact`, so
 * the call silently no-ops and the name reverts to the npub placeholder on the
 * next render. This helper drives the working primitives instead:
 *
 *   1. persist the user-supplied name to the virtual-peers IndexedDB
 *      (so it survives reload), creating a missing mapping if needed and
 *      force-writing over the npub placeholder;
 *   2. update the live synthetic Worker user (first + last name);
 *   3. update the main-thread peer mirror + Solid store;
 *   4. dispatch `peer_title_edit` so chat-list + topbar refresh imperatively.
 *
 * Because the persisted displayName is the user's choice (distinct from any
 * kind:0 name), the WU-2 #10 guard in updateMappingProfile preserves it
 * against future kind:0 profile upgrades.
 */
import {MOUNT_CLASS_TO} from '@config/debug';
import rootScope from '@lib/rootScope';

export interface RenameP2PContactResult {
  /** Combined display name actually applied (first + last, trimmed). */
  displayName: string;
  /** True when the peer had a stored mapping that was updated. */
  persisted: boolean;
}

/**
 * Rename a P2P contact. `peerId` is the numeric synthetic peerId
 * (`PeerId.toUserId()` for a user peer — identical for P2P peers).
 */
export async function renameP2PContact(
  peerId: number,
  firstName: string,
  lastName?: string
): Promise<RenameP2PContactResult> {
  const first = (firstName || '').trim();
  const last = (lastName || '').trim();
  const peerIdTweb = peerId.toPeerId(false);
  const displayName = [first, last].filter(Boolean).join(' ');

  // 1. Persist to IndexedDB (force-write over the npub placeholder). Prefer
  //    in-memory pubkey sources first so the UI path isn't stalled on IDB;
  //    fall back to reverse lookup only when the live user/mirror has not
  //    cached the pubkey yet. The write itself is fire-and-forget because this
  //    helper is awaited by the Edit Contact Save handler.
  let persisted = false;
  try {
    const {getPubkey, storeMapping} = await import('./virtual-peers-db');
    const liveUser = rootScope.managers.appUsersManager.getUser(peerId as any) as any;
    const proxyUser = MOUNT_CLASS_TO.apiManagerProxy?.mirrors?.peers?.[peerIdTweb] as any;
    const hexPubkey = liveUser?.p2pPubkey || proxyUser?.p2pPubkey || await getPubkey(peerId);
    if(hexPubkey && displayName) {
      storeMapping(hexPubkey, peerId, displayName).catch((err: any) => {
        console.warn('[renameP2PContact] storeMapping failed:', err);
      });
      persisted = true;
    }
  } catch(err) {
    console.warn('[renameP2PContact] persist failed:', err);
  }

  // 2. Update the live synthetic Worker user (first + last name). Passing
  //    `last` (a string, possibly empty) lets the user clear a surname.
  try {
    await rootScope.managers.appUsersManager.updateP2PUserName(peerId, first, last);
  } catch(err) {
    console.warn('[renameP2PContact] updateP2PUserName failed:', err);
  }

  // 3. Update the main-thread mirror + Solid store so the UI reflects it
  //    without a reload.
  const proxyRef = MOUNT_CLASS_TO.apiManagerProxy;
  if(proxyRef?.mirrors?.peers?.[peerIdTweb]) {
    proxyRef.mirrors.peers[peerIdTweb].first_name = first;
    proxyRef.mirrors.peers[peerIdTweb].last_name = last || undefined;
    try {
      const {reconcilePeer} = await import('@stores/peers');
      reconcilePeer(peerIdTweb, proxyRef.mirrors.peers[peerIdTweb]);
    } catch{ /* store not yet mounted */ }
  }

  // 4. PeerTitle is imperative — refresh chat-list + topbar.
  rootScope.dispatchEvent('peer_title_edit', {peerId: peerIdTweb});

  return {displayName, persisted};
}
