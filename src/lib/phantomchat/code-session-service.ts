/**
 * code-session-service — the lifecycle of a Code Mode session.
 *
 * A session is a 2-member PRIVATE GROUP (you + one phantom) flagged
 * `sessionGroup`. That choice is the whole trick (#279): phantombot already
 * threads every group message under a `group:<groupId>` conversation, so each
 * session is a genuinely independent phantom conversation with zero protocol
 * change — two sessions with the SAME phantom do not share context, and the
 * transcript is the group's own real message history.
 *
 * Session groups are never injected into the chat list (see
 * injectGroupCreateDialog), so they cannot clutter All Chats / Groups; the
 * Code rail is the only place they are rendered.
 *
 * Lifecycle:
 *   create   — mint the group on the first prompt, title = first 10 chars + …
 *   rename   — group name + session title; kills auto-naming forever
 *   archive  — local intent, synced through the code-sessions CRDT domain
 *   delete   — TOMBSTONE the session (every device drops the row). The group
 *              record and the phantom's `group:<id>` history are deliberately
 *              left alone: Andrew's rule is "do not delete any history from the
 *              server side or phantom turn history".
 */

import {autoSessionTitle, CODE_SESSIONS_CHANGED_EVENT} from '@lib/code-mode';
import {getGroupAPI, type GroupAPI} from './group-api';
import {getGroupStore} from './group-store';
import {groupIdToPeerId, type GroupRecord} from './group-types';
import {ensureGroupChatInjected} from './phantomchat-groups-sync';
import {
  deleteSession as deleteSessionRecord,
  deleteSessionRuntime,
  getAllSessions,
  getSession,
  recordSessionDeleted,
  saveSession,
  type CodeSessionRecord
} from './code-sessions-db';

const LOG_PREFIX = '[CodeSessions]';

/** Own hex pubkey, set once onboarding completes. */
export function getOwnPubkey(): string {
  return (window as any).__phantomchatOwnPubkey || '';
}

function ownPubkeySafe(): string {
  try {
    return getOwnPubkey();
  } catch{
    return '';
  }
}

function notifyChanged(reason: string): void {
  // Cross-device: the session list is synced through the `code-sessions` CRDT
  // domain (registered at boot — a no-op before that).
  void import('./phantomchat-sync-triggers').then(({schedulePublish}) => {
    schedulePublish('code-sessions');
  }).catch(() => {});

  try {
    // Lazy import keeps this module usable from tests and non-DOM contexts.
    void import('@lib/rootScope').then(({default: rootScope}) => {
      rootScope.dispatchEvent(CODE_SESSIONS_CHANGED_EVENT as any, reason as any);
    }).catch(() => {});
  } catch{ /* no event bus — the caller re-reads */ }
}

function groupAPI(): GroupAPI {
  return getGroupAPI();
}

/** The phantom a session talks to: the member that is not us. */
export function sessionPeerPubkey(group: Pick<GroupRecord, 'members'>, ownPubkey = ownPubkeySafe()): string {
  const others = (group.members || []).filter((member) => member && member !== ownPubkey);
  return others[0] || '';
}

/** Peer id of a session's group chat (negative, `GROUP_PEER_BASE` range). */
export async function sessionPeerId(groupId: string): Promise<number> {
  const group = await getGroupStore().get(groupId);
  if(group?.peerId) return group.peerId;
  return groupIdToPeerId(groupId);
}

export interface CreateSessionResult {
  groupId: string;
  peerId: number;
  title: string;
}

/**
 * Create a session and give it its auto-derived title.
 *
 * Called with the FIRST prompt: a session with no prompt never appears in the
 * rail (Andrew's spec), so there is nothing to persist before this point.
 */
