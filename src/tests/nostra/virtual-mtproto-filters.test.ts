import {describe, it, expect} from 'vitest';
import {NOSTRA_STATIC} from '@lib/nostra/virtual-mtproto-server';

describe('virtual mtproto filter intercepts', () => {
  it('intercepts messages.getDialogFilters as empty array', () => {
    expect(NOSTRA_STATIC['messages.getDialogFilters']).toEqual([]);
  });

  it('intercepts messages.updateDialogFilter as true (no-op)', () => {
    expect(NOSTRA_STATIC['messages.updateDialogFilter']).toBe(true);
  });

  it('intercepts messages.updateDialogFiltersOrder as true (no-op)', () => {
    expect(NOSTRA_STATIC['messages.updateDialogFiltersOrder']).toBe(true);
  });
});
