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
 *   create   — mint the group from the ✏️ menu (`New Code Session`), title
 *              EMPTY and `hasPrompt: false`: the rail shows `New session`
 *   first    — the first outgoing message names it: first 10 chars + …
 *   rename   — group name + session title; kills auto-naming forever
 *   archive  — local intent, synced through the code-sessions CRDT domain
 *   delete   — TOMBSTONE the session (every device drops the row). The group
 *              record and the phantom's `group:<id>` history are deliberately
 *              left alone: Andrew's rule is "do not delete any history from the
 *              server side or phantom turn history".
 *
 * There is NO mid-session phantom switch: the phantom chosen when the session
 * is created is the one it talks to for life (Andrew, 2026-10-29).
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
 * Create an EMPTY session for one phantom: the group is minted, the record is
 * saved with no title, and the rail shows `New session` until the first
 * message names it.
 *
 * This is what `New Code Session` in the ✏️ menu calls — the picker is the
 * thing that chooses the phantom, so creation cannot wait for a prompt.
 */
export async function createPendingSession(peerPubkey: string): Promise<CreateSessionResult> {
  // The group needs *a* name for the control messages; the rail never shows it
  // (session groups are kept out of the chat list) and the real title lands
  // with the first message.
  const groupName = 'New session';

  const groupId = await groupAPI().createGroup(groupName, [peerPubkey], undefined, {sessionGroup: true});
  const peerId = await sessionPeerId(groupId);
  const now = Date.now();

  await saveSession({
    groupId,
    title: '',
    autoNamed: false,
    archived: false,
    peerPubkey,
    createdAt: now,
    updatedAt: now,
    hasPrompt: false
  });

  // Not in the chat list (session group), but the chat/peer entries must
  // exist before the right pane can render the transcript.
  try {
    await ensureGroupChatInjected(groupId, peerId);
  } catch(err) {
    console.warn(LOG_PREFIX, 'createPendingSession: chat injection failed', err);
  }

  notifyChanged('created');
  return {groupId, peerId, title: ''};
}

/**
 * The first message of a session names it `<first 10 chars>…`.
 *
 * Idempotent and a no-op for every later message (and for a session that was
 * already renamed), so it is safe to call from the send path on every send.
 * Returns the title it applied, or null when nothing changed.
 */
export async function applyFirstPromptTitle(groupId: string, prompt: string): Promise<string | null> {
  const record = await getSession(groupId);
  if(!record) return null;
  if(record.hasPrompt !== false) return null;
  // A rename while pending wins over the auto-title, permanently.
  if(record.autoNamed === false && record.title) return null;

  const title = autoSessionTitle(prompt);
  if(!title) return null;

  try {
    await groupAPI().renameGroup(groupId, title);
  } catch(err) {
    // The rail title is what the user sees; a failed group rename must not
    // leave the session un-named.
    console.warn(LOG_PREFIX, 'applyFirstPromptTitle: group rename failed', err);
  }

  await saveSession({
    ...record,
    title,
    autoNamed: true,
    hasPrompt: true,
    updatedAt: Date.now()
  });

  notifyChanged('named');
  return title;
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
