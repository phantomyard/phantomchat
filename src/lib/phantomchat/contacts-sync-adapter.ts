/**
 * contacts-sync-adapter — plugs the contact address book (virtual-peers-db)
 * into the generic union-merge CRDT engine (crdt-sync.ts).
 *
 * WHY THIS SHAPE
 * The engine is domain-agnostic: it merges a `SyncMap<T>` and asks the adapter
 * to (a) read the local world as a SyncMap and (b) apply a merged SyncMap back.
 * This adapter maps that onto contacts.
 *
 * TIMESTAMP UNIT — the load-bearing detail.
 * CRDT entry `updatedAt` is in **seconds**, because that is the engine's clock
 * (nowSeconds / the 90-day tombstone TTL). But the two local sources speak
 * different units: a contact mapping's `updatedAt` is **millis** (Date.now()),
 * while a conversation tombstone's `deletedAt` is **seconds**. If we fed those
 * raw into the same CRDT, every live entry (~1.7e12) would tower over every
 * tombstone (~1.7e9) and a delete could never beat an add. So both are
 * normalised to seconds here, and restored back to millis on apply.
 *
 * TOMBSTONES ARE DERIVED, NOT LOGGED.
 * We do not keep a parallel "deleted contacts" list. A contact delete already
 * (a) removes the mapping and (b) writes a per-conversation deletion watermark
 * (message-store tombstone, for delete-boomerang suppression). So a deleted
 * contact is exactly: a conversation tombstone whose peer has no live mapping.
 * That is reconstructed in `read()`.
 */
import type {LocalAdapter} from './crdt-sync';
import type {SyncMap, SyncEntry} from './sync-crdt';
import type {VirtualPeerMapping} from './virtual-peers-db';

/** The payload published per contact. Minimal on purpose — peerId is
 * deterministic from the pubkey and re-derived on restore, and the kind-0
 * profile self-heals from relays, so neither is carried. */
export type ContactSyncData = {
  pubkey: string;
  displayName?: string;
  addedAt: number;
};

export type ContactsAdapterDeps = {
  /** Own hex pubkey, needed to reverse a sorted conversationId to the peer. */
  getOwnPubkey: () => string | null | undefined;
  listMappings: () => Promise<VirtualPeerMapping[]>;
  listTombstones: () => Promise<Array<{conversationId: string; deletedAt: number}>>;
  conversationId: (a: string, b: string) => string;
  /** Full materialize path (addP2PContact) — Worker inject + mirrors + dialog. */
  addContact: (pubkey: string, displayName?: string) => Promise<void>;
  setDisplayName: (pubkey: string, displayName: string) => Promise<void>;
  /** Pin updatedAt (millis) so a restore doesn't out-timestamp the remote. */
  setUpdatedAt: (pubkey: string, updatedAtMillis: number) => Promise<void>;
  removeContact: (pubkey: string) => Promise<void>;
  setTombstone: (conversationId: string, deletedAtSeconds: number) => Promise<void>;
  logPrefix?: string;
};

const HEX64 = /^[0-9a-f]{64}$/i;

/** Reverse a sorted `a:b` conversationId to the non-own peer pubkey, or null. */
function peerFromConversationId(conversationId: string, own: string): string | null {
  // Group tombstones are keyed `group:<id>`; only DM ids are `<hex>:<hex>`.
  const parts = conversationId.split(':');
  if(parts.length !== 2) return null;
  if(!HEX64.test(parts[0]) || !HEX64.test(parts[1])) return null;
  if(parts[0] === own) return parts[1];
  if(parts[1] === own) return parts[0];
  return null;
}

export function createContactsAdapter(deps: ContactsAdapterDeps): LocalAdapter<ContactSyncData> {
  const tag = deps.logPrefix || '[contacts-sync-adapter]';

  const read = async(): Promise<SyncMap<ContactSyncData>> => {
    const map: SyncMap<ContactSyncData> = {};

    const mappings = await deps.listMappings();
    const live = new Set<string>();
    for(const m of mappings) {
      live.add(m.pubkey);
      map[m.pubkey] = {
        id: m.pubkey,
        updatedAt: Math.floor((m.updatedAt ?? m.addedAt ?? 0) / 1000),
        data: {
          pubkey: m.pubkey,
          displayName: m.displayName,
          addedAt: m.addedAt
        }
      };
    }

    const own = deps.getOwnPubkey();
    if(own) {
      const tombstones = await deps.listTombstones();
      for(const t of tombstones) {
        const peer = peerFromConversationId(t.conversationId, own);
        if(!peer) continue;
        // A tombstone only becomes a CRDT delete when the contact is actually
        // gone. If a live mapping exists (e.g. cleared history but kept the
        // contact, or a re-add after delete) the live entry governs.
        if(live.has(peer)) continue;
        map[peer] = {id: peer, updatedAt: t.deletedAt, deleted: true};
      }
    }

    return map;
  };

  const apply = async(merged: SyncMap<ContactSyncData>, before: SyncMap<ContactSyncData>): Promise<void> => {
    for(const id of Object.keys(merged)) {
      const entry = merged[id];
      const prev = before[id];
      const wasLive = !!prev && !prev.deleted;

      try {
        if(entry.deleted) {
          if(wasLive) {
            await deps.removeContact(id);
            const own = deps.getOwnPubkey();
            if(own) await deps.setTombstone(deps.conversationId(own, id), entry.updatedAt);
          }
          continue;
        }

        // entry is live
        if(!wasLive) {
          // New or resurrected contact — full materialize, then pin timestamp.
          await deps.addContact(id, entry.data?.displayName);
          await deps.setUpdatedAt(id, entry.updatedAt * 1000);
        } else if(entry.updatedAt > prev.updatedAt) {
          // Remote had a newer mutation (rename / profile). Apply the name if
          // it changed, then pin the timestamp so we converge.
          const name = entry.data?.displayName;
          if(name && name !== prev.data?.displayName) await deps.setDisplayName(id, name);
          await deps.setUpdatedAt(id, entry.updatedAt * 1000);
        }
        // else: unchanged — skip (materializing a contact is expensive).
      } catch(err) {
        console.warn(tag, 'apply failed for', id, err);
      }
    }
  };

  return {read, apply};
}

export const CONTACTS_SYNC_D_TAG = 'phantomchat.chat/contacts';
export const CONTACTS_SYNC_VERSION = 1;
export {peerFromConversationId as _peerFromConversationId};
