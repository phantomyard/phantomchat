/**
 * Whether the selection flow reveals the left column before opening the
 * session picker (Robert, #400 at 701b048: the class-only guard passed with a
 * DM open at 1280 and cleared that chat's hash).
 *
 * State, not source text: each case is a real layout + tab state and the
 * reveal either happens or it does not.
 */
import {describe, it, expect} from 'vitest';
import {needsLeftColumnReveal} from '../../lib/phantomchat/session-column-reveal';

describe('session picker: does the left column need revealing', () => {
  it('does NOT reveal on a wide screen with a DM open (column is display:flex, hash must survive)', () => {
    // 1280 + DM open: `selectTab(CHAT)` removed `is-left-column-shown`, but the
    // column is laid out side by side and never off screen.
    expect(needsLeftColumnReveal({
      isLessThanFloatingLeftSidebar: false,
      leftColumnShown: false
    })).toBe(false);
  });

  it('does NOT reveal on a wide screen with the chatlist tab active either', () => {
    expect(needsLeftColumnReveal({
      isLessThanFloatingLeftSidebar: false,
      leftColumnShown: true
    })).toBe(false);
  });

  it('reveals at phone width with a chat open (the column is slid out of view)', () => {
    // 390x800, chat open: `is-left-column-shown` absent, column at x=-97.
    expect(needsLeftColumnReveal({
      isLessThanFloatingLeftSidebar: true,
      leftColumnShown: false
    })).toBe(true);
  });

  it('reveals at floating-sidebar width with a chat open', () => {
    // 800px: floating layout, same translated-out column.
    expect(needsLeftColumnReveal({
      isLessThanFloatingLeftSidebar: true,
      leftColumnShown: false
    })).toBe(true);
  });

  it('does NOT reveal at floating width when the column is already forward', () => {
    expect(needsLeftColumnReveal({
      isLessThanFloatingLeftSidebar: true,
      leftColumnShown: true
    })).toBe(false);
  });
});
