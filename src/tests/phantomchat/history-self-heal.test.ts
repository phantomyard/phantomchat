import {describe, expect, it, vi} from 'vitest';
import {collectMissingHistoryMids, createHistorySelfHeal} from '@lib/phantomchat/history-self-heal';

/**
 * Regression guard for the "my own bubble vanishes" bug (PWA + desktop): a
 * cached history page can carry mids whose message object the main-thread
 * mirror no longer holds, and the renderer silently skips those mids.
 */
describe('collectMissingHistoryMids', () => {
  it('collects only mids whose message object failed to resolve', () => {
    const history = [100, 101, 102];
    expect(collectMissingHistoryMids(history, [undefined, {mid: 101}, undefined])).toEqual([100, 102]);
  });

  it('ignores already-resolved message objects (search results, admin logs)', () => {
    const history = [{_: 'message', mid: 7}, {_: 'channelAdminLogEvent', id: 8}];
    expect(collectMissingHistoryMids(history, [undefined, undefined])).toEqual([]);
  });

  it('leaves out mids that resolve, and de-dupes repeats', () => {
    const history = [5, 5, 6];
    expect(collectMissingHistoryMids(history, [{mid: 5}, undefined, undefined])).toEqual([6]);
    expect(collectMissingHistoryMids([5, 5], [undefined, undefined])).toEqual([5]);
  });

  it('returns nothing when the page is complete', () => {
    expect(collectMissingHistoryMids([1, 2], [{mid: 1}, {mid: 2}])).toEqual([]);
  });
});

describe('createHistorySelfHeal', () => {
  const page = () => ({history: [10, 11, 12], resolved: [{mid: 10}, undefined, undefined]});

  it('re-reads the missing mids and paints what came back', async() => {
    const loadMessages = vi.fn(async() => [{mid: 11}, undefined]);
    const renderMessage = vi.fn();
    const heal = createHistorySelfHeal({loadMessages, renderMessage});
    const {history, resolved} = page();

    await expect(heal.heal(1000, history, resolved, false)).resolves.toEqual([11, 12]);

    expect(loadMessages).toHaveBeenCalledWith(1000, [11, 12]);
    expect(renderMessage).toHaveBeenCalledTimes(1);
    expect(renderMessage).toHaveBeenCalledWith({mid: 11}, false);
  });

  it('does not re-read on later pages of the same chat open (no loop)', async() => {
    const loadMessages = vi.fn(async() => [{mid: 11}, {mid: 12}]);
    const renderMessage = vi.fn();
    const heal = createHistorySelfHeal({loadMessages, renderMessage});
    const {history, resolved} = page();

    await heal.heal(1000, history, resolved, false);
    await heal.heal(1000, history, resolved, false);

    expect(loadMessages).toHaveBeenCalledTimes(1);
    expect(renderMessage).toHaveBeenCalledTimes(2);
  });

  it('re-reads again after the chat is reopened', async() => {
    const loadMessages = vi.fn(async() => [{mid: 11}, {mid: 12}]);
    const heal = createHistorySelfHeal({loadMessages, renderMessage: vi.fn()});
    const {history, resolved} = page();

    await heal.heal(1000, history, resolved, false);
    heal.reset();
    await heal.heal(1000, history, resolved, false);

    expect(loadMessages).toHaveBeenCalledTimes(2);
  });

  it('drops a late result once another chat is open', async() => {
    const loadMessages = vi.fn(async() => [{mid: 11}, {mid: 12}]);
    const renderMessage = vi.fn();
    const heal = createHistorySelfHeal({
      loadMessages,
      renderMessage,
      isActualPeer: (peerId) => peerId === 1000 - 1
    });

    const {history, resolved} = page();
    await expect(heal.heal(1000, history, resolved, true)).resolves.toEqual([]);
    expect(renderMessage).not.toHaveBeenCalled();
  });

  it('swallows a failed re-read so the rendered page is untouched', async() => {
    const loadMessages = vi.fn(async() => {
      throw new Error('messages.getMessages failed');
    });
    const renderMessage = vi.fn();
    const heal = createHistorySelfHeal({loadMessages, renderMessage});

    const {history, resolved} = page();
    await expect(heal.heal(1000, history, resolved, false)).resolves.toEqual([]);
    expect(renderMessage).not.toHaveBeenCalled();
  });

  it('does nothing when the page resolved completely', async() => {
    const loadMessages = vi.fn();
    const heal = createHistorySelfHeal({loadMessages, renderMessage: vi.fn()});

    await expect(heal.heal(1000, [10], [{mid: 10}], false)).resolves.toEqual([]);
    expect(loadMessages).not.toHaveBeenCalled();
  });
});
