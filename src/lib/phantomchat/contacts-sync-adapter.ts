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
 * (nowSeconds). But the two local sources speak
 * different units: a contact mapping's `updatedAt` is **millis** (Date.now()),
 * while a conversation tombstone's `deletedAt` is **seconds**. If we fed those
 * raw into the same CRDT, every live entry (~1.7e12) would tower over every
 * tombstone (~1.7e9) and a delete could never beat an add. So both are
 * normalised to seconds here, and restored back to millis on apply.
 *
 * TOMBSTONES ARE LOGGED, AND ALSO DERIVED (#173).
 * A contact delete writes a DURABLE `{pubkey, deletedAt}` row
 * (virtual-peers-db `deleted` store) on top of removing the mapping and writing
 * the per-conversation deletion watermark. The durable row is the source of
 * truth; the watermark is still read so deletes made by older builds keep being
 * honoured.
 *
 * Deriving alone was the resurrection bug: `apply()` materializes via
 * addP2PContact, which cleared the watermark — after which the device exported
 * neither a live entry nor a tombstone, and in a union merge ABSENCE SAYS
 * NOTHING, so one stale relay blob re-added the contact everywhere, forever. A
 * delete has to be a positive fact that can always be re-published.
 *
 * read() also TEARS DOWN a live mapping that loses the LWW compare against a
 * durable delete row (a resurrection): the engine skips apply() when the merge
 * is a no-op, so without this the resurrected contact would sit in the mapping
 * store forever. Watermark-sourced deletes never tear down (a watermark under a
 * live mapping may be "cleared history", not a contact delete).
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
  /** Durable deletion log (unix SECONDS). Independent of the own pubkey. */
  listDeletedPeers: () => Promise<Array<{pubkey: string; deletedAt: number}>>;
  /** Persist a delete learned from another device, so THIS device can
   * re-publish it later even if its watermark is lost. */
  recordDeletedPeer: (pubkey: string, deletedAtSeconds: number) => Promise<void>;
  /** Drop the durable delete — only when a remote LIVE entry legitimately wins
   * the LWW compare (another device deliberately re-added the contact). */
  clearDeletedPeer: (pubkey: string) => Promise<void>;
  conversationId: (a: string, b: string) => string;
  /** Full materialize path (addP2PContact) — Worker inject + mirrors + dialog. */
  addContact: (pubkey: string, displayName?: string) => Promise<void>;
  setDisplayName: (pubkey: string, displayName: string) => Promise<void>;
  /** Pin updatedAt (millis) so a restore doesn't out-timestamp the remote. */
  setUpdatedAt: (pubkey: string, updatedAtMillis: number) => Promise<void>;
  /**
   * Persist a deliberate-add stamp (unix SECONDS on the wire; the adapter
   * converts to millis — the mapping store's unit) learned from a remote
   * entry (#180). Monotonic at the store layer: only moves forward.
   */
  setDeliberateAddAt: (pubkey: string, deliberateAddAtSeconds: number) => Promise<void>;
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
        },
        // The user-intent proof (#180). Absent for mappings that pre-date the
        // stamp or were created by automatic paths — which is exactly the
        // conservative answer: unproven intent must not clear a durable delete.
        ...(m.deliberateAddAt ? {deliberateAddAt: Math.floor(m.deliberateAddAt / 1000)} : {})
      };
    }

    // Deletions: the durable log first (no own-pubkey needed, survives a wiped
    // watermark), then the legacy derived watermarks. Latest stamp per peer wins.
    // The two sources are NOT equivalent: a durable row is positive delete
    // evidence (#173), while a watermark under a LIVE mapping may just be
    // "cleared history" — so watermarks only contribute for peers with no live
    // mapping, and only durable rows may tear a resurrected mapping down.
    const deletes = new Map<string, number>();
    for(const d of await deps.listDeletedPeers()) {
      if(!HEX64.test(d.pubkey) || !(d.deletedAt > 0)) continue;
      deletes.set(d.pubkey, Math.max(deletes.get(d.pubkey) ?? 0, d.deletedAt));
    }

    const own = deps.getOwnPubkey();
    if(own) {
      const tombstones = await deps.listTombstones();
      for(const t of tombstones) {
        const peer = peerFromConversationId(t.conversationId, own);
        if(!peer) continue;
        // A watermark is only evidence of a CONTACT delete when the mapping is
        // gone — with a live mapping it may just be "cleared history".
        if(live.has(peer)) continue;
        deletes.set(peer, Math.max(deletes.get(peer) ?? 0, t.deletedAt));
      }
    }

    for(const [peer, deletedAt] of deletes) {
      const liveEntry = map[peer];
      // A live mapping clears the durable delete ONLY when its deliberate-add
      // stamp is strictly NEWER than the delete (#180) — the user re-added the
      // contact after deleting it. A plain newer `updatedAt` no longer counts:
      // automatic paths (profile refresh, message-path persistence, stale
      // pre-#180 clients) mint current timestamps without intent, and letting
      // those win re-armed the resurrection loop. A live peer's delete stamp is
      // always durable-sourced here (watermarks are skipped under a live
      // mapping above — cleared-history rule), so the row being cleared IS the
      // durable row the re-add outranks. Strict compare: seconds-floored stamps
      // make equality ambiguous, and ambiguity resolves against resurrection.
      if(
        liveEntry &&
        typeof liveEntry.deliberateAddAt === 'number' &&
        liveEntry.deliberateAddAt > deletedAt
      ) {
        try {
          await deps.clearDeletedPeer(peer);
        } catch(err) {
          console.warn(tag, 'read: clearing durable delete for deliberate re-add failed', peer, err);
        }
        continue;
      }
      // A mapping without a deliberate-add proof is a resurrection: drop it
      // from the mapping store, not just from the published map. The engine
      // skips apply() when merged == local, and wasLive is false there anyway,
      // so apply() could never clean this up (the gap Robert flagged on the
      // groups adapter; the durable delete row itself stays, untouched).
      // Watermark-sourced deletes never reach this branch with a live mapping
      // (skipped above) — the cleared-history rule is preserved.
      if(liveEntry) {
        try {
          await deps.removeContact(peer);
        } catch(err) {
          console.warn(tag, 'read: teardown of resurrected contact failed', peer, err);
        }
      }
      map[peer] = {id: peer, updatedAt: deletedAt, deleted: true};
    }

    return map;
  };

  const apply = async(merged: SyncMap<ContactSyncData>, before: SyncMap<ContactSyncData>): Promise<void> => {
    // Store reality at entry: `before` can mark an id `deleted` (read() overrode
    // a resurrected mapping) while the mapping still sits in the store, so
    // wasLive alone can't tell "already torn down" from "resurrected".
    let storeState: Map<string, VirtualPeerMapping> | null = null;
    try {
      const mappings = await deps.listMappings();
      storeState = new Map(mappings.map((m) => [m.pubkey, m]));
    } catch(err) {
      console.warn(tag, 'apply: store snapshot failed; falling back to map-derived teardown', err);
      storeState = null;
    }

    for(const id of Object.keys(merged)) {
      const entry = merged[id];
      const prev = before[id];
      const wasLive = !!prev && !prev.deleted;

      try {
        if(entry.deleted) {
          // Persist the delete durably even when this device had nothing live:
          // a delete learned from another device must be re-publishable from
          // here too, otherwise this device contributes only an ABSENCE and a
          // stale blob elsewhere can revive the contact again (#173).
          await deps.recordDeletedPeer(id, entry.updatedAt);
          // Tear down whenever the mapping store still holds the record — even
          // when wasLive is false (read() had already overridden a resurrected
          // mapping with the delete, so the map lost the evidence).
          const stillStored = storeState ? storeState.has(id) : wasLive;
          if(stillStored) {
            await deps.removeContact(id);
            const own = deps.getOwnPubkey();
            if(own) await deps.setTombstone(deps.conversationId(own, id), entry.updatedAt);
          }
          continue;
        }

        // entry is live
        if(!wasLive) {
          // The merge already compared this live entry against our delete (it is
          // in `before`), so reaching here means a DELIBERATE re-add won — only
          // a deliberateAddAt stamp can clear a delete now (#180). Drop the
          // durable row so the guards let it through — nothing else is allowed
          // to clear it.
          if(prev?.deleted) await deps.clearDeletedPeer(id);
          // New or resurrected contact — full materialize, then pin timestamp.
          // (The stamp, when present, is persisted by the shared block below.)
          await deps.addContact(id, entry.data?.displayName);
          await deps.setUpdatedAt(id, entry.updatedAt * 1000);
        } else if(entry.updatedAt > prev.updatedAt) {
          // Remote had a newer mutation (rename / profile). Apply the name if
          // it changed, then pin the timestamp so we converge.
          const name = entry.data?.displayName;
          if(name && name !== prev.data?.displayName) await deps.setDisplayName(id, name);
          await deps.setUpdatedAt(id, entry.updatedAt * 1000);
        }
        // Persist a stamp that advanced without an updatedAt advance (a
        // live/live merge forwards the max stamp onto the winner): the local
        // store must carry the proof, or this device's next read() exports an
        // unstamped entry and loses a later tombstone compare it should win.
        if(typeof entry.deliberateAddAt === 'number') {
          const localMs = storeState?.get(id)?.deliberateAddAt;
          const stampSec = Math.floor((localMs ?? 0) / 1000);
          if(entry.deliberateAddAt > stampSec) {
            await deps.setDeliberateAddAt(id, entry.deliberateAddAt);
          }
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
/** v2 (#180): entries may carry `deliberateAddAt`; a fresh `updatedAt` alone
 * no longer clears a durable delete. v1 snapshots are still read (see
 * CrdtSyncDeps.acceptedVersions) and republished at v2. */
export const CONTACTS_SYNC_VERSION = 2;
export const CONTACTS_SYNC_ACCEPTED_VERSIONS = [1, CONTACTS_SYNC_VERSION];
export {peerFromConversationId as _peerFromConversationId};
