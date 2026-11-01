/**
 * Sessions — naming helpers (owner batch 11, 2026-10-31).
 *
 * A session is a peer CLASS (see group-types.SESSION_PEER_BASE / isSessionPeer),
 * not a tagged group. This module holds the only part of a session that is pure
 * policy rather than identity: what it is called when created, and how its
 * first prompt renames it.
 *
 * The class itself lives in group-types so the classification is a scalar range
 * test available on every thread — there is deliberately NO index, no tag
 * vocabulary and no module-level state here any more: those were the fragile
 * part (per-thread state consulted from the MTPROTO worker), and the peerId
 * range makes them unnecessary.
 */

/** Name a session is created with; the first prompt replaces it. */
export const DEFAULT_SESSION_GROUP_NAME = 'New session';

/** How many characters of the first prompt become the session title. */
export const SESSION_NAME_PREFIX_LENGTH = 30;

/**
 * The title a session takes from its first prompt: the first 30 characters,
 * verbatim — no ellipsis (owner: the trailing `…` cost a character of the name
 * and looked like the prompt was truncated mid-thought). Whitespace is
 * collapsed first so a multi-line prompt does not produce a title full of gaps.
 */
export function sessionTitleFromPrompt(text: string, limit = SESSION_NAME_PREFIX_LENGTH): string {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if(!normalized) return '';
  // A hard cut can land on a space — trim it so titles never end in a gap.
  return normalized.slice(0, limit).trim();
}
