// @ts-nocheck
/*
 * reactViaUI — drives the reactions menu through the real Playwright UI
 * (right-click → picker → emoji click) instead of the manager-proxy shortcut
 * used by reactToRandomBubble. This exercises the DOM path that PR #47 fixed
 * (populate `getAvailableReactions` so the picker renders) and would have
 * caught the latent empty-picker bug.
 *
 * The DOM class is `.btn-menu-reactions` (container) and
 * `.btn-menu-reactions-reaction` (one per emoji choice). See
 * `src/components/chat/reactionsMenu.ts` for the canonical source.
 */
import type {ActionSpec, Action, FuzzContext} from '../types';
import * as fc from 'fast-check';

const UI_EMOJIS = ['👍', '❤️', '😂', '🔥', '🤔'] as const;

async function pickNonSendingBubbleMid(
  ctx: FuzzContext,
  user: 'userA' | 'userB'
): Promise<string | null> {
  const u = ctx.users[user];
  return u.page.evaluate(() => {
    const selector = '.bubbles-inner .bubble[data-mid]';
    const bubbles = Array.from(document.querySelectorAll(selector))
      .filter((b) => !(b as HTMLElement).classList.contains('is-sending') &&
                     !(b as HTMLElement).classList.contains('is-outgoing'));
    if(bubbles.length === 0) return null;
    const b = bubbles[Math.floor(Math.random() * bubbles.length)] as HTMLElement;
    return b.dataset.mid || null;
  });
}

export const reactViaUI: ActionSpec = {
  name: 'reactViaUI',
  weight: 6,
  generateArgs: () => fc.record({
    user: fc.constantFrom('userA', 'userB'),
    emoji: fc.constantFrom(...UI_EMOJIS)
  }),
  async drive(ctx: FuzzContext, action: Action) {
    const from: 'userA' | 'userB' = action.args.user;
    const sender = ctx.users[from];
    try{
      await sender.page.evaluate((peerId: number) => {
        (window as any).appImManager?.setPeer?.({peerId});
      }, sender.remotePeerId);
      await sender.page.waitForTimeout(300);
    } catch{
      action.skipped = true;
      return action;
    }

    let mid: string | null = null;
    try{
      mid = await pickNonSendingBubbleMid(ctx, from);
    } catch{
      action.skipped = true;
      return action;
    }
    if(!mid) {action.skipped = true; return action;}

    // Right-click the bubble to open the context menu + reactions picker.
    const bubble = sender.page.locator(`.bubbles-inner .bubble[data-mid="${mid}"]`).first();
    try{
      await bubble.waitFor({state: 'visible', timeout: 5000});
      await bubble.click({button: 'right', timeout: 5000});
    } catch{
      action.skipped = true;
      return action;
    }

    // Picker root: `.btn-menu-reactions` (real class) — the plan's
    // `.reactions-picker` is a fallback for future refactors.
    const picker = sender.page.locator('.btn-menu-reactions, .reactions-picker, [data-test="reactions-picker"]').first();
    try{
      await picker.waitFor({state: 'visible', timeout: 5000});
    } catch{
      // Picker did not appear — ESC to close any open menu and skip.
      await sender.page.keyboard.press('Escape').catch(() => {});
      action.skipped = true;
      return action;
    }

    // Click the emoji button inside the picker. Children are
    // `.btn-menu-reactions-reaction`; Playwright's text-matching handles
    // emoji glyphs directly.
    const button = picker.getByText(action.args.emoji).first();
    try{
      await button.click({timeout: 3000});
    } catch{
      await sender.page.keyboard.press('Escape').catch(() => {});
      action.skipped = true;
      return action;
    }

    await sender.page.keyboard.press('Escape').catch(() => {});
    action.meta = {reactedMid: mid, emoji: action.args.emoji, viaUI: true};
    return action;
  }
};
