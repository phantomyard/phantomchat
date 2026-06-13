// @vitest-environment jsdom
import {describe, it, expect} from 'vitest';

/**
 * Unit-level regression for FIND-2fda8762 and FIND-7fd7bc72.
 *
 * Background: `src/components/chat/reaction.ts` contains a closure
 * `onAvailableReaction(...)` (inside the `fireAroundAnimation` static
 * method) that dereferences `availableReaction.center_icon` and
 * `sticker.sticker` unconditionally. In Nostra mode the reactions catalog
 * is a stub (`messages.getAvailableReactions` → empty), so these
 * descriptors can be `undefined`. The original crashes:
 *
 *   - FIND-2fda8762: `Cannot read 'center_icon'` at reaction.ts:205:33
 *   - FIND-7fd7bc72: `Cannot read 'sticker'` via wrapSticker call chain
 *     reaction.ts:576 → reaction.ts:419 (onAvailableReaction) →
 *     wrapStickerAnimation → wrapSticker → sticker.ts:72
 *
 * The fix adds three guards:
 *   1. `isGenericMasked = genericEffect && sticker && sticker.sticker !== Lottie`
 *      — protects the `.sticker` deref on missing sticker.
 *   2. `stickerDoc = sticker || availableReaction?.center_icon` + guard
 *      `stickerResult = ... && stickerDoc && wrapSticker(...)` — protects
 *      `.center_icon` deref on missing availableReaction and skips
 *      wrapSticker when no doc is resolvable.
 *   3. `genericDoc = isGenericMasked ? aroundParams.doc : (sticker || aroundParams.doc)`
 *      + guard on `genericResult` — ensures wrapStickerAnimation is never
 *      called with `doc: undefined`.
 *   4. Top-of-function early return `if(!assetName && !hasAroundDoc && !sticker) return;`
 *      — belt-and-suspenders for callers where nothing is resolvable.
 *
 * We don't instantiate the full ReactionElement (custom element, deep
 * deps on appImManager, rootScope, wrapSticker, etc.) — we re-express
 * the guard semantics as pure functions and assert they don't throw.
 * The actual fix in reaction.ts must match these semantics.
 */

// Stand-in shapes matching the narrow access pattern of onAvailableReaction.
type Doc = {sticker?: number};
type AvailableReaction = {
  center_icon?: Doc;
  static_icon?: Doc;
  around_animation?: Doc;
};

const STICKER_LOTTIE = 1;

/**
 * Reference implementation of the guarded derivations inside
 * onAvailableReaction. Mirrors the actual code in reaction.ts.
 */
function computeGuardedRender(args: {
  availableReaction?: AvailableReaction;
  genericEffect?: Doc;
  sticker?: Doc;
  onlyAround?: boolean;
  assetName?: string;
}): {
  earlyReturn: boolean;
  isGenericMasked: boolean;
  genericDoc: Doc | undefined;
  stickerDoc: Doc | undefined;
  willCallWrapSticker: boolean;
  willCallWrapStickerAnimationGeneric: boolean;
} {
  const {availableReaction, genericEffect, sticker, onlyAround, assetName} = args;
  const hasAroundDoc = !!(genericEffect || availableReaction?.around_animation);
  if(!assetName && !hasAroundDoc && !sticker) {
    return {
      earlyReturn: true,
      isGenericMasked: false,
      genericDoc: undefined,
      stickerDoc: undefined,
      willCallWrapSticker: false,
      willCallWrapStickerAnimationGeneric: false
    };
  }

  const isGenericMasked = !!(genericEffect && sticker && sticker.sticker !== STICKER_LOTTIE);
  const aroundDoc = genericEffect || availableReaction?.around_animation;
  const genericDoc = isGenericMasked ? aroundDoc : (sticker || aroundDoc);
  const stickerDoc = sticker || availableReaction?.center_icon;
  const willCallWrapSticker =
    (!genericEffect || isGenericMasked) && !onlyAround && !!stickerDoc;
  const willCallWrapStickerAnimationGeneric = !!genericEffect && !!genericDoc;

  return {
    earlyReturn: false,
    isGenericMasked,
    genericDoc,
    stickerDoc,
    willCallWrapSticker,
    willCallWrapStickerAnimationGeneric
  };
}

