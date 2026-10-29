/*
 * Code Mode — a thin-client "coding inbox" inside PhantomChat.
 *
 * Andrew's call (2026-10-29): phantomcode is a MODE, not a second app. The
 * phantoms already run their own harnesses and do the work; PhantomChat stays
 * a thin client with no filesystem access and no local spawn, so Code Mode is
 * UI + a contact list — never an engine.
 *
 * This module holds the device-local plumbing and the PURE list logic:
 *  - the StateSettings key (`codeModeEnabled`, same category as
 *    `defaultChatFolderId`: this browser's IndexedDB, never published to
 *    Nostr) so the rail selection survives a reload;
 *  - the body class the OpenCode-style skin hangs off;
 *  - the rail entry's label and glyph;
 *  - `buildCodeModeInbox` — the Code list is "every phantom you added as a
 *    contact", derived from things that already exist (the peer mapping store
 *    plus the cached dialogs), so it needs no storage of its own and cannot
 *    drift from the chat list;
 *  - the PhantomOps row key, which is the one non-Nostr entry in that list.
 *
 * Deliberately NOT here: any filter/folder storage. Code Mode is not a
 * `dialogFilter`, so it can never leak into `filter_order` or the FoldersSync
 * snapshot, and it needs no migration.
 */

import {P2P_PEER_ID_MIN, isP2PPeerId} from '@lib/phantomchat/bridge-invariants';

/** StateSettings key under `settings.` where the Code Mode flag lives. */
export const CODE_MODE_SETTING_KEY = 'codeModeEnabled' as const;

/** Class added to `<body>`, and nothing else, so the whole skin is css-scoped. */
export const CODE_MODE_BODY_CLASS = 'code-mode' as const;

/**
 * Rail glyph. Andrew (2026-10-29): a `#` badge, in the same icon style as the
 * other rail entries — so it is rendered as TEXT inside the folder-item icon
 * slot (`iconText`), not as an emoji. An emoji renders as a colour sticker and
 * breaks the monochrome rail; text inherits the icon size, weight and colour.
 */
export const CODE_MODE_RAIL_GLYPH = '#';

/** LangPack key for the rail label. */
export const CODE_MODE_LANG_KEY = 'CodeMode' as const;

/** rootScope event fired whenever the mode is entered or left. */
export const CODE_MODE_EVENT = 'code_mode_changed' as const;

/**
 * Row key of the PhantomOps entry. It has no peer id — PhantomOps is not a
 * Nostr peer — so the list keys it separately and never confuses it with a
 * dialog.
 */
export const CODE_MODE_PHANTOMOPS_KEY = 'phantomops' as const;

/** `index_<n>` sort indices are `timestampSec * 0x10000` (see peer mapper). */
const SORT_INDEX_SCALE = 0x10000;

/**
 * P2P (phantom) peer ids start here. Re-exported from `bridge-invariants`,
 * which is the single source of truth for the synthetic range (the first copy
 * of this constant predates it and the two must not drift), so callers still
 * have one name for it.
 */
export const CODE_MODE_PEER_ID_FLOOR = P2P_PEER_ID_MIN;

/**
 * A settings value read back from IndexedDB is untrusted shape: anything that
 * is not literally `true` means "off". Kept pure so the boot decision is
 * testable without a browser.
 */
export function isCodeModeEnabled(value: unknown): boolean {
  return value === true;
}

/**
 * Toggle the skin class on an element (the real one is `document.body`).
 * Returns whether the class is now present, so callers/tests can assert
 * without re-reading the DOM.
 */
export function applyCodeModeClass(element: {classList: Pick<DOMTokenList, 'add' | 'remove'>}, enabled: boolean): boolean {
  if(enabled) {
    element.classList.add(CODE_MODE_BODY_CLASS);
  } else {
    element.classList.remove(CODE_MODE_BODY_CLASS);
  }

  return enabled;
}

/**
 * Is this peer id one of the synthetic phantom ids? Code Mode lists exactly
 * the phantom contacts — never Telegram chats, groups or channels.
 */
