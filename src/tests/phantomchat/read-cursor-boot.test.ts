/**
 * Regression pin for #217 / PR #218 review round 3 (kaieriksen): the
 * in-memory read-cursor warm must complete BEFORE the receive path can run.
 *
 * The bug: `startChatAPI()` started the global relay subscription while
 * `warmReadCursorCache()` was fire-and-forget (`void`) and yielded on
 * IndexedDB — so a fast relay backfill could reach handleIncomingMessage()
 * with peekReadCursor() still returning 0, increment the closed-chat badge
 * and fire a desktop notification for a message the persisted cursor already
 * covers.
 *
 * Two halves pin the fix:
 *  - behavioral: the gate holds receive while the warm promise is pending,
 *    so a delivery attempt cannot run early (real incoming scheduler as the
 *    projection path; the message-level cursor guard lives in
 *    phantomchat-message-handler.test.ts);
 *  - source contract: the identity flow routes its only subscription start
 *    through the gate, before the projection install, with no fire-and-forget
 *    warm left anywhere.
 */
import '../setup';
import {describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'fs';
import {join} from 'path';
import {startReceiveAfterCursorWarm} from '@lib/phantomchat/read-cursor-boot';
import {createIncomingScheduler} from '@lib/phantomchat/phantomchat-incoming-scheduler';
import type {MessageStore} from '@lib/phantomchat/message-store';

type WarmStore = Pick<MessageStore, 'warmReadCursorCache'>;

const SRC = join(__dirname, '../..');
const flowSrc = readFileSync(join(SRC, 'pages/phantomchat-onboarding-integration.ts'), 'utf8');
const gateSrc = readFileSync(join(SRC, 'lib/phantomchat/read-cursor-boot.ts'), 'utf8');

describe('receive boot — cursor warm gates the receive path (#218 review round 3)', () => {
  it('holds the warm pending while delivery is attempted — the receive path cannot run early', async() => {
    let resolveWarm!: () => void;
    const warmPending = new Promise<void>((resolve) => { resolveWarm = resolve; });
    const store: WarmStore = {warmReadCursorCache: vi.fn(() => warmPending)};

    const delivered: number[] = [];
    const scheduler = createIncomingScheduler<number>({
      handle: async(item) => { delivered.push(item); }
    });

    // Boot exactly like the identity flow: the receive source (and with it the
    // projection path) only activates once the warm resolves. The covered
    // backfill is queued the instant receive opens — the round-3 race shape.
    const boot = startReceiveAfterCursorWarm(() => {
      scheduler.enqueue(3);
    }, store);

    await scheduler.flush();
    expect(store.warmReadCursorCache).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual([]);

    resolveWarm();
    await boot;
    await scheduler.flush();
    expect(delivered).toEqual([3]);
  });

  it('fails open on a warm rejection — receive still starts, loudly', async() => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store: WarmStore = {
      warmReadCursorCache: vi.fn().mockRejectedValue(new Error('IndexedDB gone'))
    };

    const startReceive = vi.fn();
    await startReceiveAfterCursorWarm(startReceive, store);

    expect(startReceive).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('fail open'),
      expect.any(Error)
    );
    warn.mockRestore();
  });

  it('identity flow routes its ONLY subscription start through the gate', () => {
    // No fire-and-forget warm anywhere, and no bare startChatAPI() call that
    // could open a receive source before the warm.
    expect(flowSrc).not.toMatch(/void\s+getMessageStore\(\)\.warmReadCursorCache\(\)/);
    expect(flowSrc).not.toMatch(/^\s*startChatAPI\(\);/m);
    expect(flowSrc).toContain('await startReceiveAfterCursorWarm(startChatAPI)');

    // The gate runs before the projection path is installed.
    const gate = flowSrc.indexOf('await startReceiveAfterCursorWarm(startChatAPI)');
    const projection = flowSrc.indexOf("addEventListener('phantomchat_new_message'");
    expect(gate).toBeGreaterThan(-1);
    expect(projection).toBeGreaterThan(gate);
  });

  it('failure behavior is explicit in the gate module (fail open + logged)', () => {
    expect(gateSrc).toContain('fail open');
    expect(gateSrc).toMatch(/catch\s*\(/);
    expect(gateSrc).toMatch(/console\.warn/);
  });
});
