/*
 * Text-selection context menu (owner 2026-11-02): "Search Selected Text" is
 * removed.
 *
 * Right-clicking a selection offered Quote / Reply / Copy Selected Text /
 * Search Selected Text / Forward / Select / Delete. The search entry was the
 * only one that replaced the chat pane with the global search tab, and the
 * owner does not want it — selecting text now leaves Copy Selected Text as the
 * single selection-specific action.
 *
 * A DOM mount of the chat needs an authenticated P2P session, so the menu is
 * pinned at the source level (same approach as ui-batch6.test.ts).
 */
import {describe, it, expect} from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

const contextMenu = read('components/chat/contextMenu.ts');

/**
 * The slice between two anchors. Both are asserted, so a renamed anchor fails
 * loudly instead of silently turning the slice into the file tail — the same
 * trap the Open New Session pins guard against.
 */
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  expect(start, `missing start anchor: ${startMarker}`).toBeGreaterThan(-1);
  expect(end, `missing end anchor: ${endMarker}`).toBeGreaterThan(-1);
  expect(end, `end anchor precedes start anchor: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('the selection menu no longer offers Search Selected Text', () => {
  it('has no SearchSelected entry in the context menu', () => {
    expect(contextMenu).not.toContain('Chat.SearchSelected');
    // the action itself must not survive under another key
    expect(contextMenu).not.toContain('initSearch({query: selection.toString()})');
  });

  it('the string is gone from both language sources', () => {
    // a cached pack is harmless, but a live key with no consumer is dead weight
    // and would be re-added by the next regeneration if lang.ts kept it
    expect(read('lang.ts')).not.toContain('Chat.SearchSelected');
    expect(read('scripts/out/langPack.strings')).not.toContain('Chat.SearchSelected');
  });
});

describe('the neighbouring selection entries survive', () => {
  const selectionSlice = () => sliceBetween(contextMenu, "text: 'Chat.CopySelectedText'", "text: 'Message.Context.Selection.Copy'");

  it('Copy Selected Text is still the selection action, on the same gate', () => {
    const slice = selectionSlice();
    expect(slice).toContain('onClick: this.onCopyClick');
    expect(slice).toContain('verify: () => !this.noForwards && !!(this.message as Message.message).message && this.isTextSelected');
  });

  it('it still sits directly after the whole-message Copy entry', () => {
    // the unselected Copy must keep its own `!this.isTextSelected` gate, or the
    // two entries both show up (or neither does) on a selection. Anchored on
    // the multi-line verify block, which is unique to that entry.
    const wholeMessage = sliceBetween(contextMenu, "text: 'Copy',\n      onClick: this.onCopyClick,", "text: 'Chat.CopySelectedText'");
    expect(wholeMessage).toContain('!this.isTextSelected');
    expect(wholeMessage).toContain('this.isAnchorTarget');
  });

  it('the removed entry left no gap: only Open New Session took the slot', () => {
    const slice = sliceBetween(contextMenu, "text: 'Chat.CopySelectedText'", "text: 'Message.Context.Selection.Copy'");
    // two entries: Copy Selected Text itself, then #400's Open New Session in
    // the slot the removed Search Selected Text entry vacated — nothing else,
    // so the search action cannot return here unnoticed.
    expect(slice.match(/text: '/g)?.length).toBe(2);
    expect(slice).toContain("text: 'Chat.OpenNewSession'");
    expect(slice).not.toContain("icon: 'search'");
    expect(slice).not.toContain('initSearch');
    expect(slice).not.toContain('SearchSelected');
  });

  it('the remaining selection-specific entries are untouched', () => {
    // Copy Link / Copy Username / Copy Hashtag all follow under withSelection
    expect(contextMenu).toContain("text: this.isEmailTarget ? 'Text.Context.Copy.Email' : 'CopyLink'");
    expect(contextMenu).toContain("text: 'Text.Context.Copy.Username'");
    expect(contextMenu).toContain("text: 'Text.Context.Copy.Hashtag'");
  });
});
