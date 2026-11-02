/**
 * The temp-to-real swap in the Worker has to fire on every upload completion,
 * including the retry and queue-flush paths, which never reach sendFileViaBridge.
 * All of them announce themselves through `phantomchat_file_upload_completed`.
 */
import 'fake-indexeddb/auto';
import {describe, it, expect, vi} from 'vitest';

const listeners = new Map<string, (e: any) => void>();
const replaceLocalTempMessage = vi.fn();

vi.mock('@lib/rootScope', () => ({
  default: {
    addEventListener: (name: string, cb: (e: any) => void) => listeners.set(name, cb),
    managers: {appMessagesManager: {replaceLocalTempMessage}}
  }
}));

describe('phantomchat_file_upload_completed', () => {
  async function wire() {
    const {PhantomChatMTProtoServer} = await import('@lib/phantomchat/virtual-mtproto-server');
    new PhantomChatMTProtoServer().setChatAPI({});
    await vi.waitFor(() => expect(listeners.has('phantomchat_file_upload_completed')).toBe(true));
    return listeners.get('phantomchat_file_upload_completed')!;
  }

  it('swaps the temp mid for the real mid, keeping the group peer sign', async() => {
    const fire = await wire();
    fire({peerId: -4000000000000001, mid: 1793620000500001, realMid: 1793620000600002});
    expect(replaceLocalTempMessage).toHaveBeenCalledWith(-4000000000000001, 1793620000500001, 1793620000600002);
  });

  it('skips a completion with no real mid', async() => {
    replaceLocalTempMessage.mockClear();
    const fire = await wire();
    fire({peerId: 1, mid: 2});
    expect(replaceLocalTempMessage).not.toHaveBeenCalled();
  });
});
