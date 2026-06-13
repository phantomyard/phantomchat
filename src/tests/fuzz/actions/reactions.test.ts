// @ts-nocheck
// @vitest-environment node
import {describe, it, expect} from 'vitest';
import {reactViaUI} from './reactions';

describe('reactViaUI action spec', () => {
  it('has stable name', () => {
    expect(reactViaUI.name).toBe('reactViaUI');
  });

  it('has positive weight', () => {
    expect(reactViaUI.weight).toBeGreaterThan(0);
  });

  it('generateArgs yields {user, emoji} of the expected shape', () => {
    const arb = reactViaUI.generateArgs();
    // fast-check arbitraries have a .generate(mrng) method; we test the shape
    // indirectly by sampling the arbitrary deterministically via fc.sample.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fc = require('fast-check');
    const samples = fc.sample(arb, {numRuns: 10, seed: 42});
    for(const s of samples) {
      expect(['userA', 'userB']).toContain(s.user);
      expect(typeof s.emoji).toBe('string');
      expect(s.emoji.length).toBeGreaterThan(0);
    }
  });

  it('drive marks action skipped when no bubble is present', async () => {
    // Mock a page where every locator evaluates to an empty set.
    const mockPage = {
      evaluate: async () => null,
      waitForTimeout: async () => {},
      locator: () => ({
        first: () => ({
          waitFor: async () => { throw new Error('no bubble'); },
          click: async () => {},
          getByText: () => ({first: () => ({click: async () => {}})})
        })
      }),
      keyboard: {press: async () => {}}
    };
    const ctx: any = {
      users: {
        userA: {page: mockPage, remotePeerId: 1, id: 'userA'},
        userB: {page: mockPage, remotePeerId: 2, id: 'userB'}
      },
      relay: {},
      snapshots: new Map(),
      actionIndex: 0
    };
    const action: any = {name: 'reactViaUI', args: {user: 'userA', emoji: '👍'}};
    const res = await reactViaUI.drive(ctx, action);
    expect(res.skipped).toBe(true);
  });
});
