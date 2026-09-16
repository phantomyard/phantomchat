// @ts-nocheck
import {describe, it, expect, vi, afterEach, beforeEach} from 'vitest';
import {buildOkFrame, parseOkFrame, handlePeerFrame} from '@lib/phantomchat/transport/p2p-receipts';

const ME = 'a'.repeat(64);
const PEER = 'b'.repeat(64);

function eventFrame(to = ME, id = 'w1') {
  return JSON.stringify(['EVENT', {id, kind: 1059, pubkey: 'e'.repeat(64), created_at: 1, content: 'x', tags: [['p', to]], sig: 'f'.repeat(128)}]);
}

function deps(overrides = {}) {
  const order: string[] = [];
  return {
    order,
    ownPubkey: ME,
    ingest: vi.fn(async() => { order.push('ingest'); }),
    send: vi.fn((_pk, _frame) => { order.push('send'); return true; }),
    onAck: vi.fn(),
    forwardToMiniRelay: vi.fn(),
    ...overrides
  };
}

describe('P2P receipt frames', () => {
  it('builds the NIP-01 OK shape the bot parses', () => {
    expect(JSON.parse(buildOkFrame('w1'))).toEqual(['OK', 'w1', true, 'p2p']);
    expect(parseOkFrame(buildOkFrame('w1'))).toEqual({eventId: 'w1', accepted: true});
  });

  it('rejects anything that is not a well-formed OK', () => {
    expect(parseOkFrame(eventFrame())).toBeNull();
    expect(parseOkFrame('["OK"')).toBeNull();
    expect(parseOkFrame('["OK", 5, true]')).toBeNull();
    expect(parseOkFrame('["OK", "w1", "yes"]')).toBeNull();
    expect(parseOkFrame(JSON.stringify(['OK', 'x'.repeat(129), true]))).toBeNull();
  });
});

describe('handlePeerFrame', () => {
  it('ingests an EVENT addressed to us, THEN acknowledges it to the sender', async() => {
    const d = deps();
    await handlePeerFrame(PEER, eventFrame(ME, 'w1'), d);
    expect(d.ingest).toHaveBeenCalledTimes(1);
    expect(d.send).toHaveBeenCalledWith(PEER, buildOkFrame('w1'));
    expect(d.order).toEqual(['ingest', 'send']);
    // Pre-existing mini-relay path is untouched for EVENT frames.
    expect(d.forwardToMiniRelay).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge a wrap addressed to someone else', async() => {
    const d = deps();
    await handlePeerFrame(PEER, eventFrame('c'.repeat(64)), d);
    expect(d.send).not.toHaveBeenCalled();
  });

  it('an OK receipt settles our send and never reaches ingest or the mini-relay', async() => {
    const d = deps();
    await handlePeerFrame(PEER, buildOkFrame('w9'), d);
    expect(d.onAck).toHaveBeenCalledWith(PEER, 'w9');
    expect(d.ingest).not.toHaveBeenCalled();
    expect(d.forwardToMiniRelay).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  it('a rejected OK is not treated as a delivery, but is reported as a rejection (#142)', async() => {
    const d = deps({onReject: vi.fn()});
    await handlePeerFrame(PEER, JSON.stringify(['OK', 'w9', false, 'nope']), d);
    expect(d.onAck).not.toHaveBeenCalled();
    expect(d.onReject).toHaveBeenCalledWith(PEER, 'w9');
    expect(d.ingest).not.toHaveBeenCalled();
    expect(d.forwardToMiniRelay).not.toHaveBeenCalled();
  });

  it('a rejected OK without an onReject dep is still harmless', async() => {
    const d = deps();
    await expect(handlePeerFrame(PEER, JSON.stringify(['OK', 'w9', false, 'nope']), d)).resolves.toBeUndefined();
    expect(d.onAck).not.toHaveBeenCalled();
  });

  describe('failed receipt send is logged (#142)', () => {
    let debug: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { debug = vi.spyOn(console, 'debug').mockImplementation(() => {}); });
    afterEach(() => { debug.mockRestore(); });

    const receiptLines = () => debug.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('could not send receipt'));
    const ID = 'd'.repeat(64);

    it('logs when the channel is not open (send returns false), id prefix only', async() => {
      const d = deps({send: vi.fn(() => false)});
      await handlePeerFrame(PEER, eventFrame(ME, ID), d);
      const lines = receiptLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('dddddddd');
      expect(lines[0]).not.toContain('d'.repeat(9));
      expect(lines[0]).toContain('channel not open');
      expect(JSON.stringify(debug.mock.calls)).not.toContain('"content"');
    });

    it('logs when the send throws, and never propagates', async() => {
      const d = deps({send: vi.fn(() => { throw new Error('channel closing'); })});
      await expect(handlePeerFrame(PEER, eventFrame(ME, ID), d)).resolves.toBeUndefined();
      const lines = receiptLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('channel closing');
    });

    it('does not log when the receipt goes out', async() => {
      const d = deps();
      await handlePeerFrame(PEER, eventFrame(ME, ID), d);
      expect(receiptLines()).toHaveLength(0);
    });
  });

  it('never throws, even when ingest rejects', async() => {
    const d = deps({ingest: vi.fn(async() => { throw new Error('boom'); })});
    await expect(handlePeerFrame(PEER, eventFrame(), d)).resolves.toBeUndefined();
    expect(d.send).not.toHaveBeenCalled();
  });

  it('non-JSON mesh control still goes to the mini-relay only', async() => {
    const d = deps();
    await handlePeerFrame(PEER, 'hello world', d);
    expect(d.forwardToMiniRelay).toHaveBeenCalledWith(PEER, 'hello world');
    expect(d.ingest).not.toHaveBeenCalled();
  });
});
