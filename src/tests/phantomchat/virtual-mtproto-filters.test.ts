import {describe, it, expect} from 'vitest';
import {PHANTOMCHAT_STATIC} from '@lib/phantomchat/virtual-mtproto-server';

describe('virtual mtproto filter intercepts', () => {
  it('intercepts messages.getDialogFilters as empty array', () => {
    expect(PHANTOMCHAT_STATIC['messages.getDialogFilters']).toEqual([]);
  });

  it('intercepts messages.updateDialogFilter as true (no-op)', () => {
    expect(PHANTOMCHAT_STATIC['messages.updateDialogFilter']).toBe(true);
  });

  it('intercepts messages.updateDialogFiltersOrder as true (no-op)', () => {
    expect(PHANTOMCHAT_STATIC['messages.updateDialogFiltersOrder']).toBe(true);
  });
});
