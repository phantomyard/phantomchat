// @vitest-environment jsdom
import {describe, it, expect, vi} from 'vitest';
import {reactionDedupe, noKind7SelfEchoDrop, reactionAuthorCheck, reactionAggregatedRender} from './reactions';

function mkCtx(rowsByUser: Record<'userA' | 'userB', any[]>): any {
  const mk = (rows: any[]) => ({
    page: {
      evaluate: vi.fn(async () => rows)
    }
  });
  return {
    users: {userA: mk(rowsByUser.userA), userB: mk(rowsByUser.userB)},
    relay: {getAllEvents: vi.fn(async (): Promise<any[]> => [])}
  };
}

describe('INV-reaction-dedupe', () => {
  it('passes when compound keys are unique', async () => {
    const ctx = mkCtx({
      userA: [{targetEventId: 'e1', fromPubkey: 'p1', emoji: '👍'}],
      userB: []
    });
    const r = await reactionDedupe.check(ctx);
    expect(r.ok).toBe(true);
  });

  it('fails when compound key repeats', async () => {
    const ctx = mkCtx({
      userA: [
        {targetEventId: 'e1', fromPubkey: 'p1', emoji: '👍'},
        {targetEventId: 'e1', fromPubkey: 'p1', emoji: '👍'}
      ],
      userB: []
    });
    const r = await reactionDedupe.check(ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/duplicate/);
  });
});

describe('INV-no-kind7-self-echo-drop', () => {
  it('passes when own emoji is in the store', async () => {
    const ctx = mkCtx({
      userA: [{emoji: '👍', fromPubkey: 'pA'}],
      userB: []
    });
    const r = await noKind7SelfEchoDrop.check(ctx, {
      name: 'reactToRandomBubble', args: {user: 'userA', emoji: '👍'}
    });
    expect(r.ok).toBe(true);
  });

  it('fails when own emoji missing', async () => {
    const ctx = mkCtx({
      userA: [{emoji: '❤️', fromPubkey: 'pA'}],
      userB: []
    });
    const r = await noKind7SelfEchoDrop.check(ctx, {
      name: 'reactToRandomBubble', args: {user: 'userA', emoji: '👍'}
    });
    expect(r.ok).toBe(false);
  });
});

describe('INV-reaction-author-check', () => {
  it('fails on malformed reactionEventId', async () => {
    const ctx = mkCtx({
      userA: [{emoji: '👍', fromPubkey: 'pA', reactionEventId: 'not-hex'}],
      userB: []
    });
    const r = await reactionAuthorCheck.check(ctx);
    expect(r.ok).toBe(false);
  });

  it('passes on well-formed reactionEventId (64 hex)', async () => {
    const ctx = mkCtx({
      userA: [{emoji: '👍', fromPubkey: 'pA', reactionEventId: 'a'.repeat(64)}],
      userB: []
    });
    const r = await reactionAuthorCheck.check(ctx);
    expect(r.ok).toBe(true);
  });
});

describe('INV-reaction-aggregated-render — FIND-bbf8efa8 regression', () => {
  it('passes when all emojis render', async () => {
    const action = {name: 'reactMultipleEmoji', args: {user: 'userA'}, meta: {emojis: ['👍', '❤️', '😂'], targetMid: '999'}};
    const user = {
      id: 'userA' as const,
      context: null as any,
      page: {evaluate: vi.fn(async () => '👍❤️😂')} as any,
      displayName: 'A', npub: '', remotePeerId: 0, consoleLog: [] as string[], reloadTimes: [Date.now()]
    };
    const ctx = {users: {userA: user, userB: user}, relay: null as any, snapshots: new Map(), actionIndex: 0};
    const r = await reactionAggregatedRender.check(ctx, action);
    expect(r.ok).toBe(true);
  });

  it('fails when one emoji is missing', async () => {
    const action = {name: 'reactMultipleEmoji', args: {user: 'userA'}, meta: {emojis: ['👍', '❤️', '😂'], targetMid: '999'}};
    const user = {
      id: 'userA' as const,
      context: null as any,
      page: {evaluate: vi.fn(async () => '👍😂')} as any,
      displayName: 'A', npub: '', remotePeerId: 0, consoleLog: [] as string[], reloadTimes: [Date.now()]
    };
    const ctx = {users: {userA: user, userB: user}, relay: null as any, snapshots: new Map(), actionIndex: 0};
    const r = await reactionAggregatedRender.check(ctx, action);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('❤️');
  });
});