export function isCodeModePeerId(peerId: number | string): boolean {
  const id = typeof peerId === 'string' ? parseInt(peerId, 10) : peerId;
  return Number.isFinite(id) && isP2PPeerId(id);
}

/** `index_0` → seconds since epoch (dialogs store `sec * 0x10000`). */
export function sortIndexToSeconds(index: number): number {
  if(!Number.isFinite(index) || index <= 0) return 0;
  return Math.floor(index / SORT_INDEX_SCALE);
}

/** Minimal shape of a stored phantom mapping (see virtual-peers-db). */
export interface CodeModePeerInput {
  pubkey: string;
  peerId: number;
  displayName?: string;
  addedAt?: number;
}

/** The dialog fields `buildCodeModeInbox` reads. */
export interface CodeModeDialogInput {
  peerId: number;
  sortIndex?: number;
  unread?: number;
}

export interface CodeModeEntry {
  peerId: number;
  pubkey: string;
  title: string;
  /** Unread messages in this chat, 0 when there is no dialog yet. */
  unread: number;
  /** Last activity, unix seconds (0 = never talked to). */
  lastActivity: number;
}

/**
 * Build the Code list from data that already exists — the phantom mappings
 * plus the cached dialogs — and nothing else.
 *
 * A phantom with no messages yet still belongs in the inbox: adding a contact
 * IS the act of "installing a model", so it must show up before it has ever
 * spoken. Ordering is by last activity, newest first, with never-used contacts
 * after them in the order they were added.
 */
export function buildCodeModeInbox(
  peers: CodeModePeerInput[],
  dialogs: CodeModeDialogInput[] = [],
  opts: {excludePubkeys?: Iterable<string>} = {}
): CodeModeEntry[] {
  // Your own identity has a mapping like any contact, but it is not a model:
  // showing it would put "talk to yourself" at the top of the inbox.
  const excluded = new Set(opts.excludePubkeys || []);
  const byPeerId = new Map<number, CodeModeDialogInput>();
  for(const dialog of dialogs) {
    if(!isCodeModePeerId(dialog.peerId)) continue;
    byPeerId.set(dialog.peerId, dialog);
  }

  const entries: CodeModeEntry[] = [];
  const seen = new Set<number>();

  for(const peer of peers) {
    if(!peer || !isCodeModePeerId(peer.peerId) || seen.has(peer.peerId)) continue;
    if(peer.pubkey && excluded.has(peer.pubkey)) continue;
    seen.add(peer.peerId);

    const dialog = byPeerId.get(peer.peerId);
    // A display name from the mapping beats a synthetic hex placeholder, and
    // the dialog's own title is resolved by the caller (tweb user record), so
    // the fallback here is only ever the short pubkey form.
    const title = (peer.displayName || '').trim() || peer.pubkey.slice(0, 8);

    entries.push({
      peerId: peer.peerId,
      pubkey: peer.pubkey,
      title,
      unread: dialog?.unread || 0,
      lastActivity: dialog?.sortIndex ? sortIndexToSeconds(dialog.sortIndex) : 0
    });
  }

  entries.sort((a, b) => {
    if(b.lastActivity !== a.lastActivity) return b.lastActivity - a.lastActivity;
    return a.title.localeCompare(b.title);
  });

  return entries;
}

/**
 * Compact relative age for a row ("now", "5m", "3h", "2d"). Pure so the
 * formatting is testable without a clock.
 */
export function formatCodeModeAge(lastActivitySec: number, nowSec: number): string {
  if(!lastActivitySec) return '';
  const delta = Math.max(0, Math.floor(nowSec - lastActivitySec));
  if(delta < 60) return 'now';
  if(delta < 3600) return Math.floor(delta / 60) + 'm';
  if(delta < 86400) return Math.floor(delta / 3600) + 'h';
  if(delta < 86400 * 30) return Math.floor(delta / 86400) + 'd';
  return '';
}
