import {describe, expect, it, vi} from 'vitest';
import {
  collectMissingStoredMids,
  createBubbleDiskReconcile,
  isReconcilablePeer,
  RECONCILE_LOG_PREFIX
} from '@lib/phantomchat/bubble-disk-reconcile';

/**
 * Regression guard for "my own bubble vanished after switching chats until
 * Ctrl+R" (desktop + PWA): the row is always in the store, so the open chat is
 * compared with the store and any stored message without a bubble is painted.
 */
const P2P = 1e15 + 7;
const view = (renderedMids: number[], atLiveBottom = true, loadedAllTop = false) => ({renderedMids, atLiveBottom, loadedAllTop});

describe('collectMissingStoredMids', () => {
  it('finds a stored mid missing from the middle of the rendered window', () => {
    expect(collectMissingStoredMids([10, 11, 12, 13], view([10, 11, 13]))).toEqual([12]);
  });

  it('ignores stored rows older than the oldest rendered bubble unless history is fully loaded', () => {
    expect(collectMissingStoredMids([5, 10, 11], view([10, 11]))).toEqual([]);
    expect(collectMissingStoredMids([5, 10, 11], view([10, 11], true, true))).toEqual([5]);
  });

  it('includes newer stored rows (the newest message itself can be the missing one)', () => {
    expect(collectMissingStoredMids([10, 11, 12], view([10, 11]))).toEqual([12]);
  });

  it('does nothing when the chat is not at its live bottom', () => {
    expect(collectMissingStoredMids([10, 11, 12], view([10], false))).toEqual([]);
  });

  it('does nothing while a temp (in-flight) bubble is on screen', () => {
    expect(collectMissingStoredMids([10, 11, 12], view([10, 11.0001]))).toEqual([]);
  });

  it('paints every stored row of the newest page into an empty chat', () => {
    expect(collectMissingStoredMids([3, 1, 2], view([]))).toEqual([1, 2, 3]);
  });

  it('skips excluded, duplicate and invalid mids', () => {
    expect(collectMissingStoredMids([12, 12, 13, 0, -4, 1.5], view([10]), new Set([13]))).toEqual([12]);
  });
});

describe('isReconcilablePeer', () => {
  it('accepts PhantomChat 1:1 and group peers only', () => {
    expect(isReconcilablePeer(P2P)).toBe(true);
    expect(isReconcilablePeer(12345)).toBe(false);
  });
});

function harness(stored: number[], rendered: number[]) {
  const bubbles = new Set(rendered);
  let peer = P2P;
  const log = vi.fn();
  const readStoredMids = vi.fn(async() => stored);
  const loadMessages = vi.fn(async(_p: number, mids: number[]) => mids.map((mid) => ({mid})));
  const renderMessage = vi.fn(async(m: {mid: number}) => {
    bubbles.add(m.mid);
  });
  const r = createBubbleDiskReconcile<{mid: number}>({
    readStoredMids,
    loadMessages,
    renderMessage,
    getView: () => view([...bubbles]),
    hasBubble: (mid) => bubbles.has(mid),
    isActualPeer: (p) => p === peer,
    log
  });
  return {r, bubbles, log, readStoredMids, loadMessages, renderMessage, setPeer: (p: number) => peer = p};
}

describe('createBubbleDiskReconcile', () => {
  it('paints the missing stored message and logs the heal', async() => {
    const h = harness([10, 11, 12, 13], [10, 11, 13]);
    await expect(h.r.check(P2P, 'open-cached')).resolves.toEqual([12]);
    expect(h.bubbles.has(12)).toBe(true);
    expect(h.log).toHaveBeenCalledWith(`${RECONCILE_LOG_PREFIX} healed 1 bubble(s) peer=${P2P} reason=open-cached mids=12`);
  });

  it('is silent and loads nothing when the view already matches the store', async() => {
    const h = harness([10, 11], [10, 11]);
    await expect(h.r.check(P2P, 'focus')).resolves.toEqual([]);
    expect(h.loadMessages).not.toHaveBeenCalled();
    expect(h.log).not.toHaveBeenCalled();
  });

  it('never touches non-PhantomChat peers', async() => {
    const h = harness([1], []);
    await expect(h.r.check(42, 'open')).resolves.toEqual([]);
    expect(h.readStoredMids).not.toHaveBeenCalled();
  });

  it('drops a late result after the chat switched', async() => {
    const h = harness([10, 11, 12], [10, 11]);
    const p = h.r.check(P2P, 'open');
    h.setPeer(P2P + 1);
    await expect(p).resolves.toEqual([]);
    expect(h.renderMessage).not.toHaveBeenCalled();
  });

  it('drops a late result after a teardown of the same chat (reset)', async() => {
    const h = harness([10, 11, 12], [10, 11]);
    const p = h.r.check(P2P, 'open');
    h.r.reset();
    await expect(p).resolves.toEqual([]);
    expect(h.renderMessage).not.toHaveBeenCalled();
  });

  it('coalesces concurrent checks for the same chat into one store read', async() => {
    const h = harness([10, 11, 12], [10, 11]);
    const [a, b] = await Promise.all([h.r.check(P2P, 'open'), h.r.check(P2P, 'focus')]);
    expect(a).toEqual([12]);
    expect(b).toEqual([12]);
    expect(h.readStoredMids).toHaveBeenCalledTimes(1);
  });

  it('does not retry a mid the renderer declined until the chat is opened again', async() => {
    const h = harness([10, 11, 12], [10, 11]);
    h.renderMessage.mockImplementation(async() => {}); // renderer skips it on purpose
    await expect(h.r.check(P2P, 'open')).resolves.toEqual([]);
    await expect(h.r.check(P2P, 'focus')).resolves.toEqual([]);
    expect(h.loadMessages).toHaveBeenCalledTimes(1);
    expect(h.log).not.toHaveBeenCalled();
    h.r.reset();
    await h.r.check(P2P, 'open');
    expect(h.loadMessages).toHaveBeenCalledTimes(2);
  });

  it('skips a message a live update painted while the load was in flight', async() => {
    const h = harness([10, 11, 12], [10, 11]);
    h.loadMessages.mockImplementation(async(_p, mids) => {
      h.bubbles.add(12);
      return mids.map((mid) => ({mid}));
    });
    await expect(h.r.check(P2P, 'focus')).resolves.toEqual([]);
    expect(h.renderMessage).not.toHaveBeenCalled();
  });

  it('swallows a failed store read', async() => {
    const h = harness([], []);
    h.readStoredMids.mockRejectedValue(new Error('idb closed'));
    await expect(h.r.check(P2P, 'open')).resolves.toEqual([]);
  });
});
