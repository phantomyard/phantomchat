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
import {groupIdToPeerId, isGroupPeer} from './group-types';
import {schedulePublish} from './phantomchat-sync-triggers';
import {wrapGroupMessage} from './nostr-crypto';
import {broadcastGroupControl} from './group-control-messages';
import {writeGroupCreateServiceMessage, writeGroupRebindNoticeMessage} from './group-service-messages';
import {GroupDeliveryTracker} from './group-delivery-tracker';
import {handleGroupIncoming, handleGroupOutgoing, applyGroupEdit, applyGroupReaction, cleanupGroupChatInjection, ensureGroupChatInjected, injectGroupCreateDialog, type GroupDispatchFn} from './phantomchat-groups-sync';
import {getMessageStore} from './message-store';
import {isSafeGroupAvatarUrl} from './blossom-servers';
import type {GroupStore} from './group-store';
import type {GroupRecord, GroupControlPayload} from './group-types';
import type {NTNostrEvent} from './nostr-crypto';

// ─── Source-event watermarks (per-field LWW on event time) ────────

/** Which mutable field-set a control message kind writes to. */
type GroupEventField = 'members' | 'info' | 'admin';

const WATERMARK_PREFIX = 'phantomchat:group-wm:';
/** Grace for clock skew between members' devices, in seconds. */
const WATERMARK_GRACE_SEC = 60;

function watermarkFieldFor(type: string): GroupEventField | null {
  switch(type) {
    case 'group_add_member':
    case 'group_remove_member':
    case 'group_leave':
      return 'members';
    case 'group_info_update':
      return 'info';
    case 'group_admin_transfer':
      return 'admin';
    default:
      return null;
  }
}

// ─── Group-id ↔ admin binding (#188) ──────────────────────
//
// A group_create carries `adminPubkey` in its own payload — self-asserted,
// no source of truth. On a device with no local record, any sender who knows
// a group id can forge create(admin=self) + delete(self) and manufacture a
// DURABLE cross-device delete for a group this device never held (Robert,
// issue #188). Fix: NEW groups bind the admin INTO the id —
// `<64-hex adminPubkey><32-hex random>` (96 hex chars). Receivers verify a
// bound create/delete against the id itself instead of the payload:
//   - group_create from a sender ≠ the id-bound admin is rejected (no
//     record, no mirrors, nothing for a follow-up delete to authenticate
//     against), and the record's adminPubkey is the id-bound value, never
//     the payload claim;
//   - group_delete from a sender with no verifiable authority is rejected
//     BEFORE any teardown: with a live record the CURRENT stored admin is
//     the authority (the id binding authenticates CREATE, never DELETE —
//     transferAdmin()/handleMemberLeave() legitimately move adminPubkey
//     away from the id-bound creator, and a bound-key check there would
//     freeze every bound group's deletion after an admin transfer);
//     with no record, only the id-bound key itself can ever authenticate,
//     so any other sender is rejected before even the quarantine stage.
// The attacker's pair then dies on message one: their forged create is
// rejected, and their delete is rejected (no record anywhere, and the
// id fails their key on no-record devices) without creating any state.
//
// Legacy ids (32-hex randomUUID, pre-#188 groups) carry no binding and keep
// the pre-existing behavior: creates trust `payload.adminPubkey || sender`,
// deletes require an admin match against a local record. That limitation is
// documented on the issue — it cannot be retrofitted onto already-minted
// groups without a migration protocol.

const BOUND_ID_RE = /^([0-9a-f]{64})([0-9a-f]{32})$/;

/** Legacy (pre-#189) group id: 32 hex chars, no bound admin. */
const LEGACY_ID_RE = /^[0-9a-f]{32}$/;

/** The admin pubkey bound into `groupId`, or null for legacy (unbound) ids. */
function boundGroupAdmin(groupId: string): string | null {
  const m = BOUND_ID_RE.exec(groupId);
  return m ? m[1] : null;
}

/** Mint a new group id bound to its creator (the admin). */
function mintBoundGroupId(adminPubkey: string): string {
  return adminPubkey + crypto.randomUUID().split('-').join('');
}

function readEventWatermark(groupId: string, field: GroupEventField): number {
  try {
    const wm = parseInt(localStorage.getItem(WATERMARK_PREFIX + groupId + ':' + field) || '0', 10) || 0;
    // Heal a poisoned watermark: created_at is sender-chosen, so an event
    // dated in the far future (pre-clamp release, or a malicious member)
    // could have persisted a watermark years ahead — it would then drop
    // every legitimate event forever, freezing the group's membership.
    // Clamp to "now" so anti-replay protection survives but live events
    // can apply; the next applied event stamps a sane value.
    const nowSec = Math.floor(Date.now() / 1000);
    if(wm > nowSec + WATERMARK_GRACE_SEC) {
      return nowSec;
    }
    return wm;
  } catch{
    return 0;
  }
}

function writeEventWatermark(groupId: string, field: GroupEventField, tsSec: number): void {
  try {
    localStorage.setItem(WATERMARK_PREFIX + groupId + ':' + field, String(tsSec));
  } catch{ /* best-effort — private mode etc. */ }
}

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

/** Unknown-group deletes cannot be trusted yet, but may have raced ahead of
 *  their create during relay backlog processing. Keep them only in memory,
 *  bounded and short-lived, until a create supplies the admin key needed to
 *  authenticate the sender. */
const PENDING_GROUP_DELETE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_GROUP_DELETES = 512;
const MAX_PENDING_GROUP_DELETES_PER_SENDER = 32;

interface PendingGroupDelete {
  groupId: string;
  senderPubkey: string;
  createdAt: number;
  receivedAt: number;
}

// ─── GroupAPI ─────────────────────────────────────────────────────

export class GroupAPI {
  private store: GroupStore;
  private ownPubkey: string;
  private ownSk: Uint8Array;
  private publishFn: (events: NTNostrEvent[]) => Promise<void>;
  private dispatch: GroupDispatchFn;
  private groupDelivery: GroupDeliveryTracker;
  private sentMessageIds: Set<string> = new Set();
  private pendingGroupDeletes: Map<string, PendingGroupDelete> = new Map();
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

    const groupId = mintBoundGroupId(this.ownPubkey);
    const peerId = await groupIdToPeerId(groupId);

