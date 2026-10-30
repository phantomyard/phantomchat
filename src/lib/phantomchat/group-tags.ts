/**
 * Group tags — the Code folder's membership rule (2026-10-30).
 *
 * A group can carry tags. Today there is exactly one: `session`, set when the
 * group is created from the Code folder's + button. A session group is only
 * ever visible in the Code folder: Chats (0) and Groups (3) exclude it, the
 * Code folder lists nothing else, and both rules live on the SAME predicate so
 * they cannot drift apart.
 *
 * WHY A SYNCHRONOUS INDEX. Folder membership is decided in hot, synchronous
 * paths (`FiltersStorage.testDialogForFilter`, `DialogsStorage
 * .getFolderDialogs`, `AutonomousDialogList.testDialogForFilter`) that cannot
 * await IndexedDB. The group store is the cold tier; `GroupStore.save/delete/
 * getAll` therefore mirror the session flag into the set below, exactly the
 * way the group peer check works from `group-types.isGroupPeer`. An empty set
 * before hydration is the conservative answer: a session group shows up in
 * Chats until the store has been read once — never the other way round, which
 * would make a chat disappear.
 *
 * SYNC. `GroupRecord.tags` rides the groups CRDT (the whole record is the sync
 * payload, so no schema bump), and a non-creating member learns the tag from
 * `group_create.groupTags` / `group_info_update.groupTags`. Old clients ignore
 * the unknown JSON field — a session just shows up in their Chats instead of
 * the Code folder, visible and never stranded.
 */

/** The one tag we understand today. Unknown tags are dropped on the wire. */
export const SESSION_TAG = 'session';

/** Name a session group is created with; the first prompt replaces it. */
export const DEFAULT_SESSION_GROUP_NAME = 'New session';

/** How many characters of the first prompt become the group name. */
export const SESSION_NAME_PREFIX_LENGTH = 10;

/** Tags we accept from a control payload. Anything else is discarded, so a
 * peer can never mint arbitrary tag vocabulary on our side. */
const KNOWN_TAGS: ReadonlySet<string> = new Set([SESSION_TAG]);

/** Filter a wire-supplied tag list down to the tags we understand. Returns
 * `undefined` for "no usable tags", which is also the "field absent" answer —
 * both mean "leave whatever the local record has alone". */
export function sanitizeGroupTags(raw: unknown): string[] | undefined {
  if(!Array.isArray(raw)) return undefined;
  const tags = [...new Set(raw.filter((t): t is string => typeof t === 'string' && KNOWN_TAGS.has(t)))];
  return tags.length ? tags : undefined;
}

export function hasSessionTag(tags?: readonly string[]): boolean {
  return !!tags?.includes(SESSION_TAG);
}

// ─── Synchronous session index ──────────────────────────────────────

const sessionPeerIds = new Set<number>();

/** True when this peer is a session group. Synchronous by design. */
export function isSessionPeer(peerId: number): boolean {
  return sessionPeerIds.has(peerId);
}

/** Mirror ONE group's session flag into the index (upsert path). */
export function syncSessionPeer(peerId: number, tags?: readonly string[]): void {
  if(!Number.isFinite(peerId)) return;
  if(hasSessionTag(tags)) sessionPeerIds.add(peerId);
  else sessionPeerIds.delete(peerId);
}

/** Drop a peer from the index (group delete / leave / teardown). */
export function forgetSessionPeer(peerId: number): void {
  sessionPeerIds.delete(peerId);
}

/**
 * Rebuild the index from a full group-store read. Wholesale, not additive:
 * a record that lost its tag (or a group that no longer exists) must fall out,
 * so this is the one path that can shrink the set.
 */
export function syncSessionPeers(records: Iterable<{peerId?: number, tags?: readonly string[]}>): boolean {
  let changed = false;
  const next = new Set<number>();
  for(const record of records) {
    const peerId = record?.peerId;
    if(typeof peerId !== 'number' || !Number.isFinite(peerId)) continue;
    if(hasSessionTag(record.tags)) next.add(peerId);
  }

  if(next.size !== sessionPeerIds.size) changed = true;
  if(!changed) {
    for(const peerId of next) {
      if(!sessionPeerIds.has(peerId)) { changed = true; break; }
    }
  }

  sessionPeerIds.clear();
  for(const peerId of next) sessionPeerIds.add(peerId);
  return changed;
}

/** Test seam: empty the index. */
export function clearSessionPeers(): void {
  sessionPeerIds.clear();
}

// ─── Naming ─────────────────────────────────────────────────────────

/**
 * The name a session group takes from its first prompt: the first 10
 * characters, with an ellipsis when something was left out. Whitespace is
 * collapsed first so a multi-line prompt does not produce a name full of gaps.
 */
export function sessionTitleFromPrompt(text: string, limit = SESSION_NAME_PREFIX_LENGTH): string {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if(!normalized) return '';
  if(normalized.length <= limit) return normalized;
  return normalized.slice(0, limit) + '…';
}

/**
 * Merge rule for the CRDT apply path. The groups sync payload IS the record,
 * so an older client that renames a session group republishes it WITHOUT the
 * `tags` field and would otherwise drop the tag for everyone. Absent tags on
 * the incoming record therefore mean "unchanged", never "cleared".
 */
export function mergeRecordTags(
  localTags: readonly string[] | undefined,
  incomingTags: readonly string[] | undefined
): string[] | undefined {
  if(incomingTags && incomingTags.length) return [...incomingTags];
  if(localTags && localTags.length) return [...localTags];
  return undefined;
}
