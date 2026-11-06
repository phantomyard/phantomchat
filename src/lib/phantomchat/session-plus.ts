/*
 * The Sessions `+` button: what one press does, decided from the contacts the
 * picker would list.
 *
 *   - no contacts  -> the New Contact pane (an empty picker only says "tap +"
 *                     again); the contact saved there becomes the session.
 *   - one contact  -> that contact, whatever its type (Phantom, human or
 *                     provider) — a picker with one row is a click for nothing.
 *   - more         -> the picker.
 *
 * Kept free of the sidebar graph so the rule is unit-testable.
 */

import type {VirtualPeerMapping} from './virtual-peers-db';

export type SessionPlusRoute =
  {kind: 'add-contact'} |
  {kind: 'direct', peerId: PeerId} |
  {kind: 'picker'};

export function routeSessionPlus(peerIds: PeerId[]): SessionPlusRoute {
  if(!peerIds.length) return {kind: 'add-contact'};
  if(peerIds.length === 1) return {kind: 'direct', peerId: peerIds[0]};
  return {kind: 'picker'};
}

/**
 * The contacts the picker would list, from the same two sources and with the
 * same precedence as `AppContactsTab.openContacts`: the worker's contact list
 * whenever it answers — EVEN EMPTY, since that empty answer is exactly the
 * blank picker this replaces (a fresh install still holds a mapping for its
 * own key, so the mappings are not a fallback for "none") — and the P2P
 * mappings only when the worker path rejects. Tombstoned mappings, which the
 * tab lists as "Deleted Account" rows, cannot hold a session and do not count.
 */
export async function listSessionContacts(deps: {
  getContactsPeerIds: () => Promise<PeerId[]>,
  getAllMappings: () => Promise<VirtualPeerMapping[]>,
  isTombstoned: (mapping: VirtualPeerMapping) => Promise<boolean>
}): Promise<PeerId[]> {
  try {
    return await deps.getContactsPeerIds();
  } catch{
    // MTProto path unavailable: the tab falls back to the mappings.
  }

  const mappings = await deps.getAllMappings();
  const live: PeerId[] = [];
  for(const m of mappings) {
    if(!await deps.isTombstoned(m)) live.push(m.peerId.toPeerId(false));
  }
  return live;
}
