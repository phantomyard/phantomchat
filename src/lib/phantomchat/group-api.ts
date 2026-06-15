/**
 * GroupAPI - Group lifecycle operations: create, send, receive, manage members
 *
 * Connects the group data layer (Plan 01) to the messaging and display pipeline.
 * Handles group creation, message send/receive, member management (add/remove/leave),
 * and self-send dedup (Pitfall 7).
 *
 * All outbound messages use wrapGroupMessage (N+1 gift-wraps) and broadcastGroupControl
 * for lifecycle events.
 */

import {Logger, logger} from '@lib/logger';
import rootScope from '@lib/rootScope';
import {getGroupStore} from './group-store';
import {groupIdToPeerId} from './group-types';
import {wrapGroupMessage} from './nostr-crypto';
import {broadcastGroupControl} from './group-control-messages';
import {writeGroupCreateServiceMessage} from './group-service-messages';
import {GroupDeliveryTracker} from './group-delivery-tracker';
import {handleGroupIncoming, handleGroupOutgoing, applyGroupEdit, applyGroupReaction, cleanupGroupChatInjection, ensureGroupChatInjected, injectGroupCreateDialog, type GroupDispatchFn} from './phantomchat-groups-sync';
import {getMessageStore} from './message-store';
import type {GroupStore} from './group-store';
import type {GroupRecord, GroupControlPayload} from './group-types';
import type {NTNostrEvent} from './nostr-crypto';

// ─── Types ────────────────────────────────────────────────────────

export type GroupMessageCallback = (groupId: string, rumor: any, senderPubkey: string) => void;

/** Result of a successful group send — exposes the pieces VMT needs to
 *  produce a deterministic tweb mid for the Worker's post-send bookkeeping. */
export interface GroupSendResult {
  messageId: string;
  rumorId: string;
  timestampMs: number;
}

/** Optional knobs accepted by `GroupAPI.sendMessage`. Kept separate so the
 *  positional signature stays stable for existing callers (unit tests etc.). */
export interface GroupSendOptions {
  /** rumor id of the message being replied to (= original row's eventId).
   *  When set, the rumor JSON carries `replyToRumorId` so receivers can
   *  resolve the reply chain locally. */
  replyToRumorId?: string;
  type?: string;
}

/** Lightweight secp256k1-shape gate used by GroupAPI.addMember / createGroup
 *  before we mutate the local store. Anything that fails this regex would
 *  later throw in nostr-tools' `pointFromBytes` once we go to wrap, which
 *  would leave the local record diverging from peers (see FIND-fcfcdec0
 *  bug #4). 64-char lowercase hex is the canonical NIP-01 form. */
const SECP_PUBKEY_HEX_RE = /^[0-9a-f]{64}$/;

// ─── GroupAPI ─────────────────────────────────────────────────────

export class GroupAPI {
  private store: GroupStore;
  private ownPubkey: string;
  private ownSk: Uint8Array;
  private publishFn: (events: NTNostrEvent[]) => Promise<void>;
  private dispatch: GroupDispatchFn;
  private groupDelivery: GroupDeliveryTracker;
  private sentMessageIds: Set<string> = new Set();
  private log: Logger;

  /** Optional test hook for incoming group messages. Production render is
   *  wired via direct import of `handleGroupIncoming`; this callback is only
   *  consulted by unit tests that need to observe dispatch without spinning
   *  up the full IndexedDB + rootScope pipeline. */
  onGroupMessage: GroupMessageCallback | null = null;

  constructor(
    ownPubkey: string,
    ownSk: Uint8Array,
    publishFn: (events: NTNostrEvent[]) => Promise<void>,
    dispatch?: GroupDispatchFn
  ) {
    this.ownPubkey = ownPubkey;
    this.ownSk = ownSk;
    this.publishFn = publishFn;
    // Default dispatch is a no-op for unit tests that don't wire rootScope.
    this.dispatch = dispatch ?? (() => {});
    this.store = getGroupStore();
    this.groupDelivery = new GroupDeliveryTracker();
    this.log = logger('GroupAPI');
  }

  // ─── Group lifecycle ──────────────────────────────────────────