    const record: GroupRecord = {
      groupId,
      name,
      description,
      adminPubkey: this.ownPubkey,
      members: [...memberPubkeys, this.ownPubkey],
      peerId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      // The user's own create gesture (#180): only this stamp lets the group
      // clear a durable delete in the groups CRDT merge. The receive path
      // (handleGroupCreate) deliberately does NOT stamp — a relay-replayed
      // group_create must never count as intent.
      deliberateAddAt: Date.now()
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
    schedulePublish('groups');
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
      /** Multi-mirror Blossom URLs (primary first). */
      servers?: string[];
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
    schedulePublish('groups');
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
    schedulePublish('groups');
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
    schedulePublish('groups');
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
   *
   * Ordering note (PR #179 round 12): the control broadcast is published
   * BEFORE teardownGroupLocally, which can now reject on a durable-write
   * failure. In that case the other members have already processed the
   * leave while THIS device keeps its live record. A retry of the leave
   * re-broadcasts and converges, so the order is deliberate.
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

    await this.teardownGroupLocally(groupId);
    this.log('[GroupAPI] left group:', groupId);
    schedulePublish('groups');
  }

  /**
   * Delete the group for EVERYONE — admin only, no restrictions.
   *
   * Broadcasts a `group_delete` control to all OTHER members so their clients
   * tombstone + drop the group too (broadcastGroupControl also self-wraps for
   * multi-device), then tears the group down locally. P2P has no server to
   * force-wipe a group off other devices, so this is cooperative: each member's
   * client honors `group_delete` from the verified admin (see handleGroupDelete).
   *
   * Ordering note (PR #179 round 12): like leaveGroup, the broadcast is
   * published BEFORE teardownGroupLocally, which can reject on a
   * durable-write failure — other members delete while this device keeps a
   * live record until a retry re-broadcasts and converges.
   */
  async deleteGroup(groupId: string): Promise<void> {
    const group = await this.store.get(groupId);
    if(!group) throw new Error(`Group not found: ${groupId}`);
    if(group.adminPubkey !== this.ownPubkey) throw new Error('Only admin can delete the group');

    const others = group.members.filter(m => m !== this.ownPubkey);
    const payload: GroupControlPayload = {
      type: 'group_delete',
      groupId
    };

    const controlWraps = broadcastGroupControl(this.ownSk, others, payload);
    await this.publishFn(controlWraps);

    await this.teardownGroupLocally(groupId);
    this.log('[GroupAPI] deleted group for all members:', groupId);
    schedulePublish('groups');
  }

  /**
   * Delete a group resolved by tweb peerId (admin only). Mirror of
   * leaveGroupByPeerId for the delete-for-everyone path.
   */
  async deleteGroupByPeerId(peerId: number): Promise<void> {
    const group = await this.store.getByPeerId(peerId);
    if(group) {
      return this.deleteGroup(group.groupId);
    }
    // No store record — best-effort local cleanup so the row vanishes and the
    // conversation stays tombstoned.
    this.log('[GroupAPI] deleteGroupByPeerId: orphan peer (no store record), tombstoning + cleaning mirror:', peerId);
    await this.tombstoneOrphanGroupByPeerId(peerId);
    await cleanupGroupChatInjection(peerId);
  }

  /**
   * Local group teardown shared by leaveGroup / deleteGroup / handleGroupDelete /
   * handleRemoveMember (the kicked path, issue #181):
   * delete the store record, write the deletion tombstone (so neither the
   * orphan-recovery scan nor a replayed control message can resurrect it —
   * FIND-group-resurrection), purge the injected main-thread mirror (symmetric
   * to ensureGroupChatInjected; without it the Chat entry survives store
   * deletion, violating INV-group-no-orphan-mirror-peer), and drop the
   * chat-list dialog row.
   */
  private async teardownGroupLocally(groupId: string): Promise<void> {
    const peerId = await groupIdToPeerId(groupId);
    // Durable positive delete fact (PR #179 round 5): recorded BEFORE the
    // destructive teardown and as a STRICT precondition — if the durable write
    // fails, we abort and the live record stays (Kai's round-9 review of
    // #179). Tearing down without the durable fact would leave this device
    // holding neither a live record nor the delete fact — exactly the state a
    // stale record elsewhere resurrects the group from. Monotonic: a re-delete
    // only moves it forward.
    const deletedAt = Math.floor(Date.now() / 1000);
    await this.store.recordDeletedGroup(groupId, deletedAt);
    await this.store.delete(groupId);
    await this.tombstoneGroupConversation(groupId, deletedAt);
    await cleanupGroupChatInjection(peerId);

    // Drop the chat-list dialog row — INCLUDING its persisted tweb cache row
    // (issue #198 dogfood finding). The old dispatch of a synthetic 'dialog_drop'
    // envelope only flushed the message storages (the event listener in
    // appMessagesManager calls flushStoragesByPeerId and nothing else), so the
    // dialogs row in tweb-account-N survived and re-rendered the dead group on
    // every boot. dropDialogOnDeletion removes the row from memory, folders and
    // the persistent dialogs storage, and dispatches a REAL 'dialog_drop' event
    // with the actual Dialog object — same path the native delete-chat UI uses.
    const groupPeerIdAsDialogPeerId = peerId.toPeerId(true);
    try {
      rootScope.managers.dialogsStorage.dropDialogOnDeletion(groupPeerIdAsDialogPeerId);
    } catch(err) {
      this.log.warn('[GroupAPI] teardownGroupLocally: dialog row drop non-critical:', err);
    }
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
   * resurrecting a deliberately-deleted group. Failures are logged but never
   * mask the durable positive delete fact: the teardown (or orphan) caller
   * recorded it BEFORE this runs.
   */
  private async tombstoneGroupConversation(groupId: string, deletedAtSec?: number): Promise<void> {
    // Orphan callers (tombstoneOrphanGroupByPeerId) have no teardown to record
    // the durable delete first — record it here, BEFORE the message-store
    // chain, as a STRICT precondition: if the durable write fails, abort the
    // purge (nothing destructive happens; the orphan scan just retries next
    // time) rather than purging messages while holding neither a live record
    // nor the delete fact (Kai's round-9 review of #179).
    if(deletedAtSec === undefined) {
      await this.store.recordDeletedGroup(groupId, Math.floor(Date.now() / 1000));
    }
    try {
      const store = getMessageStore();
      const convId = `group:${groupId}`;
      const now = deletedAtSec ?? Math.floor(Date.now() / 1000);
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
    void this.store.get(groupId).then(async(group) => {
      if(!group) {
        // REBIND REMAP (#188 remainder): no record under the wire id, but
        // pre-migration messages (relay backlog) are still addressed to the
        // legacy id. A live successor carrying this id in supersededGroupIds
        // claims that traffic — remap so history lands in the rebound
        // conversation. The membership gate below still applies against the
        // successor's member list.
        const successor = await this.findSuccessorBySupersededId(groupId);
        if(successor) {
          group = successor;
          groupId = successor.groupId;
        }
      }
      if(!group) return; // store racing; drop silently
      if(!group.members.includes(senderPubkey)) {
        this.log.warn('[GroupAPI] reject: sender is not a member of', groupId.slice(0, 8), '; sender =', senderPubkey.slice(0, 8));
        return;
      }

      // Persistent replay dedup (#207). `sentMessageIds` above is in-memory and
      // empty after every restart, and relays re-deliver kind-1059 gift-wraps
      // (24h TTL) on every reconnect/boot. Without a persistent check the live
      // receive path re-rendered already-read group messages, rewound the read
      // marker and repainted unread badges. Mirror `chat-api-receive.ts` step 7b:
      // look the rumor id up in the message store and drop it before any
      // save/render/dispatch. `saveMessage` upserts by eventId, so a replay of
      // anything we have ever persisted is already present for the lookup.
      try {
        const msgStore = getMessageStore();
        const eventId: string | undefined = rumor?.id;
        const seen = !!eventId && (msgStore.hasSeenEventId?.(eventId) || await msgStore.getByEventId(eventId));
        if(seen) {
          this.log('[GroupAPI] dedup: dropping replayed group message:', eventId);
          return;
        }
      } catch(err) {
        this.log.warn('[GroupAPI] persistent dedup lookup failed:', err);
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

    // PER-FIELD EVENT WATERMARK GATE. The tombstone gate above only
    // protects deleted groups; this one protects LIVE ones against
    // relay-replay resurrection: group_create / group_add_member carry the
    // FULL member list, so a replayed old event must not clobber newer
    // mutations.
    //
    // This is source-event last-writer-wins, NOT a wall-clock comparison
    // against the record's updatedAt: the watermark is the newest
    // created_at we have actually APPLIED, kept per group AND per field
    // (members / info / admin) so that a delayed event of one kind is never
    // dropped just because another kind applied more recently. The
    // watermark persists in localStorage, so a backlog replayed after a
    // reload can't resurrect removed members. group_create itself has no
    // watermark — the non-destructive replay guard in handleGroupCreate
    // already makes a replayed create a no-op for live records.
    const ts = typeof rumor.created_at === 'number' ? rumor.created_at : Math.floor(Date.now() / 1000);
    const wmField: GroupEventField | null = payload?.groupId ? watermarkFieldFor(payload.type) : null;
    if(wmField) {
      // FUTURE-TIMESTAMP CLAMP. created_at is attacker-chosen and the
      // watermark is persisted: a single members event dated years ahead
      // would pin the watermark beyond every legitimate future event and
      // permanently freeze the group's membership (survives reload).
      // An event dated beyond the skew grace is simply not valid yet —
      // drop it; when its real time arrives a fresh delivery applies it.
      const nowSec = Math.floor(Date.now() / 1000);
      if(ts > nowSec + WATERMARK_GRACE_SEC) {
        this.log('[GroupAPI] dropping control message dated in the future', payload.type, payload.groupId.slice(0, 8), {ts, nowSec});
        return;
      }
      const wm = readEventWatermark(payload.groupId, wmField);
      if(ts < wm - WATERMARK_GRACE_SEC) {
        this.log('[GroupAPI] dropping replayed control message older than watermark', payload.type, payload.groupId.slice(0, 8), {ts, watermark: wm});
        return;
      }
    }

    // Field-bearing handlers report whether they actually applied (false =
    // validation dropped it) so the watermark only advances on real applies.
    let applied = false;
    switch(payload.type) {
      case 'group_create':
        await this.handleGroupCreate(payload, senderPubkey, ts);
        break;
      case 'group_add_member':
        applied = (await this.handleAddMember(payload)) !== false;
        break;
      case 'group_remove_member':
        // The self-removal (kicked) branch runs the same durable-write
        // precondition as teardownGroupLocally (issue #181) and can reject
        // on a recordDeletedGroup failure — catch here so the dispatch
        // survives and a relay-backlog redelivery retries the kick, exactly
        // like the group_delete case above.
        try {
          applied = (await this.handleRemoveMember(payload, senderPubkey)) !== false;
        } catch(err) {
          this.log.warn('[GroupAPI] group_remove_member handling failed; retry expected via backlog:', err);
        }
        break;
      case 'group_leave':
        applied = (await this.handleMemberLeave(payload, senderPubkey)) !== false;
        break;
      case 'group_delete':
        // A failed durable-write precondition aborts the teardown (Kai's
        // round-9 review of #179). Catch here so the dispatch survives.
        // NOTE (Robert's round-12 review of #179): group_delete has NO
        // source-event watermark (watermarkFieldFor returns null for it),
        // so `applied` is never consulted for this type — nothing is being
        // held back locally. Whether a retry happens depends entirely on
        // the relay redelivering the event to chat-api-receive.
        try {
          await this.handleGroupDelete(payload, senderPubkey, ts);
        } catch(err) {
          this.log.warn('[GroupAPI] group_delete handling failed; retry expected via backlog:', err);
        }
        break;
      case 'group_info_update':
        applied = (await this.handleInfoUpdate(payload, senderPubkey)) !== false;
        break;
      case 'group_admin_transfer':
        applied = (await this.handleAdminTransfer(payload, senderPubkey)) !== false;
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

    // Advance the source-event watermark only when the event actually
    // applied — a validation-dropped event must not mask an older, legitimate
    // one still to arrive from the backlog.
    if(wmField && applied) {
      // Cap the persisted value at the local clock: ts was already clamped
      // above, but defense in depth — a stored watermark may never exceed
      // now + grace no matter what the sender claimed.
      writeEventWatermark(payload.groupId, wmField, Math.min(ts, Math.floor(Date.now() / 1000)));
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

  private prunePendingGroupDeletes(now = Date.now()): void {
    for(const [key, pending] of this.pendingGroupDeletes) {
      if(now - pending.receivedAt > PENDING_GROUP_DELETE_TTL_MS) {
        this.pendingGroupDeletes.delete(key);
      }
    }
  }

  private rememberPendingGroupDelete(groupId: string, senderPubkey: string, createdAt: number): void {
    this.prunePendingGroupDeletes();
    const key = `${groupId}:${senderPubkey}`;
    const existing = this.pendingGroupDeletes.get(key);
    if(existing && existing.createdAt >= createdAt) return;

    if(existing) {
      // A replay with a newer source timestamp may update the delete fact,
      // but it must not renew its local TTL indefinitely.
      this.pendingGroupDeletes.set(key, {...existing, createdAt});
      return;
    }

    // This scan is intentionally O(n) over a map capped at 512 entries. It
    // enforces both limits without maintaining a second mutable index.
    const senderSlices = new Map<string, {count: number; oldestKey: string; oldestReceivedAt: number}>();
    for(const [pendingKey, pending] of this.pendingGroupDeletes) {
      const slice = senderSlices.get(pending.senderPubkey);
      if(!slice) {
        senderSlices.set(pending.senderPubkey, {
          count: 1,
          oldestKey: pendingKey,
          oldestReceivedAt: pending.receivedAt
        });
      } else {
        slice.count++;
        if(pending.receivedAt < slice.oldestReceivedAt) {
          slice.oldestKey = pendingKey;
          slice.oldestReceivedAt = pending.receivedAt;
        }
      }
    }

    const ownSlice = senderSlices.get(senderPubkey);
    if(ownSlice && ownSlice.count >= MAX_PENDING_GROUP_DELETES_PER_SENDER) {
      // A single authenticated key may mint unlimited self-bound ids. Keep
      // its eviction pressure inside its own slice of the quarantine (#193).
      this.pendingGroupDeletes.delete(ownSlice.oldestKey);
    } else if(this.pendingGroupDeletes.size >= MAX_PENDING_GROUP_DELETES) {
      // Always admit a new sender at global capacity. Charge the entry to the
      // largest existing slice, evicting its oldest fact; ties prefer the
      // slice with the oldest fact. Residual Sybil limit: this is fair-share,
      // not perfect isolation — as distinct identities accumulate, every
      // sender's protected share approaches 512 / sender-count entries.
      let heaviest: {count: number; oldestKey: string; oldestReceivedAt: number} | undefined;
      for(const slice of senderSlices.values()) {
        if(!heaviest || slice.count > heaviest.count ||
          (slice.count === heaviest.count && slice.oldestReceivedAt < heaviest.oldestReceivedAt)) {
          heaviest = slice;
        }
      }
      if(heaviest) this.pendingGroupDeletes.delete(heaviest.oldestKey);
    }

    this.pendingGroupDeletes.set(key, {groupId, senderPubkey, createdAt, receivedAt: Date.now()});
  }

  private clearPendingGroupDeletes(groupId: string, senderPubkey?: string): void {
    for(const [key, pending] of this.pendingGroupDeletes) {
      if(pending.groupId === groupId && (!senderPubkey || pending.senderPubkey === senderPubkey)) {
        this.pendingGroupDeletes.delete(key);
      }
    }
  }

  /** Consume every quarantined delete for this group and return the newest
   *  one authenticated by the create's admin key and ordered after the create. */
  private consumeVerifiedPendingDelete(groupId: string, adminPubkey: string, createdAt: number): PendingGroupDelete | null {
    this.prunePendingGroupDeletes();
    let verified: PendingGroupDelete | null = null;
    for(const [key, pending] of this.pendingGroupDeletes) {
      if(pending.groupId !== groupId) continue;
      this.pendingGroupDeletes.delete(key);
      if(pending.senderPubkey === adminPubkey && pending.createdAt >= createdAt &&
        (!verified || pending.createdAt > verified.createdAt)) {
        verified = pending;
      }
    }
    return verified;
  }

  private async handleGroupCreate(payload: GroupControlPayload, senderPubkey: string, createdAt: number): Promise<void> {
    const peerId = await groupIdToPeerId(payload.groupId);

    // REBIND MIGRATION (#188 remainder): a supersede create migrates a
    // legacy group to a bound id. Separate trust path — the bound id
    // authenticates the create, the receiver's own live legacy record
    // authenticates the supersede CLAIM (see handleSupersedeCreate).
    if(payload.supersedesGroupId) {
      await this.handleSupersedeCreate(payload, senderPubkey, createdAt, peerId);
      return;
    }

    // NON-DESTRUCTIVE REPLAY GUARD: we already hold a live record for this
    // group. A create event replayed from the relay backlog must not clobber
    // it — the record's own mutations (renames, member changes) are newer
    // than the original create. Belt and braces with the staleness gate in
    // handleControlMessage: even if a skewed clock smuggles a stale create
    // past that gate, it still can't overwrite a live record.
    const existing = await this.store.get(payload.groupId);
    if(existing) {
      this.log('[GroupAPI] group_create replay for live group ignored:', payload.groupId.slice(0, 8));
      return;
    }

    // ID-BOUND ADMIN CHECK (#188): for bound ids the create has a source of
    // truth that is NOT its own payload — the id itself. A create from any
    // sender other than the bound admin is a forgery; reject it without
    // storing anything, so a follow-up group_delete has no record to
    // authenticate against and no device-side state was minted by the pair's
    // first message.
    const boundAdmin = boundGroupAdmin(payload.groupId);
    if(boundAdmin && boundAdmin !== senderPubkey) {
      this.log.warn('[GroupAPI] rejecting group_create: sender is not the id-bound admin', senderPubkey.slice(0, 8), 'for', payload.groupId.slice(0, 8));
      return;
    }

    const record: GroupRecord = {
      groupId: payload.groupId,
      name: payload.groupName || 'Group',
      description: payload.groupDescription,
      // Bound id: the id IS the authority — never the payload's claim.
      // Legacy id: pre-#188 behavior (payload claim, sender as fallback).
      adminPubkey: boundAdmin ?? (payload.adminPubkey || senderPubkey),
      members: payload.memberPubkeys || [],
      peerId,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    // A delete can arrive before its create because control handlers run
    // concurrently during backlog replay. The quarantined fact becomes trusted
    // only now, when the create supplies the matching admin key. Never let an
    // unmatched sender manufacture durable deletion state.
    if(this.consumeVerifiedPendingDelete(payload.groupId, record.adminPubkey, createdAt)) {
      await this.teardownGroupLocally(payload.groupId);
      this.log('[GroupAPI] verified reordered group_delete before create:', payload.groupId.slice(0, 8));
      return;
    }

    await this.store.save(record);

    // Close the interleaving where group_delete starts after the check above
    // but before save completes. handleGroupDelete stages its fact before its
    // first await, so this second check observes that race deterministically.
    if(this.consumeVerifiedPendingDelete(payload.groupId, record.adminPubkey, createdAt)) {
      await this.teardownGroupLocally(payload.groupId);
      this.log('[GroupAPI] verified concurrent group_delete during create:', payload.groupId.slice(0, 8));
      return;
    }

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

  // ─── Legacy rebind migration (#188 remainder) ─────────────────────
  //
  // Pre-#189 groups carry legacy 32-hex ids whose create/delete trust path
  // is still the self-asserted one (the two-message forgery #188 describes).
  // The rebind migrates such a group to a bound id via a `group_create`
  // carrying `supersedesGroupId`. Trust model, per the design on the issue:
  //   - the BOUND ID authenticates the create itself (post-#189 rule);
  //   - a receiver holding a LIVE legacy record authenticates the supersede
  //     claim against that record's admin — an attacker's own bound group
  // can never claim someone else's legacy group (anti-hijack);
  //   - a receiver with NO legacy record stores the create as a plain bound
  // create (carrying the supersedes link for late-traffic remap) and writes
  // NO durable row for the legacy id — #184's rule stands: a durable delete
  // for a group this device never held is exactly the forgery artifact;
  //   - competing rebinds from two of the admin's devices converge on
  //     max(reboundAt, groupId) with no coordinator.

  private async handleSupersedeCreate(
    payload: GroupControlPayload,
    senderPubkey: string,
    createdAt: number,
    peerId: number
  ): Promise<void> {
    // The successor MUST be a bound id — a supersede onto a legacy id would
    // keep the unbound trust path this migration exists to retire.
    const boundAdmin = boundGroupAdmin(payload.groupId);
    if(!boundAdmin) {
      this.log.warn('[GroupAPI] rejecting supersede create: successor id is not bound:', payload.groupId.slice(0, 8));
      return;
    }
    if(boundAdmin !== senderPubkey) {
      this.log.warn('[GroupAPI] rejecting supersede create: sender is not the id-bound admin', senderPubkey.slice(0, 8));
      return;
    }

    // The supersede TARGET must be a legacy 32-hex id (Lena review
    // 2026-10-04). Bound ids are already self-authenticating, so allowing
    // them as supersede targets buys nothing and adds an unneeded code
    // path to audit — reject anything that isn't exactly legacy format.
    if(!LEGACY_ID_RE.test(payload.supersedesGroupId)) {
      this.log.warn('[GroupAPI] rejecting supersede create: supersedesGroupId is not a legacy id:', payload.supersedesGroupId.slice(0, 8));
      return;
    }

    // Already applied (self-wrap echo, relay replay, or the record arrived
    // first via own-device sync): never re-save. But the successor's PRESENCE
    // is itself the admin's delete fact for the legacy id — reconcile a live
    // legacy record the CRDT merge may have resurrected (#180 deliberate-
    // stamp corner), gated on the ID-DERIVED admin matching so a forged
    // successor can never tear down a legacy group it has no claim to.
    // (The record's adminPubkey FIELD is attacker-mouldable data once a
    // forged record enters the CRDT union — the bound id is not.)
    const existingNew = await this.store.get(payload.groupId);
    if(existingNew) {
      const legacy = await this.store.get(payload.supersedesGroupId);
      if(legacy && legacy.adminPubkey === boundAdmin) {
        await this.teardownGroupLocally(payload.supersedesGroupId);
        this.log('[GroupAPI] supersede echo: reconciled live legacy record:', payload.supersedesGroupId.slice(0, 8));
      }
      // Competing successors can first appear as SYNCED RECORDS (own-device
      // sync beats the relay; the admin's own devices never receive each
      // other's supersede create at all). An already-stored successor must
      // not short-circuit convergence — resolve the duplicate NOW.
      // (duplicate-groups regression 2026-10-04)
      await this.resolveCompetingSuccessors(payload.supersedesGroupId);
      return;
    }

    // ANTI-HIJACK: with a live legacy record, only ITS admin may migrate the
    // group — the receiver's own record is the source of truth for who that
    // is, exactly like the legacy delete path. Nothing is stored on reject.
    const legacyRecord = await this.store.get(payload.supersedesGroupId);
    if(legacyRecord && legacyRecord.adminPubkey !== senderPubkey) {
      this.log.warn(
        '[GroupAPI] rejecting supersede create: sender is not the admin of the legacy group',
        senderPubkey.slice(0, 8), 'for', payload.supersedesGroupId.slice(0, 8)
      );
      return;
    }

    // DEPARTED-MEMBER GUARD (duplicate-groups regression 2026-10-04): the
    // successor is a FRESH id — the durable delete this device holds for the
    // legacy id can't cover it, so without this check the rebind resurrects
    // a group this device deliberately deleted (left / was kicked from) —
    // the exact #184/#185 authority violation. A device holding a live
    // successor is mid/post-migration (the durable row for the retired
    // legacy id is its NORMAL end-state) and passes; a live legacy record
    // already passed above; a brand-new device of a current member holds
    // no delete fact and passes too.
    if(!legacyRecord) {
      let deletedRows: Array<{groupId: string}> = [];
      try {
        deletedRows = (await this.store.listDeletedGroups()) ?? [];
      } catch{ /* read failure — fall through to the plain-create path */ }
      const durablyDeleted = deletedRows.some((d) => d.groupId === payload.supersedesGroupId);
      const successor = await this.findSuccessorBySupersededId(payload.supersedesGroupId);
      if(durablyDeleted && !successor) {
        this.log.warn(
          '[GroupAPI] rejecting supersede create: legacy group is durably deleted here (departed member):',
          payload.supersedesGroupId.slice(0, 8)
        );
        return;
      }
    }

    // Competing rebind (two of the admin's devices raced the migration):
    // deterministic winner max(reboundAt, groupId). Losers are ignored; the
    // winner migrates and the losing successor is torn down alongside.
    const competitor = await this.findSuccessorBySupersededId(payload.supersedesGroupId, payload.groupId);
    let loserId: string | null = null;
    if(competitor) {
      const competitorAt = competitor.reboundAt ?? 0;
      const incomingWins = createdAt > competitorAt ||
        (createdAt === competitorAt && payload.groupId > competitor.groupId);
      if(!incomingWins) {
        this.log('[GroupAPI] ignoring supersede create: lost to existing rebind', payload.groupId.slice(0, 8));
        return;
      }
      loserId = competitor.groupId;
    }

    const nowMs = Date.now();
    const record: GroupRecord = {
      groupId: payload.groupId,
      name: payload.groupName || 'Group',
      description: payload.groupDescription,
      // Bound id: the id IS the authority, never the payload claim.
      adminPubkey: boundAdmin,
      members: payload.memberPubkeys || [],
      peerId,
      createdAt: nowMs,
      updatedAt: nowMs,
      supersededGroupIds: [payload.supersedesGroupId],
      reboundAt: createdAt
    };

    await this.commitLegacyMigration(record, {deliberate: false, teardownLegacy: !!legacyRecord});
    if(loserId) {
      await this.teardownGroupLocally(loserId);
    }
    this.log('[GroupAPI] legacy group rebound:', payload.supersedesGroupId.slice(0, 8), '→', payload.groupId.slice(-8));
  }

  /** Shared local migration for the rebind initiator and supersede
   *  receivers: re-key history, carry watermarks, save the successor record,
   *  seed the dialog, then retire the legacy id. */
  private async commitLegacyMigration(
    record: GroupRecord,
    opts: {deliberate: boolean; teardownLegacy: boolean}
  ): Promise<void> {
    const legacyId = record.supersededGroupIds![0];
    // History FIRST — teardownGroupLocally purges the legacy conversation,
    // and the re-key moves rows by upsert (eventId is the store's unique key,
    // so a moved row is the SAME row, not a copy).
    await this.rekeyGroupMessages(legacyId, record.groupId, record.peerId);
    this.copyEventWatermarks(legacyId, record.groupId);
    await this.store.save(record);

    // Seed the service row + mirror so the rebound dialog is valid before any
    // real message lands — same best-effort contract as the create paths.
    const createdAtSec = Math.floor(record.createdAt / 1000);
    let serviceMid: number | null = null;
    try {
      const service = await writeGroupCreateServiceMessage({
        groupId: record.groupId,
        peerId: record.peerId,
        timestamp: createdAtSec,
        adminPubkey: record.adminPubkey,
        title: record.name,
        isOutgoing: opts.deliberate
      });
      serviceMid = service.mid;
    } catch(err) {
      this.log.warn('[GroupAPI] failed to seed chatCreate service row (rebind):', err);
    }
    if(serviceMid !== null) {
      try {
        await injectGroupCreateDialog(record.groupId, serviceMid, createdAtSec);
      } catch(err) {
        this.log.warn('[GroupAPI] injectGroupCreateDialog (rebind) failed:', err);
      }
    }

    // Visible notice in the new dialog (Lena review of #188): auto-rebind
    // must not be silent — members otherwise see a new group id appear out
    // of nowhere. Deterministic eventId → idempotent upsert, safe on echo.
    try {
      await writeGroupRebindNoticeMessage({
        groupId: record.groupId,
        peerId: record.peerId,
        timestamp: createdAtSec,
        adminPubkey: record.adminPubkey
      });
    } catch(err) {
      this.log.warn('[GroupAPI] failed to write rebind notice (non-fatal):', err);
    }

    // Retire the legacy id ONLY when this device actually held it — the
    // durable row is the admin's genuine delete fact. A device that never
    // held the group writes nothing durable for it (#184 rule: a durable
    // row for a never-held group is the forgery artifact we must not mint).
    if(opts.teardownLegacy) {
      await this.teardownGroupLocally(legacyId);
    }
    schedulePublish('groups');
  }

  /** Move a legacy group's message rows into the successor conversation.
   *  Rows move by upsert (same eventId): message identity, edits and
   *  reactions keep working unchanged after the migration. */
  private async rekeyGroupMessages(oldGroupId: string, newGroupId: string, newPeerId: number, pageSize = 1000): Promise<void> {
    try {
      const store = getMessageStore();
      // Paginate until exhausted: getMessages returns the NEWEST-first slice
      // of `pageSize`, so a single bounded call silently drops a long legacy
      // history's OLDEST rows at the rebind boundary (Lena review, PR #195).
      // Rows move by upsert keyed on eventId, so an overlapping cursor page
      // re-saving an already-moved row is idempotent.
      const seen = new Set<string>();
      let before: number | undefined;
      let moved = 0;
      for(;;) {
        const rows = await store.getMessages(`group:${oldGroupId}`, pageSize, before);
        if(rows.length === 0) break;
        let newRows = 0;
        for(const row of rows) {
          if(seen.has(row.eventId)) continue;
          seen.add(row.eventId);
          newRows++;
          await store.saveMessage({...row, conversationId: `group:${newGroupId}`, twebPeerId: newPeerId});
          moved++;
        }
        if(rows.length < pageSize) break;
        // `before` is a strict `<` timestamp cursor: timestamp ties can
        // straddle a page boundary, so a full page that yielded nothing new
        // nudges the cursor to keep making progress.
        before = rows[rows.length - 1].timestamp;
        if(newRows === 0) before--;
      }
      if(moved > 0) {
        this.log('[GroupAPI] re-keyed', moved, 'messages for rebind', oldGroupId.slice(0, 8), '→', newGroupId.slice(-8));
      }
    } catch(err) {
      this.log.warn('[GroupAPI] message re-key for rebind failed (non-fatal):', err);
    }
  }

  /** Carry the legacy group's anti-replay watermarks over to the successor
   *  id — a control replay against the new id must not pass a zero watermark. */
  private copyEventWatermarks(fromGroupId: string, toGroupId: string): void {
    for(const field of ['members', 'info', 'admin'] as const) {
      try {
        const value = localStorage.getItem(WATERMARK_PREFIX + fromGroupId + ':' + field);
        if(value !== null) {
          localStorage.setItem(WATERMARK_PREFIX + toGroupId + ':' + field, value);
        }
      } catch{ /* best-effort — private mode etc. */ }
    }
  }

  /** Live record that was rebound FROM `legacyId`, or null. */
  private async findSuccessorBySupersededId(legacyId: string, excludeGroupId?: string): Promise<GroupRecord | null> {
    try {
      const all = await this.store.getAll();
      return all.find((r) => r.groupId !== excludeGroupId && (r.supersededGroupIds ?? []).includes(legacyId)) ?? null;
    } catch{
      return null;
    }
  }

  /** Migrate a legacy group THIS DEVICE ADMINS onto a fresh bound id and
   *  broadcast the supersede create. Admin-only, legacy-only. Publish happens
   *  BEFORE any local mutation (nothing to roll back on failure — receivers
   *  simply never hear about it and the legacy id stays). */
  async rebindLegacyGroup(oldGroupId: string): Promise<string> {
    const group = await this.store.get(oldGroupId);
    if(!group) {
      throw new Error(`rebindLegacyGroup: group not found: ${oldGroupId.slice(0, 8)}`);
    }
    if(boundGroupAdmin(oldGroupId)) {
      throw new Error(`rebindLegacyGroup: group id is already bound: ${oldGroupId.slice(0, 8)}`);
    }
    if(!LEGACY_ID_RE.test(oldGroupId)) {
      throw new Error(`rebindLegacyGroup: not a legacy group id: ${oldGroupId.slice(0, 8)}`);
    }
    if(group.adminPubkey !== this.ownPubkey) {
      throw new Error('rebindLegacyGroup: only the admin can rebind a group');
    }

    const newGroupId = mintBoundGroupId(this.ownPubkey);
    const peerId = await groupIdToPeerId(newGroupId);
    const nowMs = Date.now();
    const payload: GroupControlPayload = {
      type: 'group_create',
      groupId: newGroupId,
      groupName: group.name,
      groupDescription: group.description,
      memberPubkeys: group.members,
      adminPubkey: this.ownPubkey,
      supersedesGroupId: oldGroupId
    };

    const others = group.members.filter((m) => m !== this.ownPubkey);
    let controlWraps;
    try {
      controlWraps = broadcastGroupControl(this.ownSk, others, payload);
    } catch(err) {
      this.log.warn('[GroupAPI] rebindLegacyGroup: broadcastGroupControl threw before local mutation:', err);
      throw err;
    }
    await this.publishFn(controlWraps);

    const record: GroupRecord = {
      groupId: newGroupId,
      name: group.name,
      description: group.description,
      adminPubkey: this.ownPubkey,
      members: group.members,
      peerId,
      createdAt: nowMs,
      updatedAt: nowMs,
      // The user's own migration gesture (#180): only the initiator stamps.
      deliberateAddAt: nowMs,
      supersededGroupIds: [oldGroupId],
      reboundAt: Math.floor(nowMs / 1000)
    };
    await this.commitLegacyMigration(record, {deliberate: true, teardownLegacy: true});
    this.log('[GroupAPI] rebound legacy group:', oldGroupId.slice(0, 8), '→', newGroupId.slice(-8));
    return newGroupId;
  }

  /** Rebind every legacy group this device admins. Skips groups another of
   *  this user's devices already rebound (successor admin is us); a successor
   *  whose admin is NOT us is a forged claim and never stops the rebind. */
  async rebindAllLegacyGroups(): Promise<number> {
    let all: GroupRecord[];
    try {
      all = await this.store.getAll();
    } catch(err) {
      this.log.warn('[GroupAPI] rebindAllLegacyGroups: store read failed:', err);
      return 0;
    }
    let count = 0;
    // Reconcile ONCE up front, not once per already-rebound successor — the
    // sweep is a full-store walk per call (Lena review nit, PR #195).
    await this.reconcileSupersededGroups();
    for(const group of all) {
      if(boundGroupAdmin(group.groupId)) continue;
      if(group.adminPubkey !== this.ownPubkey) continue;
      const successor = await this.findSuccessorBySupersededId(group.groupId);
      // Authority from the successor's BOUND ID, not its record's adminPubkey
      // field (attacker-mouldable once a forged record enters the CRDT union).
      if(successor && boundGroupAdmin(successor.groupId) === this.ownPubkey) {
        // Another own device already migrated it — the up-front reconcile
        // already handled local retirement for it.
        continue;
      }
      try {
        await this.rebindLegacyGroup(group.groupId);
        count++;
      } catch(err) {
        this.log.warn('[GroupAPI] auto-rebind failed for legacy group', group.groupId.slice(0, 8), err);
      }
    }
    return count;
  }

  /** Retire live records whose successor already exists — the resurrection
   *  corner where a #180 deliberate stamp let a legacy record win a merge
   * against its own durable delete row. Gated on the successor's ID-DERIVED
   * admin (bound id) matching the live legacy record's admin: the record's
   * own adminPubkey field is attacker-mouldable data once a forged record
   * with a spoofed field and a claimed supersededGroupIds enters the CRDT
   * union, and must never be able to drive the sweep (Lena review
   * 2026-10-04). Only bound successors may drive it at all. */
  /** Watermark max-merge for successor convergence: the winner inherits the
   *  HIGHER control watermark of the two, so a replayed control event the
   *  loser already saw can never slip past the winner's gate. */
  private mergeEventWatermarks(fromGroupId: string, toGroupId: string): void {
    for(const field of ['members', 'info', 'admin'] as const) {
      try {
        const from = localStorage.getItem(WATERMARK_PREFIX + fromGroupId + ':' + field);
        if(from === null) continue;
        const to = localStorage.getItem(WATERMARK_PREFIX + toGroupId + ':' + field);
        if(to === null || (parseInt(from, 10) || 0) > (parseInt(to, 10) || 0)) {
          localStorage.setItem(WATERMARK_PREFIX + toGroupId + ':' + field, from);
        }
      } catch{ /* best-effort — private mode etc. */ }
    }
  }

  /** Converge competing rebind successors of the same legacy id from RECORDS
   *  alone (duplicate-groups regression 2026-10-04). The create-message
   *  competitor branch is unreachable when a successor first arrives as a
   *  synced record — and for the admin's own racing devices it is NEVER
   *  reachable: rebindLegacyGroup filters members by pubkey, all own devices
   *  share one, so the rival's supersede create is never sent here and the
   *  rival successor arrives ONLY via sync. Two live successors of one group
   *  then coexist forever: the duplicate-group state.
   *
   *  Deterministic winner max(reboundAt, groupId), the same rule as the
   *  message path. Same-admin only — the documented race is one user's own
   *  devices; a rival bound to a DIFFERENT admin is the forged-claim case
   *  the create path already gates, and resolution must never tear the real
   *  successor down over it. */
  private async resolveCompetingSuccessors(legacyId: string): Promise<void> {
    let all: GroupRecord[];
    try {
      all = await this.store.getAll();
    } catch{
      return;
    }
    const byAdmin = new Map<string, GroupRecord[]>();
    for(const record of all) {
      const admin = boundGroupAdmin(record.groupId);
      if(!admin) continue;
      if(!(record.supersededGroupIds ?? []).includes(legacyId)) continue;
      const list = byAdmin.get(admin) ?? [];
      list.push(record);
      byAdmin.set(admin, list);
    }
    for(const successors of byAdmin.values()) {
      if(successors.length < 2) continue;
      let winner = successors[0];
      for(const candidate of successors) {
        const w = winner.reboundAt ?? 0;
        const c = candidate.reboundAt ?? 0;
        if(c > w || (c === w && candidate.groupId > winner.groupId)) {
          winner = candidate;
        }
      }
      for(const loser of successors) {
        if(loser.groupId === winner.groupId) continue;
        // History FIRST — teardownGroupLocally purges the loser's
        // conversation; rows move by upsert so shared eventIds (the
        // pre-divergence history both inherited from the legacy id) merge,
        // and the loser's post-divergence rows land in the winner intact.
        await this.rekeyGroupMessages(loser.groupId, winner.groupId, winner.peerId);
        this.mergeEventWatermarks(loser.groupId, winner.groupId);
        await this.teardownGroupLocally(loser.groupId);
        this.log('[GroupAPI] converged competing rebind successors:', loser.groupId.slice(-8), '→', winner.groupId.slice(-8));
      }
      schedulePublish('groups');
    }
  }

  /** Retire live records whose successor already exists — the resurrection
   *  corner where a #180 deliberate stamp let a legacy record win a merge
   * against its own durable delete row. Gated on the successor's ID-DERIVED
   * admin (bound id) matching the live legacy record's admin: the record's
   *  own adminPubkey field is attacker-mouldable data once a forged record
   * with a spoofed field and a claimed supersededGroupIds enters the CRDT
   *  union, and must never be able to drive the sweep (Lena review
   * 2026-10-04). Only bound successors may drive it at all. */
  /** (#198) Converge UNLINKED twins: a live record that carries no rebind
   *  provenance (no supersededGroupIds, no reboundAt) but is otherwise an
   *  exact twin of a live linked rebind successor — same id-derived admin,
   *  same name, identical member set. resolveCompetingSuccessors can never
   *  see these pairs because it matches on a shared legacy id in
   *  supersededGroupIds, and the unlinked twin (minted by a replayed create
   *  path) claims none — observed live: two "Phantomyard" records, one with
   *  provenance, one without, coexisting forever.
   *
   *  (#199 review, Kai blocker) This sweep is DETECTION-ONLY — it never
   *  converges. Destructive convergence needs POSITIVE shared lineage, and
   *  for an unlinked twin none exists: record fields (admin/name/members)
   *  are mutable presentation data a legitimate second group by the same
   *  admin reproduces exactly (proven by review regression), deliberateAddAt
   *  only proves absence-of-deliberate-create on THIS device (a relay-received
   *  create is locally unstamped until its CRDT entry applies), and shared
   *  eventIds are structurally impossible — the message store upserts by a
   *  UNIQUE eventId index, so one event id lives in exactly ONE conversation
   *  and two conversations can never intersect. With no positive proof, a
   *  teardown would be a guess that can destroy a legitimate group — so the
   *  candidate is flagged in the log for manual deletion (native group delete
   * is durable and syncs) and left strictly alone. Fail-safe direction: a
   *  duplicate may survive; a distinct group is never destroyed. */
  private async convergeUnlinkedTwinSuccessors(): Promise<void> {
    let all: GroupRecord[];
    try {
      all = await this.store.getAll();
    } catch{
      return;
    }
    const linked = all.filter((r) =>
      (r.supersededGroupIds ?? []).length > 0 &&
      r.reboundAt &&
      boundGroupAdmin(r.groupId)
    );
    if(linked.length === 0) return;
    for(const winner of linked) {
      const admin = boundGroupAdmin(winner.groupId);
      const winnerMembers = [...winner.members].sort().join(',');
      for(const twin of all) {
        if(twin.groupId === winner.groupId) continue;
        // no provenance of its own — a deliberate rebind or a linked
        // successor is NEVER a twin candidate.
        if((twin.supersededGroupIds ?? []).length > 0 || twin.reboundAt) continue;
        if(boundGroupAdmin(twin.groupId) !== admin) continue;
        if(twin.name !== winner.name) continue;
        if([...twin.members].sort().join(',') !== winnerMembers) continue;
        // vanished since the sweep started (a rival pass already retired it)
        if(!(await this.store.get(twin.groupId))) continue;
        // (#199 review) DETECTED but never converged — see doc block. The
        // admin can delete the duplicate with the native (durable, synced)
        // group delete; nothing here may guess it away.
        this.log.warn(
          '[GroupAPI] unlinked twin candidate of linked successor', winner.groupId.slice(-8),
          '— same admin/name/members but NO positive lineage; NOT converging.',
          'Delete the unwanted duplicate manually if it is not a distinct group:', twin.groupId.slice(-8)
        );
      }
    }
  }

  async reconcileSupersededGroups(): Promise<void> {
    let all: GroupRecord[];
    try {
      all = await this.store.getAll();
    } catch{
      return;
    }
    // One resolution pass per unique legacy id — several successors of the
    // same id all converge in a single sweep.
    const resolved = new Set<string>();
    for(const record of all) {
      const recordAdmin = boundGroupAdmin(record.groupId);
      if(!recordAdmin) continue;
      for(const supersededId of record.supersededGroupIds ?? []) {
        // Competing successors first (duplicate-groups regression 2026-10-04):
        // record-synced rivals must converge before the legacy retirement —
        // the winner is the group the legacy id's traffic remaps onto.
        if(!resolved.has(supersededId)) {
          resolved.add(supersededId);
          await this.resolveCompetingSuccessors(supersededId);
        }
        const live = await this.store.get(supersededId);
        if(live && live.adminPubkey === recordAdmin) {
          this.log('[GroupAPI] reconcile: retiring superseded live record:', supersededId.slice(0, 8));
          await this.teardownGroupLocally(supersededId);
        }
      }
    }
    // (#198) Then the unlinked twins — they share no legacy id with any
    // successor, so the legacy-id sweep above can never reach them.
    await this.convergeUnlinkedTwinSuccessors();
  }

  /**
   * (#198 dogfood finding) Sweep the chat list for dialogs in the group peer
   * range whose backing group record no longer exists and drop them.
   *
   * Every teardown before this fix dispatched only the bare 'dialog_drop'
   * event, which flushes message storages but leaves the persisted dialogs row
   * in tweb-account-N untouched — so groups deleted via rebind migrations,
   * legacy retirements or twin convergence kept rendering on every boot. This
   * sweep self-heals those rows: it runs AFTER a definitive groups sync
   * reconcile (records are loaded by then), so a dialog whose record is
   * missing is by definition orphaned.
   *
   * Safety: if the group store can't be read (e.g. a schema VersionError on an
   * older build), we abort WITHOUT dropping anything — a blind store must
   * never be interpreted as "no live groups".
   */
  async dropOrphanGroupDialogs(): Promise<void> {
    let livePeerIds: Set<number>;
    try {
      livePeerIds = new Set((await this.store.getAll()).map((r) => r.peerId));
    } catch{
      this.log.warn('[GroupAPI] dropOrphanGroupDialogs: group store unreadable, skipping');
      return;
    }

    let dialogs: any[];
    try {
      const result = await rootScope.managers.dialogsStorage.getDialogs({limit: 1000, forceLocal: true});
      dialogs = (result?.dialogs || []) as any[];
    } catch{
      // dialogs storage not ready yet — nothing to sweep this boot; the next
      // post-sync reconcile retries idempotently.
      return;
    }

    let dropped = 0;
    for(const dialog of dialogs) {
      const peerId = dialog?.peerId;
      if(typeof peerId !== 'number' || !isGroupPeer(peerId)) continue;
      if(livePeerIds.has(peerId)) continue;
      try {
        rootScope.managers.dialogsStorage.dropDialogOnDeletion(peerId);
        dropped++;
        this.log('[GroupAPI] dropped orphan group dialog:', peerId);
      } catch(err) {
        this.log.warn('[GroupAPI] dropOrphanGroupDialogs: drop failed for', peerId, err);
      }
    }
    if(dropped > 0) {
      this.log('[GroupAPI] dropOrphanGroupDialogs: swept', dropped, 'orphan dialog(s)');
    }
  }

  private async handleAddMember(payload: GroupControlPayload): Promise<boolean> {
    if(!payload.memberPubkeys || payload.memberPubkeys.length === 0) {
      return false;
    }
    await this.store.updateMembers(payload.groupId, payload.memberPubkeys);
    this.log('[GroupAPI] group_add_member:', payload.targetPubkey?.slice(0, 8));
    return true;
  }

  private async handleRemoveMember(payload: GroupControlPayload, senderPubkey: string): Promise<boolean> {
    if(payload.targetPubkey === this.ownPubkey) {
      // We were removed — FULL durable teardown, same as leaveGroup /
      // deleteGroup / handleGroupDelete (issue #181, mirroring
      // teardownGroupLocally post-#179): the kick must be a POSITIVE delete
      // fact, not an absence. Previously this path only did store.delete +
      // mirror cleanup — no durable deletedGroups row, no conversation
      // tombstone — so a kicked device contributed only an ABSENCE to the
      // union merge and another own device's live record re-materialised the
      // group via apply(). teardownGroupLocally records the durable row
      // BEFORE the store delete (strict precondition), then tombstones the
      // conversation so replayed group_create/group rumors stay gated. A
      // re-invite still works: a fresh group_create (ts > deletedAt) passes
      // the tombstone gate, outranks the durable row on strict LWW, and
      // apply() drops the row on the deliberate re-create.
      //
      // SENDER AUTHENTICATION (Lena's review of #183): promoting this path
      // to a durable cross-device delete fact means an unauthenticated
      // sender could forge a kick and durably delete the group on every own
      // device — the exact hole #182/#184 close for group_delete, reopened
      // through the kick path. So: when a record exists, only its admin may
      // kick (a non-admin control is rejected with NO durable write); when
      // no record exists we cannot verify anyone, so we fail closed like
      // #184 — zombie-mirror cleanup only, no durable row and no tombstone
      // from an unverified sender. The legit kick always arrives while the
      // record is still live (you were a member), so the verified path is
      // the common case.
      const group = await this.store.get(payload.groupId);
      if(group && group.adminPubkey !== senderPubkey) {
        this.log.warn('[GroupAPI] ignoring group_remove_member(self) from non-admin', senderPubkey.slice(0, 8), 'for', payload.groupId.slice(0, 8));
        return false;
      }
      if(!group) {
        // No record: nothing verifiable, nothing to tear down durably.
        // Mirror cleanup only — the durable row and tombstone stay reserved
        // for an authenticated admin kick against a live record.
        const peerId = await groupIdToPeerId(payload.groupId);
        await cleanupGroupChatInjection(peerId);
        this.log('[GroupAPI] group_remove_member(self) for unknown group; mirror cleanup only:', payload.groupId.slice(0, 8));
        return false;
      }
      await this.teardownGroupLocally(payload.groupId);
      this.log('[GroupAPI] removed from group:', payload.groupId);
      return true;
    }
    const group = await this.store.get(payload.groupId);
    // Only the admin may remove another member — a non-admin sender must
    // use group_leave for themselves (see handleMemberLeave). Without this
    // check any sender could delete an arbitrary member from my local view
    // (pre-existing on main, closed here since this handler is being
    // authenticated anyway).
    if(!group || group.adminPubkey !== senderPubkey || !group.members.includes(payload.targetPubkey)) {
      return false;
    }
    const remaining = group.members.filter(m => m !== payload.targetPubkey);
    await this.store.updateMembers(payload.groupId, remaining);
    return true;
  }

  /**
   * Apply an incoming `group_delete` (admin deleted the group for everyone).
   * Only the group's CURRENT admin may delete; a delete from anyone else is
   * ignored to stop a non-admin from nuking a group on other members'
   * devices. The proven `senderPubkey` (rumor.pubkey) is checked against our
   * record's adminPubkey — for bound ids the current admin may legitimately
   * differ from the id-bound creator (admin transfer), so the binding never
   * gates a delete against a live record. If we have no record, there is no
   * trusted admin key to validate against — except for bound ids, where a
   * sender ≠ the id-bound key is rejected outright (it could never
   * authenticate later). The id-bound admin's delete is quarantined in
   * bounded, expiring memory so a reordered create can authenticate it
   * later, but we do not mutate or persist any group state.
   */
  private async handleGroupDelete(payload: GroupControlPayload, senderPubkey: string, createdAt: number): Promise<void> {
    // QUARANTINE FLOOD HYGIENE (#182 close-out): for a bound id, a delete
    // from any sender other than the id-bound key can NEVER be promoted —
    // the only create that can later verify a quarantined delete mints
    // admin = that same key — and a live record never consults the
    // quarantine at all (its authority is the CURRENT stored admin).
    // Staging such a delete anyway handed an attacker the eviction lever
    // on the bounded quarantine: 512 concurrent forged deletes transiently
    // occupied the map, and its oldest-received eviction dropped a
    // legitimate pending admin delete that a reordered create could
    // otherwise have promoted (resurrecting the group on this device).
    // Skip the stage for the permanently-unpromotable sender; every
    // authority check below is unchanged. Promotable senders — the
    // id-bound key itself, and every sender on a legacy id — keep the
    // stage-before-first-await invariant so a concurrent group_create
    // cannot pass both of its pending-delete checks while this handler
    // is suspended.
    // The per-sender cap in rememberPendingGroupDelete closes the single-key
    // self-bound-id lever (#193): a flooding key evicts its own oldest fact.
    // Residual limit: distinct Sybil identities are indistinguishable from
    // legitimate admins. Global eviction therefore provides each sender a
    // fair share, but enough identities can still shrink another sender's
    // share and displace its oldest pending facts.
    const boundAdmin = boundGroupAdmin(payload.groupId);
    if(!(boundAdmin && boundAdmin !== senderPubkey)) {
      this.rememberPendingGroupDelete(payload.groupId, senderPubkey, createdAt);
    }
    const group = await this.store.get(payload.groupId);
    if(!group) {
      // ID-BOUND FAIL-CLOSED, no-record path only (#188): with no record
      // there is exactly one key a delete could ever authenticate against
      // for a bound id — the one baked into the id itself. The only create
      // that can later verify a quarantined delete mints admin = that same
      // key, so any other sender can never promote and would only pollute
      // the bounded quarantine. Such a delete was already rejected at the
      // stage above — never staged, so there is nothing to unstage here;
      // the id-bound admin's delete still falls through to the quarantine
      // below, where a reordered create can authenticate it.
      // ACCEPTED DIVERGENCE (Robert, #190): quarantine reordering covers
      // only the id-bound creator's delete. A LATER admin's delete (post
      // transfer or leave-promotion) arriving on a no-record device before
      // the create cannot be authenticated against the id, is rejected
      // here, and NOTHING re-sends it — after the create + transfer replay
      // this device keeps a live record for a group the fleet deleted.
      // Fail-closed is the cost: staging it would let an unauthenticated
      // sender promote a durable delete, and no resend protocol exists
      // (same accepted outcome on main for legacy ids, where the
      // quarantined sender never matches the create's admin).
      if(boundAdmin && boundAdmin !== senderPubkey) {
        this.log.warn('[GroupAPI] ignoring group_delete: sender is not the id-bound admin', senderPubkey.slice(0, 8), 'for', payload.groupId.slice(0, 8));
        return;
      }
      this.log.warn('[GroupAPI] quarantined unverifiable group_delete for unknown group', payload.groupId.slice(0, 8));
      return;
    }
    // Live record: the CURRENT admin is the delete authority — NOT the
    // id-bound creator. transferAdmin() and handleMemberLeave() both
    // legitimately move adminPubkey off the bound key, and a bound-key
    // check here would make every bound group undeletable after an admin
    // transfer (new admin fails the bound key; original creator passes it
    // only to fail this stored-admin check). The stored key still has
    // verifiable lineage: bound creates mint admin = the id-bound key, and
    // handleAdminTransfer only applies transfers from the sitting admin —
    // so a stored admin for a bound id always descends from the binding
    // through authenticated steps.
    if(group.adminPubkey !== senderPubkey) {
      this.clearPendingGroupDeletes(payload.groupId, senderPubkey);
      this.log.warn('[GroupAPI] ignoring group_delete from non-admin', senderPubkey.slice(0, 8), 'for', payload.groupId.slice(0, 8));
      return;
    }
    this.clearPendingGroupDeletes(payload.groupId);
    await this.teardownGroupLocally(payload.groupId);
    this.log('[GroupAPI] group deleted by admin:', payload.groupId.slice(0, 8));
  }

  private async handleMemberLeave(payload: GroupControlPayload, senderPubkey: string): Promise<boolean> {
    const group = await this.store.get(payload.groupId);
    if(!group || !group.members.includes(senderPubkey)) {
      return false;
    }
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
    this.log('[GroupAPI] member left group:', senderPubkey.slice(0, 8));
    return true;
  }

  private async handleInfoUpdate(payload: GroupControlPayload, senderPubkey: string): Promise<boolean | void> {
    const group = await this.store.get(payload.groupId);
    if(!group) {
      this.log('[GroupAPI] group_info_update for unknown group, ignoring:', payload.groupId.slice(0, 8));
      return false;
    }
    // Only the current admin may broadcast info changes — same sender
    // validation as group_delete / group_admin_transfer. Without this, any
    // member could rename the group for everyone, and (since the avatar
    // field is now actually dereferenced) make every other member's client
    // fetch an arbitrary URL — an IP/User-Agent beacon plus identity spoof.
    if(group.adminPubkey !== senderPubkey) {
      this.log.warn('[GroupAPI] ignoring group_info_update from non-admin', senderPubkey.slice(0, 8), 'for', payload.groupId.slice(0, 8));
      return false;
    }
    if(!isSafeGroupAvatarUrl(payload.groupAvatar)) {
      this.log.warn('[GroupAPI] ignoring group_info_update with non-Blossom avatar URL for', payload.groupId.slice(0, 8));
      return false;
    }
    await this.store.updateInfo(payload.groupId, {
      name: payload.groupName,
      description: payload.groupDescription,
      avatar: payload.groupAvatar
    });

    // Drop the avatarNew memo so a changed avatar renders on the next
    // cycle instead of lagging up to the 30s TTL.
    try {
      const {invalidateGroupAvatarCache} = await import('@components/avatarNew');
      invalidateGroupAvatarCache(group.peerId);
    } catch(err) {
      this.log.warn('[GroupAPI] avatar cache invalidation non-critical:', err);
    }

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

  private async handleAdminTransfer(payload: GroupControlPayload, senderPubkey: string): Promise<boolean | void> {
    const group = await this.store.get(payload.groupId);
    if(!group || !payload.adminPubkey) {
      // Applied nothing: the record is gone or the target is missing, so
      // the watermark must not advance (a falsy return reads as applied).
      return false;
    }
    // Only the current admin may transfer. senderPubkey is the proven
    // rumor pubkey (same validation as group_delete) — without this check
    // any member could gift-wrap themselves into power.
    if(group.adminPubkey !== senderPubkey) {
      this.log.warn('[GroupAPI] ignoring group_admin_transfer from non-admin', senderPubkey.slice(0, 8), 'for', payload.groupId.slice(0, 8));
      return false;
    }
    group.adminPubkey = payload.adminPubkey;
    group.updatedAt = Date.now();
    await this.store.save(group);
    return true;
  }

  /**
   * Transfer admin rights to another member. Only the current admin can
   * transfer. Broadcasts `group_admin_transfer` so every member's client
   * updates its record, then applies locally. The receive handler existed
   * but nothing ever sent the message type — there was no voluntary
   * transfer path (an old admin could only hand over by leaving).
   */
  async transferAdmin(groupId: string, newAdminPubkey: string): Promise<void> {
    const group = await this.store.get(groupId);
    if(!group) throw new Error(`Group not found: ${groupId}`);
    if(group.adminPubkey !== this.ownPubkey) throw new Error('Only admin can transfer admin rights');
    if(!group.members.includes(newAdminPubkey)) {
      throw new Error(`transferAdmin: target ${newAdminPubkey.slice(0, 8)}… is not a member`);
    }
    if(newAdminPubkey === this.ownPubkey) return; // idempotent no-op

    const payload: GroupControlPayload = {
      type: 'group_admin_transfer',
      groupId,
      adminPubkey: newAdminPubkey
    };

    let controlWraps;
    try {
      controlWraps = broadcastGroupControl(this.ownSk, group.members, payload);
    } catch(err) {
      this.log.warn('[GroupAPI] transferAdmin: broadcastGroupControl threw before local mutation:', err);
      throw err;
    }

    group.adminPubkey = newAdminPubkey;
    group.updatedAt = Date.now();
    await this.store.save(group);

    try {
      await this.publishFn(controlWraps);
    } catch(err) {
      // Roll the local view back so it re-converges with peers on next merge.
      group.adminPubkey = this.ownPubkey;
      await this.store.save(group);
      throw err;
    }

    this.log('[GroupAPI] admin transferred:', groupId.slice(0, 8), '->', newAdminPubkey.slice(0, 8));
    schedulePublish('groups');
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
  // #188 remainder: retire legacy ids as soon as the API exists — rebind
  // every legacy group this device admins (once per group; a bound record is
  // never rebound) and reconcile any resurrection corner. Fire-and-forget:
  // a failed broadcast rolls back (nothing was written) and the next startup
  // retries. Decision point flagged on #188 — see the rebind design comment.
  void _instance.reconcileSupersededGroups().catch((err) => {
    console.warn('[GroupAPI] init reconcileSupersededGroups failed:', err);
  });
  void _instance.rebindAllLegacyGroups().catch((err) => {
    console.warn('[GroupAPI] init rebindAllLegacyGroups failed:', err);
  });
  return _instance;
}
