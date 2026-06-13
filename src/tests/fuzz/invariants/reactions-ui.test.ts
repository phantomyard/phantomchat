// @ts-nocheck
// @vitest-environment jsdom
import {describe, it, expect} from 'vitest';
import {reactionsPickerNonempty} from './reactions-ui';

/**
 * INV-reactions-picker-nonempty asserts that whenever the reactions picker
 * is rendered, it contains ≥3 emoji choices. The invariant short-circuits
 * (returns ok=true) when the picker is not rendered.
 *
 * We mock the `page.evaluate` surface used by the invariant: it returns a
 * `{rendered, emojiCount}` snapshot from inside the page.
 */
function mkCtx(snapshot: {rendered: boolean; emojiCount: number}): any {
  const pageStub = {
    evaluate: async () => snapshot
  };
  return {
    users: {
      userA: {page: pageStub, id: 'userA'},
      userB: {page: pageStub, id: 'userB'}
    },
    relay: {},
    snapshots: new Map(),
    actionIndex: 0
  };
}

describe('INV-reactions-picker-nonempty', () => {
  it('passes when picker is not rendered (skip path)', async () => {
    const ctx = mkCtx({rendered: false, emojiCount: 0});
    const r = await reactionsPickerNonempty.check(ctx);
    expect(r.ok).toBe(true);
  });

  it('fails when picker is rendered with 0 emoji', async () => {
    const ctx = mkCtx({rendered: true, emojiCount: 0});
    const r = await reactionsPickerNonempty.check(ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/picker/);
  });

  it('fails when picker is rendered with 2 emoji (below threshold)', async () => {
    const ctx = mkCtx({rendered: true, emojiCount: 2});
    const r = await reactionsPickerNonempty.check(ctx);
    expect(r.ok).toBe(false);
  });

  it('passes when picker is rendered with ≥3 emoji', async () => {
    const ctx = mkCtx({rendered: true, emojiCount: 5});
    const r = await reactionsPickerNonempty.check(ctx);
    expect(r.ok).toBe(true);
  });
});
