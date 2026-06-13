// @ts-nocheck
import type {Invariant, FuzzContext, InvariantResult} from '../types';

/**
 * INV-reactions-picker-nonempty
 *
 * When the reactions picker is rendered on either user's page (i.e. the user
 * just right-clicked a bubble to pick an emoji), assert that the picker
 * contains ≥3 emoji choices.
 *
 * Background: PR #47 (`fix(nostra): populate getAvailableReactions stub so
 * reactions menu renders`) fixed a latent ship where `getAvailableReactions`
 * returned `{pFlags: {}}` — the picker rendered with zero emoji. The fuzz
 * suite never caught it because `reactToRandomBubble` calls
 * `appReactionsManager.sendReaction()` directly via the manager proxy and
 * bypasses the UI. The new `reactViaUI` action exercises the DOM path and
 * this invariant ratchets it to zero.
 *
 * The invariant is a SKIP when the picker is not rendered — we cannot
 * synthetically open it every tick without disturbing the fuzzer.
 */

const PICKER_SELECTORS = '.btn-menu-reactions, .reactions-picker, [data-test="reactions-picker"]';
const EMOJI_CHILD_SELECTORS = '.btn-menu-reactions-reaction, [data-emoji], .reaction-emoji, [role="button"]';
const MIN_EMOJI = 3;

async function snapshotFor(user: any): Promise<{rendered: boolean; emojiCount: number}> {
  return user.page.evaluate(({pickerSel, emojiSel}: any) => {
    const picker = document.querySelector(pickerSel) as HTMLElement | null;
    if(!picker) return {rendered: false, emojiCount: 0};
    // Consider the picker "rendered" only if it is in the DOM AND visible
    // (offsetParent is null for `display: none` elements and their ancestors).
    const rendered = picker.offsetParent !== null || getComputedStyle(picker).display !== 'none';
    if(!rendered) return {rendered: false, emojiCount: 0};
    const emojiCount = picker.querySelectorAll(emojiSel).length;
    return {rendered: true, emojiCount};
  }, {pickerSel: PICKER_SELECTORS, emojiSel: EMOJI_CHILD_SELECTORS});
}

export const reactionsPickerNonempty: Invariant = {
  id: 'INV-reactions-picker-nonempty',
  tier: 'cheap',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const user = ctx.users[id];
      if(!user?.page) continue;
      let snap: {rendered: boolean; emojiCount: number};
      try{
        snap = await snapshotFor(user);
      } catch{
        // Page not ready (e.g. mid-reload). Skip silently.
        continue;
      }
      if(!snap.rendered) continue;
      if(snap.emojiCount < MIN_EMOJI) {
        return {
          ok: false,
          message: `reactions picker rendered on ${id} with ${snap.emojiCount} emoji choices (expected ≥${MIN_EMOJI})`,
          evidence: {user: id, emojiCount: snap.emojiCount}
        };
      }
    }
    return {ok: true};
  }
};
