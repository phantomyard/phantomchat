/**
 * Local tools traffic (phantombot #747) never becomes a chat message: the
 * receive path drops it before storing or rendering, on every client, and
 * only hands it to the desktop gate when the rumor is not my own.
 */
import '../setup';
import {describe, expect, it, vi} from 'vitest';

const handleLocalToolsRumor = vi.fn(async() => {});
vi.mock('@lib/phantomchat/local-tools', () => ({handleLocalToolsRumor}));

const ME = 'a'.repeat(64);
const PHANTOM = 'b'.repeat(64);

function ctx() {
  const log: any = vi.fn();
  log.warn = vi.fn();
  log.error = vi.fn();
  return {ownId: ME, history: [] as any[], activePeer: null as string | null, deliveryTracker: null as null, offlineQueue: null as null, onMessage: vi.fn(), onEdit: vi.fn(), log};
}

const rumor = (from: string, tags: string[][]) => ({
  id: 'e'.repeat(64),
  from,
  content: JSON.stringify({type: 'phantomchat-local-tools', t: 'hello'}),
  timestamp: Math.floor(Date.now() / 1000),
  tags
} as any);

describe('local tools on the receive path', () => {
  it('is skipped before anything renders, and handed to the gate', async() => {
    const {handleRelayMessage} = await import('@lib/phantomchat/chat-api-receive');
    const c = ctx();
    const res = await handleRelayMessage(rumor(PHANTOM, [['phantomchat-local-tools', '1'], ['control', 'true']]), c);
    expect(res).toEqual({action: 'skipped', reason: 'local_tools'});
    expect(c.onMessage).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(handleLocalToolsRumor).toHaveBeenCalledTimes(1));
  });

  it('my own copy is dropped without reaching the gate', async() => {
    handleLocalToolsRumor.mockClear();
    const {handleRelayMessage} = await import('@lib/phantomchat/chat-api-receive');
    const res = await handleRelayMessage(rumor(ME, [['phantomchat-local-tools', '1']]), ctx());
    expect(res).toEqual({action: 'skipped', reason: 'local_tools'});
    await new Promise((r) => setTimeout(r, 10));
    expect(handleLocalToolsRumor).not.toHaveBeenCalled();
  });
});
