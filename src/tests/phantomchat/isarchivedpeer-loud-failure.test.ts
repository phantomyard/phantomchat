/**
 * #293 half 1: `isArchivedPeer` must fail open *loudly*.
 *
 * The guard refuses text and media for a 1:1 peer whose dialog sits in the
 * archive, and it reads the dialog through the PROXIED `dialogsStorage`. When
 * that hook is renamed or moved, both optional chains answer `undefined` and the
 * guard returns `false` — the refusal silently becomes dead code again, which is
 * exactly what happened at b21b342 and cost a review round to notice. A rejected
 * proxy call was swallowed the same way by the bare `catch`.
 *
 * These cases drive the real method against a stubbed `rootScope.managers`, so
 * they pin the behaviour rather than the source text.
 */
import '../setup';
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import rootScope from '@lib/rootScope';
import {PhantomChatMTProtoServer} from '@lib/phantomchat/virtual-mtproto-server';
import {FOLDER_ID_ARCHIVE, FOLDER_ID_ALL} from '@appManagers/constants';

const PEER_ID = 1_234_567_890_123_456;

describe('#293: isArchivedPeer fails open loudly', () => {
  let server: any;
  let warn: any;
  let original: any;
  let hadManagers = false;

  beforeEach(() => {
    server = new PhantomChatMTProtoServer();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The boot never runs under vitest, so `rootScope.managers` does not exist
    // yet — stand up the one property the guard reads.
    hadManagers = !!(rootScope as any).managers;
    if(!hadManagers) (rootScope as any).managers = {};
    original = (rootScope.managers as any).dialogsStorage;
  });

  afterEach(() => {
    (rootScope.managers as any).dialogsStorage = original;
    if(!hadManagers) delete (rootScope as any).managers;
    warn.mockRestore();
  });

  it('answers correctly when the hook is intact (archived → true, unarchived → false, no warn)', async() => {
    (rootScope.managers as any).dialogsStorage = {
      getAnyDialog: async(peerId: number) => ({peerId, folder_id: FOLDER_ID_ARCHIVE})
    };
    await expect(server.isArchivedPeer(PEER_ID)).resolves.toBe(true);
    expect(warn).not.toHaveBeenCalled();

    (rootScope.managers as any).dialogsStorage = {
      getAnyDialog: async(peerId: number) => ({peerId, folder_id: FOLDER_ID_ALL})
    };
    await expect(server.isArchivedPeer(PEER_ID)).resolves.toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and fails open when getAnyDialog is missing', async() => {
    (rootScope.managers as any).dialogsStorage = {};

    await expect(server.isArchivedPeer(PEER_ID)).resolves.toBe(false);

    // Silent here means the 1:1 archive refusal is dead code and nobody knows.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0].join(' '))).toContain('getAnyDialog missing');
  });

  it('warns and fails open when dialogsStorage itself is gone', async() => {
    (rootScope.managers as any).dialogsStorage = undefined;

    await expect(server.isArchivedPeer(PEER_ID)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0].join(' '))).toContain('getAnyDialog missing');
  });

  it('warns with the peer id when the proxied lookup rejects', async() => {
    (rootScope.managers as any).dialogsStorage = {
      getAnyDialog: async() => { throw new Error('proxy boundary'); }
    };

    await expect(server.isArchivedPeer(PEER_ID)).resolves.toBe(false);

    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0].join(' ');
    expect(line).toContain('dialog lookup failed');
    // The id has to be in the trace, or the warning names no chat to chase.
    expect(line).toContain(String(PEER_ID));
  });
});
