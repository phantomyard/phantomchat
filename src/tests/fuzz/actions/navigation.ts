// @ts-nocheck
import * as fc from 'fast-check';
import type {ActionSpec, Action, FuzzContext} from '../types';

export const openRandomChat: ActionSpec = {
  name: 'openRandomChat',
  weight: 12,
  generateArgs: () => fc.record({user: fc.constantFrom('userA', 'userB')}),
  async drive(ctx: FuzzContext, action: Action) {
    const user = ctx.users[action.args.user as 'userA' | 'userB'];
    await user.page.evaluate((peerId: number) => {
      (window as any).appImManager?.setPeer?.({peerId});
    }, user.remotePeerId);
    await user.page.waitForTimeout(200);
    return action;
  }
};

export const scrollHistoryUp: ActionSpec = {
  name: 'scrollHistoryUp',
  weight: 7,
  generateArgs: () => fc.record({user: fc.constantFrom('userA', 'userB')}),
  async drive(ctx: FuzzContext, action: Action) {
    const user = ctx.users[action.args.user as 'userA' | 'userB'];
    await user.page.evaluate(() => {
      const inner = document.querySelector('.bubbles-inner') as HTMLElement | null;
      if(inner) inner.scrollTop = 0;
    });
    await user.page.waitForTimeout(300);
    return action;
  }
};

export const waitForPropagation: ActionSpec = {
  name: 'waitForPropagation',
  weight: 5,
  generateArgs: () => fc.record({ms: fc.integer({min: 500, max: 3000})}),
  async drive(ctx: FuzzContext, action: Action) {
    await ctx.users.userA.page.waitForTimeout(action.args.ms);
    return action;
  }
};