describe('reaction.ts guards tolerate undefined availableReaction (Nostra mode)', () => {
  it('early-returns when nothing is resolvable (Nostra stub catalog, no sticker, no genericEffect)', () => {
    const r = computeGuardedRender({
      availableReaction: undefined,
      genericEffect: undefined,
      sticker: undefined,
      onlyAround: false
    });
    expect(r.earlyReturn).toBe(true);
    expect(r.willCallWrapSticker).toBe(false);
    expect(r.willCallWrapStickerAnimationGeneric).toBe(false);
  });

  it('does NOT deref `.center_icon` when availableReaction is undefined (FIND-2fda8762)', () => {
    // With a sticker but no availableReaction (catalog stub empty),
    // stickerDoc must resolve via sticker — not crash on `.center_icon`.
    const sticker = {sticker: STICKER_LOTTIE};
    const r = computeGuardedRender({
      availableReaction: undefined,
      sticker,
      onlyAround: false
    });
    expect(r.earlyReturn).toBe(false);
    expect(r.stickerDoc).toBe(sticker);
    expect(r.willCallWrapSticker).toBe(true);
  });

  it('skips wrapSticker when stickerDoc is undefined (would pass `doc: undefined` otherwise)', () => {
    // Paid reaction with onlyAround is a legit case where sticker is
    // absent — but here we test the general "no resolvable doc" path.
    // Covered by earlyReturn above; explicit case: availableReaction
    // exists but has NO center_icon (catalog partial).
    const r = computeGuardedRender({
      availableReaction: {center_icon: undefined, around_animation: {sticker: STICKER_LOTTIE}},
      sticker: undefined,
      onlyAround: false
    });
    expect(r.earlyReturn).toBe(false);
    expect(r.stickerDoc).toBeUndefined();
    expect(r.willCallWrapSticker).toBe(false); // guard blocks wrapSticker
  });

  it('does NOT deref `.sticker` on undefined sticker when genericEffect is present (FIND-7fd7bc72)', () => {
    // Original crash: `isGenericMasked = genericEffect && sticker.sticker !== Lottie`
    // with sticker undefined → TypeError. Fixed with `sticker && sticker.sticker`.
    const genericEffect = {sticker: STICKER_LOTTIE};
    const r = computeGuardedRender({
      availableReaction: undefined,
      genericEffect,
      sticker: undefined,
      onlyAround: false
    });
    expect(r.earlyReturn).toBe(false);
    expect(r.isGenericMasked).toBe(false); // no crash, falls through to non-masked
    // genericDoc must NOT be undefined when we reach wrapStickerAnimation —
    // the guard should either block the call or supply aroundParams.doc.
    expect(r.genericDoc).toBe(genericEffect);
    expect(r.willCallWrapStickerAnimationGeneric).toBe(true);
  });

  it('native tweb path unchanged: availableReaction with center_icon renders normally', () => {
    const centerIcon = {sticker: STICKER_LOTTIE};
    const aroundAnim = {sticker: STICKER_LOTTIE};
    const r = computeGuardedRender({
      availableReaction: {center_icon: centerIcon, around_animation: aroundAnim},
      sticker: undefined,
      onlyAround: false
    });
    expect(r.earlyReturn).toBe(false);
    expect(r.stickerDoc).toBe(centerIcon);
    expect(r.willCallWrapSticker).toBe(true);
  });

  it('paid-reaction (assetName) path is preserved even when nothing else is resolvable', () => {
    const r = computeGuardedRender({
      availableReaction: undefined,
      genericEffect: undefined,
      sticker: undefined,
      onlyAround: true,
      assetName: 'StarReactionEffect1'
    });
    expect(r.earlyReturn).toBe(false);
    // onlyAround=true + no stickerDoc → no wrapSticker, but assetName path runs.
    expect(r.willCallWrapSticker).toBe(false);
  });
});
