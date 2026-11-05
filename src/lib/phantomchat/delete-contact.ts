/**
 * Delete a P2P contact: the ONE path behind every delete button (the Contacts
 * list context menu and Delete contact in the Edit pane).
 *
 *  1. forget it on this PC (provider-contacts.deleteP2PContact): revoke its
 *     Local tools grant, delete a Provider contact's persona (nsec, vault,
 *     config, memory, history) and its prefs, then the conversation, the
 *     mapping and a durable delete row;
 *  2. drop it from the cached contact list, which every open list renders;
 *  3. publish the delete to contacts-sync at once; once it lands, the
 *     publisher nudges my other devices to reconcile (sync-nudge.ts).
 *
 * A Provider persona lives only on the PC that created it. Deleted from
 * another device, the delete reaches that PC through sync, and
 * {@link forgetSyncedDelete} finishes the wipe there.
 */
import {deleteP2PContact, forgetContact, type BridgeCall} from './provider-contacts';

export type DeleteContactOutcome = 'deleted' | 'unresolved' | 'not_ready';

export interface DeleteContactDeps {
  getPubkey(peerId: number): Promise<string | null | undefined>;
  chatAPI(): {deleteConversation(pubkey: string): Promise<unknown>} | null | undefined;
  bridgeCall(): BridgeCall | undefined;
  dropFromContactList(peerId: number): Promise<void>;
  publishContacts(): void;
  dropDialog(peerId: number): void;
}

/** Throws when a step that must not be skipped fails (see forgetContact); nothing is reported as deleted then. */
export async function deleteContact(peerId: number, deps?: DeleteContactDeps): Promise<DeleteContactOutcome> {
  const d = deps ?? await defaultDeps();
  const pubkey = await d.getPubkey(peerId);
  if(!pubkey) return 'unresolved';
  const chatAPI = d.chatAPI();
  if(!chatAPI?.deleteConversation) return 'not_ready';

  await deleteP2PContact(pubkey, chatAPI, d.bridgeCall());
  // The data is gone from here on: whatever fails below only delays what the
  // UI shows, so it must not turn a done delete into "failed".
  try {
    await d.dropFromContactList(peerId);
  } catch(err) {
    console.warn('[delete-contact] contact list drop failed', err);
  }
  d.publishContacts();
  d.dropDialog(peerId);
  return 'deleted';
}

/**
 * A delete learned from contacts-sync (another of my devices deleted it). The
 * sync adapter already removed the mapping and the conversation; this does the
 * rest on this PC: Local tools grant, a Provider persona and the prefs, and the
 * cached contact list. Best effort: a failure is logged and the next reconcile
 * retries it ({@link sweepDeletedContactLeftovers}).
 */
export async function forgetSyncedDelete(pubkey: string, peerId: number | undefined, deps?: Pick<DeleteContactDeps, 'bridgeCall' | 'dropFromContactList'>): Promise<void> {
  const d = deps ?? await defaultDeps();
  try {
    await forgetContact(pubkey, d.bridgeCall());
  } catch(err) {
    console.warn('[delete-contact] synced delete: local cleanup failed', pubkey.slice(0, 8), err);
  }
  if(peerId) {
    try {
      await d.dropFromContactList(peerId);
    } catch(err) {
      console.warn('[delete-contact] synced delete: contact list drop failed', err);
    }
  }
}

async function defaultDeps(): Promise<DeleteContactDeps> {
  const [{getPubkey}, {schedulePublish}, rootScope] = await Promise.all([
    import('./virtual-peers-db'),
    import('./phantomchat-sync-triggers'),
    import('@lib/rootScope').then((m) => m.default)
  ]);
  return {
    getPubkey: (peerId) => getPubkey(peerId),
    chatAPI: () => (window as any).__phantomchatChatAPI,
    bridgeCall: () => (window as any).phantomchatDesktop?.phantombot?.call,
    dropFromContactList: (peerId) => rootScope.managers.appUsersManager.dropP2PContact(peerId as UserId),
    publishContacts: () => schedulePublish('contacts'),
    dropDialog: (peerId) => rootScope.dispatchEvent('dialog_drop', {peerId: peerId.toPeerId(false)} as any)
  };
}

export interface LeftoverSweepDeps {
  listDeletedPeers(): Promise<Array<{pubkey: string; deletedAt: number}>>;
  hasMapping(pubkey: string): Promise<boolean>;
  getPrefs(pubkey: string): Promise<{updatedAt?: number} | undefined>;
  forget(pubkey: string): Promise<void>;
}

/**
 * Retry for {@link forgetSyncedDelete}: a deleted contact (durable delete row,
 * no mapping) whose prefs are still here had its local cleanup fail, e.g. the
 * engine was not up yet. Prefs written after the delete belong to a re-add in
 * progress and are left alone. Returns how many were cleaned.
 */
export async function sweepDeletedContactLeftovers(deps: LeftoverSweepDeps): Promise<number> {
  let cleaned = 0;
  for(const d of await deps.listDeletedPeers()) {
    try {
      const prefs = await deps.getPrefs(d.pubkey);
      if(!prefs) continue;
      if((prefs.updatedAt ?? 0) > d.deletedAt * 1000) continue;
      if(await deps.hasMapping(d.pubkey)) continue;
      await deps.forget(d.pubkey);
      cleaned++;
    } catch(err) {
      console.warn('[delete-contact] leftover sweep failed for', d.pubkey.slice(0, 8), err);
    }
  }
  return cleaned;
}