export async function createSession(
  peerPubkey: string,
  firstPrompt: string
): Promise<CreateSessionResult> {
  const title = autoSessionTitle(firstPrompt);
  // A prompt could be whitespace-only in principle; the group still needs a
  // name, and the row is not rendered until a real message exists anyway.
  const groupName = title || 'New session';

  const groupId = await groupAPI().createGroup(groupName, [peerPubkey], undefined, {sessionGroup: true});
  const peerId = await sessionPeerId(groupId);
  const now = Date.now();

  await saveSession({
    groupId,
    title: groupName,
    // The title came from the prompt, so a later rename is the first thing
    // that must stop re-naming.
    autoNamed: true,
    archived: false,
    peerPubkey,
    createdAt: now,
    updatedAt: now
  });

  // Not in the chat list (session group), but the chat/peer entries must
  // exist before the right pane can render the transcript.
  try {
    await ensureGroupChatInjected(groupId, peerId);
  } catch(err) {
    console.warn(LOG_PREFIX, 'createSession: chat injection failed', err);
  }

  notifyChanged('created');
  return {groupId, peerId, title: groupName};
}

/** Sessions, newest first, with the local activity map applied by the caller. */
export async function listSessions(): Promise<CodeSessionRecord[]> {
  const sessions = await getAllSessions();
  return sessions.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
}

export async function getSessionRecord(groupId: string): Promise<CodeSessionRecord | null> {
  return getSession(groupId);
}

/**
 * Rename a session. The group's own name is updated too so the chat header and
 * the rail agree; `autoNamed` is cleared permanently, so a rename is never
 * overwritten by the auto-naming rule.
 */
export async function renameSession(groupId: string, title: string): Promise<void> {
  const clean = String(title ?? '').replace(/\s+/g, ' ').trim();
  if(!clean) return;

  const record = await getSession(groupId);
  if(!record) return;

  try {
    await groupAPI().renameGroup(groupId, clean);
  } catch(err) {
    // The session title is the authoritative one for the rail; a failed
    // group rename must not lose the user's rename locally.
    console.warn(LOG_PREFIX, 'renameSession: group rename failed', err);
  }

  await saveSession({...record, title: clean, autoNamed: false, updatedAt: Date.now()});
  notifyChanged('renamed');
}

export async function setSessionArchived(groupId: string, archived: boolean): Promise<void> {
  const record = await getSession(groupId);
  if(!record) return;
  await saveSession({...record, archived, updatedAt: Date.now()});
  notifyChanged(archived ? 'archived' : 'unarchived');
}

/**
 * Delete a session on every device (tombstone) without touching history: the
 * group record stays, and the phantom's `group:<id>` conversation is not
 * deleted server-side. Only the rail row goes.
 */
export async function deleteSessionEverywhere(groupId: string): Promise<void> {
  await recordSessionDeleted(groupId, Math.floor(Date.now() / 1000));
  await deleteSessionRecord(groupId);
  await deleteSessionRuntime(groupId);
  notifyChanged('deleted');
}

/**
 * Switch the phantom a session talks to (Andrew: "switchable mid-session").
 * Adds the new member, then removes the old one, so the group never drops to a
 * single member mid-flight. The session id and its rail row are unchanged; the
 * new phantom starts a fresh context because it is a new conversation on its
 * side.
 */
export async function switchSessionPeer(groupId: string, nextPubkey: string): Promise<void> {
  const own = ownPubkeySafe();
  const group = await getGroupStore().get(groupId);
  if(!group || !nextPubkey || nextPubkey === own) return;

  const current = sessionPeerPubkey(group, own);
  if(current === nextPubkey) return;

  const api = groupAPI();
  await api.addMember(groupId, nextPubkey);
  if(current) {
    try {
      await api.removeMember(groupId, current);
    } catch(err) {
      console.warn(LOG_PREFIX, 'switchSessionPeer: removeMember failed', err);
    }
  }

  const record = await getSession(groupId);
  if(record) await saveSession({...record, peerPubkey: nextPubkey, updatedAt: Date.now()});

  try {
    await ensureGroupChatInjected(groupId, await sessionPeerId(groupId));
  } catch{ /* non-critical */ }

  notifyChanged('switched-peer');
}