  /**
   * Create a new group.
   *
   * 1. Generate groupId via crypto.randomUUID
   * 2. Compute peerId via groupIdToPeerId
   * 3. Store GroupRecord with adminPubkey = ownPubkey
   * 4. Broadcast group_create control to all members + self
   * 5. Return groupId
   */
  async createGroup(name: string, memberPubkeys: string[], description?: string): Promise<string> {
    // Validate member pubkeys BEFORE we touch the local store. Earlier the
    // store was written first and the broadcast wrap exploded on the first
    // malformed pubkey (`pointFromBytes: bad point`), leaving an orphan
    // group on the creator that never reached any peer (FIND-fcfcdec0 #4).
    for(const pk of memberPubkeys) {
      if(typeof pk !== 'string' || !SECP_PUBKEY_HEX_RE.test(pk)) {
        throw new Error(`createGroup: invalid member pubkey ${pk?.slice?.(0, 8)}… (must be 64-char lowercase hex)`);
      }
    }

    const groupId = crypto.randomUUID().split('-').join('');
    const peerId = await groupIdToPeerId(groupId);

    const record: GroupRecord = {
      groupId,
      name,
      description,
      adminPubkey: this.ownPubkey,
      members: [...memberPubkeys, this.ownPubkey],
      peerId,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    // Build the broadcast wraps FIRST. nostr-tools' pointFromBytes throws
    // here if any of the supplied pubkeys is syntactically hex but not on
    // the secp256k1 curve, so failing now keeps the local store free of
    // the orphan group record that previous versions persisted (FIND-fcfcdec0
    // #4). The regex gate at the top of this method catches non-hex inputs;
    // this catches the curve-shape rejections.
    const payload: GroupControlPayload = {
      type: 'group_create',
      groupId,
      groupName: name,
      groupDescription: description,
      memberPubkeys: record.members,
      adminPubkey: this.ownPubkey
    };

    let controlWraps;
    try {
      controlWraps = broadcastGroupControl(this.ownSk, memberPubkeys, payload);
    } catch(err) {
      this.log.warn('[GroupAPI] createGroup: broadcastGroupControl threw before local mutation:', err);
      throw err;
    }

    await this.store.save(record);

    // Seed a synthetic service row so tweb's dialog validation sees a real
    // top_message for the group. The row is local-only (never transmitted).
    const createdAtSec = Math.floor(record.createdAt / 1000);
    let serviceMid: number | null = null;
    try {
      const service = await writeGroupCreateServiceMessage({
        groupId,
        peerId,
        timestamp: createdAtSec,
        adminPubkey: this.ownPubkey,
        title: name,
        isOutgoing: true
      });
      serviceMid = service.mid;
    } catch(err) {
      this.log.warn('[GroupAPI] failed to seed chatCreate service row (creator):', err);
    }

    // Materialise the group in main-thread mirrors + chat list immediately,
    // before any real message is sent. Without this the group is invisible
    // until the first send hits `handleGroupOutgoing`.
    if(serviceMid !== null) {
      try {
        await injectGroupCreateDialog(groupId, serviceMid, createdAtSec);
      } catch(err) {
        this.log.warn('[GroupAPI] injectGroupCreateDialog (creator) failed:', err);
      }
    }

    try {
      await this.publishFn(controlWraps);
    } catch(err) {
      // Publish failed: roll back the local group so creator and peers stay
      // converged. The synthetic service row + mirror entries are best-effort
      // cleaned up via cleanupGroupChatInjection.
      this.log.warn('[GroupAPI] createGroup: publish failed, rolling back local state:', err);
      try {
        await this.store.delete(groupId);
      } catch{}
      try {
        await cleanupGroupChatInjection(peerId);
      } catch{}
      throw err;
    }

    this.log('[GroupAPI] group created:', groupId, name);
    return groupId;
  }

  // ─── Messaging ────────────────────────────────────────────────

  /**
   * Send a message to all members of a group.
   *
   * 1. Get group from store
   * 2. Call wrapGroupMessage(sk, members, content, groupId)
   * 3. Publish all wraps in parallel (Pitfall 1)
   * 4. Track message ID in sentMessageIds for dedup
   * 5. Init group delivery tracking for all members
   * 6. Return {messageId, rumorId, timestampMs} so VMT's sendMessage
   *    branch can derive the real mid deterministically.
   */
  async sendMessage(groupId: string, content: string, typeOrOptions?: string | GroupSendOptions): Promise<GroupSendResult> {
    const group = await this.store.get(groupId);
    if(!group) throw new Error(`Group not found: ${groupId}`);

    // Membership gate (FIND-01e78a01 #1 send-side): a user who left or was
    // kicked must not be able to keep posting into the group. Previously
    // GroupAPI.leaveGroup deleted the store record (so this branch threw
    // "Group not found") but a stale GroupAPI instance from a prior render
    // could still hold the record in memory and publish wraps. Explicit
    // membership check before any publish.
    if(!group.members.includes(this.ownPubkey)) {
      throw new Error(`sendMessage: not a member of group ${groupId.slice(0, 8)}`);
    }

    // Normalize the optional 3rd arg. Older callers pass a plain `type`
    // string; the new shape is an options object that also carries a
    // reply target. Both are kept supported to avoid churning unit tests.
    const opts: GroupSendOptions = typeof typeOrOptions === 'string' ?
      {type: typeOrOptions} :
      (typeOrOptions || {});
    const msgType = opts.type || 'text';
    const replyToRumorId = opts.replyToRumorId;

    // Pin a single timestamp for the whole send so the payload, handler and
    // any downstream mid derivation all agree. Anchoring via `Date.now()`
    // twice (once in the JSON, once in a local var) risks drifting by 1 ms
    // across the JSON.stringify boundary in heavy-GC environments.
    const timestampMs = Date.now();
    const messageId = `grp-${timestampMs}-${Math.random().toString(36).slice(2, 8)}`;

    // Build message payload. The `replyToRumorId` field lets receivers
    // resolve the parent's local row to a mid for the visual reply preview
    // — symmetric to NIP-10 `['e', ...]` on DMs. Closes FIND-fcfcdec0 #3.
    const payloadObj: any = {
      content,
      type: msgType,
      id: messageId,
      timestamp: timestampMs
    };
    if(replyToRumorId) payloadObj.replyToRumorId = replyToRumorId;
    const messagePayload = JSON.stringify(payloadObj);

    // Get members excluding self for wrapping (wrapGroupMessage adds self-send)
    const otherMembers = group.members.filter(m => m !== this.ownPubkey);

    const {wraps, rumorId} = wrapGroupMessage(this.ownSk, otherMembers, messagePayload, groupId);

    // Track for self-send dedup (Pitfall 7)
    this.sentMessageIds.add(messageId);

    // Init delivery tracking for other members
    this.groupDelivery.initMessage(messageId, groupId, otherMembers);

    // Optimistic sender-side render: persist the outgoing row + dispatch
    // history_append + dialogs_multiupdate so the bubble appears immediately,
    // mirroring appMessagesManager.sendText's flow for DMs. Runs BEFORE
    // publish so the bubble is visible even if the relay is slow/unreachable.
    try {
      await handleGroupOutgoing(
        this.ownPubkey,
        {groupId, messageId, rumorId, content, timestamp: timestampMs, type: msgType, replyToRumorId},
        this.dispatch
      );
    } catch(err) {
      this.log.warn('[GroupAPI] handleGroupOutgoing threw:', err);
    }

    // Publish all wraps
    await this.publishFn(wraps);

    this.log('[GroupAPI] message sent to group:', groupId, 'id:', messageId, 'rumorId:', rumorId.slice(0, 8));
    return {messageId, rumorId, timestampMs};
  }

  /**
   * Send a file/media message to a group. Symmetric to sendMessage but
   * carries an encrypted-Blossom payload reference instead of plaintext.
   *
   * The fileMetadata object is exactly what the receiver needs to fetch
   * and decrypt — url, sha256, keyHex, ivHex, mimeType, size, and optional
   * dimensions / duration / waveform. The receiver dispatches a 'file'
   * type rumor in `phantomchat-groups-sync.handleGroupIncoming` and renders
   * via the bubble's media slot.
   */
  async sendFile(
    groupId: string,
    fileType: 'image' | 'video' | 'file' | 'voice',
    fileMetadata: {
      url: string;
      sha256: string;
      keyHex: string;
      ivHex: string;
      mimeType: string;
      size: number;
      width?: number;
      height?: number;
      duration?: number;
      waveform?: string;
    },
    caption: string = ''
  ): Promise<GroupSendResult> {
    const group = await this.store.get(groupId);
    if(!group) throw new Error(`Group not found: ${groupId}`);
    if(!group.members.includes(this.ownPubkey)) {
      throw new Error(`sendFile: not a member of group ${groupId.slice(0, 8)}`);
    }

    const timestampMs = Date.now();
    const messageId = `grp-${timestampMs}-${Math.random().toString(36).slice(2, 8)}`;

    const messagePayload = JSON.stringify({
      content: caption,
      type: fileType,
      id: messageId,
      timestamp: timestampMs,
      fileMetadata
    });

    const otherMembers = group.members.filter(m => m !== this.ownPubkey);
    const {wraps, rumorId} = wrapGroupMessage(this.ownSk, otherMembers, messagePayload, groupId);

    this.sentMessageIds.add(messageId);
    this.groupDelivery.initMessage(messageId, groupId, otherMembers);

    // Optimistic sender-side render is the caller's responsibility — VMT
    // .phantomchatSendFile already injected the bubble with `media: {…uploading: true}`
    // and saved the IDB row before this method runs. We only handle the
    // broadcast leg here. Receivers go through `handleGroupIncoming` which
    // reads `fileMetadata` from the parsed rumor and renders the media bubble.
    await this.publishFn(wraps);

    this.log('[GroupAPI] file sent to group:', groupId, 'id:', messageId, 'rumorId:', rumorId.slice(0, 8), 'fileType:', fileType);
    return {messageId, rumorId, timestampMs};
  }

  /**
   * Edit a previously-sent group message.
   *
   * @param groupId         - group the message lives in
   * @param targetRumorId   - rumor id of the original message (= message-store eventId)
   * @param newText         - replacement content
   *
   * 1. Resolve the original local row by eventId. Verify ownership + group.
   * 2. Update local store + main-thread mirror + dispatch `message_edit` so
   *    the sender sees the change before the broadcast completes.
   * 3. Broadcast `group_edit_message` control payload to all members + self
   *    (multi-device echo). Receivers run the same `applyGroupEdit` path.
   */
  async editMessage(groupId: string, targetRumorId: string, newText: string): Promise<void> {
    const group = await this.store.get(groupId);
    if(!group) throw new Error(`Group not found: ${groupId}`);

    // Verify the original belongs to us before broadcasting an edit.
    const store = getMessageStore();
    const original = await store.getByEventId(targetRumorId);
    if(!original) throw new Error(`editMessage: original rumor not in store: ${targetRumorId.slice(0, 8)}`);
    if(original.conversationId !== `group:${groupId}`) {
      throw new Error(`editMessage: original belongs to a different conversation`);
    }
    if(original.senderPubkey !== this.ownPubkey) {
      throw new Error(`editMessage: refusing to edit non-own message`);
    }

    const editedAt = Math.floor(Date.now() / 1000);

    // Update local first so the sender's bubble re-renders without waiting
    // for the relay echo (mirrors ChatAPI.editMessage's DM behavior).
    try {
      await applyGroupEdit(groupId, targetRumorId, newText, editedAt, this.ownPubkey);
    } catch(err) {
      this.log.warn('[GroupAPI] editMessage: local apply failed (continuing to broadcast):', err);
    }

    // Broadcast to all members + self. Self-send is required so multi-device
    // recipients pick up the edit too (mirroring broadcastGroupControl
    // semantics for create/leave/etc).
    const payload: GroupControlPayload = {
      type: 'group_edit_message',
      groupId,
      targetEventId: targetRumorId,
      newText,
      editedAt
    };
    const otherMembers = group.members.filter(m => m !== this.ownPubkey);
    const controlWraps = broadcastGroupControl(this.ownSk, otherMembers, payload);
    await this.publishFn(controlWraps);

    this.log('[GroupAPI] message edited:', groupId, targetRumorId.slice(0, 8));
  }

  /**
   * WU-2: react to a group message. Unlike editMessage there is no
   * own-author restriction — any member may react to any message.
   * Applies locally (optimistic) then broadcasts a group_reaction control
   * payload to all other members so the reaction reaches everyone, not just
   * the reacted-to author (the kind-7 path tagged only the author, whose
   * pubkey is unresolvable from the hash-based group peerId).
   */
  async reactToMessage(groupId: string, targetRumorId: string, emoji: string): Promise<void> {
    const group = await this.store.get(groupId);
    if(!group) throw new Error(`Group not found: ${groupId}`);
    if(!emoji) return;

    const createdAt = Math.floor(Date.now() / 1000);

    // Local-first so the reactor's own bubble updates without waiting for the
    // relay echo (mirrors editMessage's optimistic apply).
    try {
      await applyGroupReaction(groupId, targetRumorId, emoji, this.ownPubkey, createdAt);
    } catch(err) {
      this.log.warn('[GroupAPI] reactToMessage: local apply failed (continuing to broadcast):', err);
    }

    // Broadcast to all other members so the reaction reaches everyone — the
    // kind-7 path only tagged the reacted-to author, whose pubkey is
    // unresolvable from the hash-based group peerId.
    const payload: GroupControlPayload = {
      type: 'group_reaction',
      groupId,
      targetEventId: targetRumorId,
      emoji,
      createdAt
    };
    const otherMembers = group.members.filter(m => m !== this.ownPubkey);
    const controlWraps = broadcastGroupControl(this.ownSk, otherMembers, payload);
    await this.publishFn(controlWraps);

    this.log('[GroupAPI] reaction sent:', groupId, emoji, targetRumorId.slice(0, 8));
  }

  // ─── Member management ────────────────────────────────────────

  /**
   * Add a member to the group.
   * Only admin can add members.
   */
  async addMember(groupId: string, newMemberPubkey: string): Promise<void> {
    const group = await this.store.get(groupId);
    if(!group) throw new Error(`Group not found: ${groupId}`);
    if(group.adminPubkey !== this.ownPubkey) throw new Error('Only admin can add members');

    // Validate BEFORE local mutation: pointFromBytes will reject anything
    // that's syntactically hex but not on the secp256k1 curve, leaving a
    // local member that never reached peers (FIND-fcfcdec0 #4). A regex
    // gate catches the obvious "looks-hex-but-isn't-a-point" inputs and
    // a try/wrap around the broadcast catches the curve-shape rejections
    // with a transactional rollback.
    if(typeof newMemberPubkey !== 'string' || !SECP_PUBKEY_HEX_RE.test(newMemberPubkey)) {
      throw new Error(`addMember: invalid pubkey ${newMemberPubkey?.slice?.(0, 8)}… (must be 64-char lowercase hex)`);
    }
    if(group.members.includes(newMemberPubkey)) {
      // Idempotent: re-adding an existing member is a no-op rather than
      // a duplicate-broadcast that confuses peers' membership state.
      this.log('[GroupAPI] addMember: pubkey already a member, skipping:', newMemberPubkey.slice(0, 8));
      return;
    }

    const updatedMembers = [...group.members, newMemberPubkey];

    const payload: GroupControlPayload = {
      type: 'group_add_member',
      groupId,
      targetPubkey: newMemberPubkey,
      memberPubkeys: updatedMembers,
      groupName: group.name
    };

    // Build wraps FIRST so a malformed curve-shape pubkey throws before we
    // touch the store. This + the regex gate above closes FIND-fcfcdec0 #4
    // (orphan member persisted on admin after broadcast failure).
    let controlWraps;
    try {
      controlWraps = broadcastGroupControl(this.ownSk, updatedMembers, payload);
    } catch(err) {
      this.log.warn('[GroupAPI] addMember: broadcastGroupControl threw before local mutation:', err);
      throw err;
    }

    // Local store update happens only after wraps were built successfully.
    // If the publish fails downstream (offline relay etc.) the local row is
    // still consistent with the wraps we'll re-send on next online flush.
    await this.store.updateMembers(groupId, updatedMembers);

    try {
      await this.publishFn(controlWraps);
    } catch(err) {
      // Roll the local membership back so admin's view re-converges with
      // peers' on the next list refresh.
      try {
        await this.store.updateMembers(groupId, group.members);
      } catch(rollbackErr) {
        this.log.warn('[GroupAPI] addMember: rollback failed:', rollbackErr);
      }
      throw err;
    }

    this.log('[GroupAPI] member added to group:', groupId, newMemberPubkey.slice(0, 8));
  }

  /**
   * Remove a member from the group.
   * Only admin can remove members.
   */
  async removeMember(groupId: string, memberPubkey: string): Promise<void> {
    const group = await this.store.get(groupId);
    if(!group) throw new Error(`Group not found: ${groupId}`);
    if(group.adminPubkey !== this.ownPubkey) throw new Error('Only admin can remove members');

    // Symmetric to addMember: shape-validate the pubkey BEFORE we mutate the
    // store so a typo or invalid input throws instead of silently doing
    // nothing. Previously a malformed pubkey was a no-op (filter found no
    // match → unchanged members) which the explorer surfaced as an
    // "asymmetry with addMember" anti-bug (FIND-3ce67f93 carryforward).
    if(typeof memberPubkey !== 'string' || !SECP_PUBKEY_HEX_RE.test(memberPubkey)) {
      throw new Error(`removeMember: invalid pubkey ${memberPubkey?.slice?.(0, 8)}… (must be 64-char lowercase hex)`);
    }
    if(!group.members.includes(memberPubkey)) {
      throw new Error(`removeMember: pubkey ${memberPubkey.slice(0, 8)}… is not a member of ${groupId.slice(0, 8)}`);
    }

    const remaining = group.members.filter(m => m !== memberPubkey);
    await this.store.updateMembers(groupId, remaining);

    const payload: GroupControlPayload = {
      type: 'group_remove_member',
      groupId,
      targetPubkey: memberPubkey
    };

    // Broadcast to REMAINING members only
    const controlWraps = broadcastGroupControl(this.ownSk, remaining, payload);
    await this.publishFn(controlWraps);

    this.log('[GroupAPI] member removed from group:', groupId, memberPubkey.slice(0, 8));
  }

  /**
   * Update group info (name, description, avatar). Only admin can rename.
   *
   * 1. Update local store record
   * 2. Broadcast group_info_update control to all members + self
   * 3. Refresh main-thread mirror so the chat-list + topbar pick up the
   *    new title immediately
   */
  async updateGroupInfo(
    groupId: string,
    info: {name?: string; description?: string; avatar?: string}
  ): Promise<void> {
    const group = await this.store.get(groupId);
    if(!group) throw new Error(`Group not found: ${groupId}`);
    if(group.adminPubkey !== this.ownPubkey) throw new Error('Only admin can update group info');

    if(info.name !== undefined && (typeof info.name !== 'string' || info.name.length === 0)) {
      throw new Error('updateGroupInfo: name must be a non-empty string');
    }

    const payload: GroupControlPayload = {
      type: 'group_info_update',
      groupId,
      groupName: info.name,
      groupDescription: info.description,
      groupAvatar: info.avatar
    };

    // Build wraps before mutating local store so any crypto-shape rejection
    // on member pubkeys throws cleanly without leaving a drifted record.
    const allMembers = group.members;
    let controlWraps;
    try {
      controlWraps = broadcastGroupControl(this.ownSk, allMembers.filter(m => m !== this.ownPubkey), payload);
    } catch(err) {
      this.log.warn('[GroupAPI] updateGroupInfo: broadcastGroupControl threw before local mutation:', err);
      throw err;
    }

    // Apply locally first so admin's UI updates immediately even before
    // the publish completes.
    await this.store.updateInfo(groupId, info);

    // Refresh main-thread mirror so subscribers (chat-list, topbar) see the
    // new title on the next render pass — same path ensureGroupChatInjected
    // uses, kept idempotent.
    try {
      const peerId = group.peerId;
      await ensureGroupChatInjected(groupId, peerId);
    } catch(err) {
      this.log.warn('[GroupAPI] updateGroupInfo: mirror refresh non-critical:', err);
    }

    try {
      await this.publishFn(controlWraps);
    } catch(err) {
      this.log.warn('[GroupAPI] updateGroupInfo: publish failed (local change retained):', err);
      throw err;
    }

    this.log('[GroupAPI] info updated:', groupId, info);
  }

  /**
   * Convenience: rename a group. Routes through updateGroupInfo. Symmetric
   * to appChatsManager.editTitle's intent.
   */
  async renameGroup(groupId: string, newName: string): Promise<void> {
    return this.updateGroupInfo(groupId, {name: newName});
  }

  /**
   * Leave the group.
   * Broadcasts group_leave to remaining members, deletes local group.
   */
  async leaveGroup(groupId: string): Promise<void> {
    const group = await this.store.get(groupId);
    if(!group) throw new Error(`Group not found: ${groupId}`);

    const remaining = group.members.filter(m => m !== this.ownPubkey);

    const payload: GroupControlPayload = {
      type: 'group_leave',
      groupId
    };

    // Broadcast to remaining members
    const controlWraps = broadcastGroupControl(this.ownSk, remaining, payload);
    await this.publishFn(controlWraps);

    // Delete group locally + clean up main-thread mirror state symmetric to
    // `ensureGroupChatInjected` (phantomchat-groups-sync.ts). Without the mirror
    // cleanup the Chat entry survives store deletion, violating
    // INV-group-no-orphan-mirror-peer and briefly re-rendering the "left"
    // group in chat list until the next reload.
    const peerId = await groupIdToPeerId(groupId);
    await this.store.delete(groupId);
    // Purge the group's local messages and write a deletion tombstone so the
    // orphan-recovery scan in getGroupHistory can never resurrect it. Deleting
    // only the store record (as before) left 'group:<id>' messages on disk,
    // which getGroupHistory rebuilt into a half-broken zombie group — the
    // "deleted groups keep coming back / not a member of group" bug.
    await this.tombstoneGroupConversation(groupId);
    await cleanupGroupChatInjection(peerId);

    // Drop the chat-list dialog row symmetrically (FIND-3786a35f obs (D)).
    // Earlier we just dispatched `dialog_drop` with `{peerId}` but tweb's
    // autonomousDialogList gates on `isDialog(d) === d._ === 'dialog'` —
    // bare `{peerId}` fails the guard and the row stayed in the DOM.
    // Dispatch a minimum Dialog-shaped envelope instead so the autonomous
    // chat list deletes by getDialogKey(dialog) = dialog.peerId.
    const groupPeerIdAsDialogPeerId = peerId.toPeerId(true);
    try {
      rootScope.dispatchEvent('dialog_drop' as any, {
        _: 'dialog',
        peerId: groupPeerIdAsDialogPeerId,
        peer: {_: 'peerChat', chat_id: Math.abs(peerId)},
        top_message: 0,
        read_inbox_max_id: 0,
        read_outbox_max_id: 0,
        unread_count: 0,
        unread_mentions_count: 0,
        unread_reactions_count: 0,
        notify_settings: {_: 'peerNotifySettings', pFlags: {}},
        pFlags: {}
      } as any);
    } catch(err) {
      this.log.warn('[GroupAPI] leaveGroup: dialog_drop dispatch non-critical:', err);
    }

    this.log('[GroupAPI] left group:', groupId);
  }

  /**
   * Leave a group resolved by tweb peerId. Routes the popup-driven
   * `appChatsManager.leave(chatId)` call (which would crash on PhantomChat
   * because `getSelf()` is undefined) to the proper group lifecycle.
   *
   * If the group is missing from the local store but a mirror entry
   * still exists (orphan from an older client version, or a group
   * received via rx without a persisted record), best-effort: skip the
   * broadcast and just clean up the mirror so the chat list row vanishes.
   */
  async leaveGroupByPeerId(peerId: number): Promise<void> {
    const group = await this.store.getByPeerId(peerId);
    if(group) {
      return this.leaveGroup(group.groupId);
    }
    this.log('[GroupAPI] leaveGroupByPeerId: orphan peer (no store record), tombstoning + cleaning mirror:', peerId);
    // Even with no store record, leftover 'group:<id>' messages on disk would
    // let getGroupHistory rebuild the group. Find the matching conversation by
    // peerId and tombstone + purge it so the deletion sticks.
    await this.tombstoneOrphanGroupByPeerId(peerId);
    await cleanupGroupChatInjection(peerId);
  }

  /**
   * Purge a group's local messages and write a deletion tombstone.
   *
   * Group conversations are keyed 'group:<groupId>' in the message store — the
   * same tombstone scheme deleteContacts uses for 1:1 deletions. Writing the
   * watermark here is what stops getGroupHistory's orphan-recovery scan from
   * resurrecting a deliberately-deleted group. Best-effort: failures are logged
   * but never block the leave flow.
   */
  private async tombstoneGroupConversation(groupId: string): Promise<void> {
    try {
      const store = getMessageStore();
      const convId = `group:${groupId}`;
      const now = Math.floor(Date.now() / 1000);
      await store.deleteMessages(convId);
      await store.setTombstone(convId, now);
      this.log('[GroupAPI] tombstoned + purged group conversation:', convId, 'at', now);
    } catch(err) {
      this.log.warn('[GroupAPI] tombstoneGroupConversation failed (non-fatal):', err);
    }
  }

  /**
   * Resolve a group conversation by peerId (when the store record is already
   * gone) and tombstone it. Mirrors getGroupHistory's orphan scan: walk the
   * 'group:*' conversation ids and match groupIdToPeerId(candidate) === peerId.
   */
  private async tombstoneOrphanGroupByPeerId(peerId: number): Promise<void> {
    try {
      const store = getMessageStore();
      const convIds = await store.getAllConversationIds();
      for(const convId of convIds) {
        if(!convId.startsWith('group:')) continue;
        const candidateId = convId.slice('group:'.length);
        const candidatePeerId = await groupIdToPeerId(candidateId);
        if(candidatePeerId === peerId) {
          await this.tombstoneGroupConversation(candidateId);
          return;
        }
      }
      this.log('[GroupAPI] tombstoneOrphanGroupByPeerId: no group conversation matched peerId', peerId);
    } catch(err) {
      this.log.warn('[GroupAPI] tombstoneOrphanGroupByPeerId failed (non-fatal):', err);
    }
  }

  // ─── Incoming message handling ────────────────────────────────

  /**
   * Handle an incoming group message.
   *
   * 1. Check sentMessageIds for dedup (Pitfall 7)
   * 2. Invoke the test hook if present
   * 3. Call the production render pipeline
   */
  handleIncomingGroupMessage(groupId: string, rumor: any, senderPubkey: string): void {
    // Parse message ID for dedup check
    let messageId: string | null = null;
    try {
      const parsed = JSON.parse(rumor.content);
      messageId = parsed.id || null;
    } catch{
      messageId = rumor.id;
    }

    // Pitfall 7: self-send dedup
    if(messageId && this.sentMessageIds.has(messageId)) {
      this.log('[GroupAPI] dedup: ignoring self-sent message:', messageId);
      return;
    }

    // Membership gate (FIND-01e78a01 #1): reject rumors from senders that
    // aren't members of the group. A user kicked from the group could
    // previously keep publishing rumors and remaining members would render
    // them as legitimate `is-in` bubbles. Async lookup but the gate fires
    // BEFORE the production render dispatch, so the bubble is dropped on
    // the failure path.
    void this.store.get(groupId).then((group) => {
      if(!group) return; // store racing; drop silently
      if(!group.members.includes(senderPubkey)) {
        this.log.warn('[GroupAPI] reject: sender is not a member of', groupId.slice(0, 8), '; sender =', senderPubkey.slice(0, 8));
        return;
      }
      this.handleIncomingGroupMessageAuthorised(groupId, rumor, senderPubkey);
    }).catch((err) => this.log.warn('[GroupAPI] membership check failed:', err));
  }

  /** Inner half of `handleIncomingGroupMessage` — runs only after the
   *  membership gate passes. Preserves the original test hook + production
   *  render contracts. */
  private handleIncomingGroupMessageAuthorised(groupId: string, rumor: any, senderPubkey: string): void {
    // Test-only override. Unit tests set this to observe delivery without
    // exercising the full IndexedDB + rootScope pipeline.
    if(this.onGroupMessage) {
      try {
        this.onGroupMessage(groupId, rumor, senderPubkey);
      } catch(err) {
        this.log.warn('[GroupAPI] onGroupMessage test hook threw:', err);
      }
      return;
    }

    // Production render path — persist + dispatch bubbles.
    handleGroupIncoming(this.ownPubkey, groupId, rumor, senderPubkey, this.dispatch)
    .catch((err) => this.log.warn('[GroupAPI] handleGroupIncoming threw:', err));
  }

  /**
   * Handle an incoming control message.
   * Routes to specific handler based on payload.type.
   */
  async handleControlMessage(rumor: any, senderPubkey: string): Promise<void> {
    let payload: GroupControlPayload;
    try {
      payload = JSON.parse(rumor.content);
    } catch{
      this.log.warn('[GroupAPI] failed to parse control message content');
      return;
    }

    // TOMBSTONE GATE (FIND-group-resurrection). If this group was deleted/left
    // locally, ignore any control message timestamped at or before the deletion
    // watermark — most importantly a `group_create` (or its self-wrap) replayed
    // from the relay backlog on reload, which would otherwise re-`store.save()`
    // and re-inject the dialog, resurrecting a group the user deleted. Mirrors
    // the content-message gate in phantomchat-groups-sync. A genuinely newer
    // control (sent AFTER the delete, e.g. being re-added) still passes through,
    // matching Signal-style revive semantics.
    if(payload?.groupId) {
      try {
        const deletedAt = await getMessageStore().getTombstone(`group:${payload.groupId}`);
        const ts = typeof rumor.created_at === 'number' ? rumor.created_at : Math.floor(Date.now() / 1000);
        if(deletedAt > 0 && ts <= deletedAt) {
          this.log('[GroupAPI] dropping tombstoned control message', payload.type, payload.groupId.slice(0, 8), {ts, deletedAt});
          return;
        }
      } catch(err) {
        this.log.warn('[GroupAPI] control tombstone gate check failed; continuing:', err);
      }
    }

    switch(payload.type) {
      case 'group_create':
        await this.handleGroupCreate(payload, senderPubkey);
        break;
      case 'group_add_member':
        await this.handleAddMember(payload);
        break;
      case 'group_remove_member':
        await this.handleRemoveMember(payload);
        break;
      case 'group_leave':
        await this.handleMemberLeave(payload, senderPubkey);
        break;
      case 'group_info_update':
        await this.handleInfoUpdate(payload);
        break;
      case 'group_admin_transfer':
        await this.handleAdminTransfer(payload);
        break;
      case 'group_edit_message':
        await this.handleEditMessageControl(payload, senderPubkey);
        break;
      case 'group_reaction':
        await this.handleReactionControl(payload, senderPubkey);
        break;
      default:
        this.log.warn('[GroupAPI] unknown control message type:', payload.type);
    }
  }

  /**
   * Apply an incoming edit control message. Validation symmetric to
   * `applyGroupEdit`:
   *   - target must exist in store
   *   - target must belong to this group
   *   - the edit sender must equal the target's original author
   *
   * On self-echo (sender === ownPubkey) the apply is a no-op merge since
   * the local store was already updated in `editMessage`.
   */
  private async handleEditMessageControl(payload: GroupControlPayload, senderPubkey: string): Promise<void> {
    const targetEventId = payload.targetEventId;
    const newText = payload.newText;
    const editedAt = typeof payload.editedAt === 'number' ?
      payload.editedAt :
      Math.floor(Date.now() / 1000);
    if(!targetEventId || typeof newText !== 'string') {
      this.log.warn('[GroupAPI] group_edit_message: missing fields, dropping', {hasTarget: !!targetEventId, hasText: typeof newText === 'string'});
      return;
    }
    await applyGroupEdit(payload.groupId, targetEventId, newText, editedAt, senderPubkey);
  }

  /**
   * Apply an incoming reaction control message. No author restriction —
   * any member may react to any message. Self-echo is idempotent because
   * the local store add (in reactToMessage) is first-write-wins.
   */
  private async handleReactionControl(payload: GroupControlPayload, senderPubkey: string): Promise<void> {
    const targetEventId = payload.targetEventId;
    const emoji = payload.emoji;
    const createdAt = typeof payload.createdAt === 'number' ?
      payload.createdAt :
      Math.floor(Date.now() / 1000);
    if(!targetEventId || !emoji) {
      this.log.warn('[GroupAPI] group_reaction: missing fields, dropping', {hasTarget: !!targetEventId, hasEmoji: !!emoji});
      return;
    }
    await applyGroupReaction(payload.groupId, targetEventId, emoji, senderPubkey, createdAt);
  }

  // ─── Control message handlers ─────────────────────────────────

  private async handleGroupCreate(payload: GroupControlPayload, senderPubkey: string): Promise<void> {
    const peerId = await groupIdToPeerId(payload.groupId);
    const record: GroupRecord = {
      groupId: payload.groupId,
      name: payload.groupName || 'Group',
      description: payload.groupDescription,
      adminPubkey: payload.adminPubkey || senderPubkey,
      members: payload.memberPubkeys || [],
      peerId,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await this.store.save(record);

    // Seed a local-only service row so receivers also get a valid top_message
    // in their group dialog before any real message lands.
    const createdAtSec = Math.floor(record.createdAt / 1000);
    let serviceMid: number | null = null;
    try {
      const service = await writeGroupCreateServiceMessage({
        groupId: record.groupId,
        peerId,
        timestamp: createdAtSec,
        adminPubkey: record.adminPubkey,
        title: record.name,
        isOutgoing: false
      });
      serviceMid = service.mid;
    } catch(err) {
      this.log.warn('[GroupAPI] failed to seed chatCreate service row (receiver):', err);
    }

    // Materialise the group in main-thread mirrors + chat list immediately,
    // before the first real message lands. Without this, invited members
    // never see the group until someone sends — and even then only after
    // a full `handleGroupIncoming` render round-trip.
    if(serviceMid !== null) {
      try {
        await injectGroupCreateDialog(record.groupId, serviceMid, createdAtSec);
      } catch(err) {
        this.log.warn('[GroupAPI] injectGroupCreateDialog (receiver) failed:', err);
      }
    }

    this.log('[GroupAPI] group_create received:', payload.groupId);
  }

  private async handleAddMember(payload: GroupControlPayload): Promise<void> {
    if(payload.memberPubkeys) {
      await this.store.updateMembers(payload.groupId, payload.memberPubkeys);
    }
    this.log('[GroupAPI] group_add_member:', payload.targetPubkey?.slice(0, 8));
  }

  private async handleRemoveMember(payload: GroupControlPayload): Promise<void> {
    if(payload.targetPubkey === this.ownPubkey) {
      // We were removed — delete group locally + clean up the injected Chat
      // from main-thread mirrors so INV-group-no-orphan-mirror-peer holds
      // and the chat list doesn't flash the removed group on refresh.
      const peerId = await groupIdToPeerId(payload.groupId);
      await this.store.delete(payload.groupId);
      await cleanupGroupChatInjection(peerId);
      this.log('[GroupAPI] removed from group:', payload.groupId);
    } else {
      const group = await this.store.get(payload.groupId);
      if(group) {
        const remaining = group.members.filter(m => m !== payload.targetPubkey);
        await this.store.updateMembers(payload.groupId, remaining);
      }
    }
  }

  private async handleMemberLeave(payload: GroupControlPayload, senderPubkey: string): Promise<void> {
    const group = await this.store.get(payload.groupId);
    if(group) {
      const remaining = group.members.filter(m => m !== senderPubkey);

      // Admin-orphan protection: if the departing member was the admin, the
      // remaining record would keep `adminPubkey` pointing at the gone admin
      // — violating INV-group-admin-is-member. Auto-transfer admin to the
      // lex-smallest remaining pubkey so every member derives the same new
      // admin deterministically without a separate control-message round.
      const wasAdminLeaving = group.adminPubkey === senderPubkey;
      const newAdmin = wasAdminLeaving && remaining.length > 0 ?
        [...remaining].sort()[0] :
        group.adminPubkey;

      if(wasAdminLeaving && newAdmin !== group.adminPubkey) {
        const updated = {
          ...group,
          members: remaining,
          adminPubkey: newAdmin,
          updatedAt: Date.now()
        };
        await this.store.save(updated);
        this.log('[GroupAPI] admin left; auto-promoted new admin:', newAdmin.slice(0, 8), 'in group', payload.groupId.slice(0, 8));
      } else {
        await this.store.updateMembers(payload.groupId, remaining);
      }
    }
    this.log('[GroupAPI] member left group:', senderPubkey.slice(0, 8));
  }

  private async handleInfoUpdate(payload: GroupControlPayload): Promise<void> {
    await this.store.updateInfo(payload.groupId, {
      name: payload.groupName,
      description: payload.groupDescription,
      avatar: payload.groupAvatar
    });

    // Sync the main-thread mirror so the receiver's chat-list + topbar
    // pick up the new title. Without this, FIND-3f07bfd3 δ — the rename
    // landed in the receiver's group-store but not in `mirrors.chats`,
    // leaving the chat-list row + topbar stuck on the prior title.
    try {
      const group = await this.store.get(payload.groupId);
      if(group) {
        const {ensureGroupChatInjected: ensureMirror} = await import('./phantomchat-groups-sync');
        await ensureMirror(payload.groupId, group.peerId);
        // Also fire a peer_title_edit hint so subscribers re-render — this
        // is what tweb dispatches for 1:1 contact name changes.
        try {
          const rs: any = (await import('@lib/rootScope')).default;
          const peerIdAsTweb = (group.peerId as any).toPeerId ?
            (group.peerId as any).toPeerId(true) :
            group.peerId;
          rs.dispatchEvent('peer_title_edit', {peerId: peerIdAsTweb});
        } catch(err) {
          this.log.warn('[GroupAPI] handleInfoUpdate: peer_title_edit dispatch non-critical:', err);
        }
      }
    } catch(err) {
      this.log.warn('[GroupAPI] handleInfoUpdate: mirror refresh failed:', err);
    }
  }

  private async handleAdminTransfer(payload: GroupControlPayload): Promise<void> {
    const group = await this.store.get(payload.groupId);
    if(group && payload.adminPubkey) {
      group.adminPubkey = payload.adminPubkey;
      group.updatedAt = Date.now();
      await this.store.save(group);
    }
  }

  // ─── Accessors ────────────────────────────────────────────────

  getDeliveryTracker(): GroupDeliveryTracker {
    return this.groupDelivery;
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let _instance: GroupAPI | null = null;

export function getGroupAPI(): GroupAPI {
  if(!_instance) throw new Error('GroupAPI not initialized. Call initGroupAPI() first.');
  return _instance;
}

export function initGroupAPI(
  ownPubkey: string,
  ownSk: Uint8Array,
  publishFn: (events: NTNostrEvent[]) => Promise<void>,
  dispatch?: GroupDispatchFn
): GroupAPI {
  _instance = new GroupAPI(ownPubkey, ownSk, publishFn, dispatch);
  // Expose on window so E2E/fuzz tests resolve via a single shared reference.
  // Vite dev can serve `@lib/phantomchat/group-api` and `/src/lib/phantomchat/group-api.ts`
  // as separate module instances (same class behind the multi-rootScope bug
  // noted in CLAUDE.md); the window ref bypasses that for non-production code.
  try {
    if(typeof window !== 'undefined') (window as any).__phantomchatGroupAPI = _instance;
  } catch{}
  return _instance;
}
