// @ts-nocheck
import {describe, it, expect} from 'vitest';

describe('MeshSignaling (phantombot-compatible {t} schema, kind 21050)', () => {
  it('SIGNAL_KIND is 21050 to match phantombot NOSTR_KIND_P2P_SIGNAL', async() => {
    const {SIGNAL_KIND} = await import('@lib/phantomchat/webrtc-config');
    expect(SIGNAL_KIND).toBe(21050);
  });

  it('encodes an offer payload the node can decode verbatim', async() => {
    const {encodeSignalPayload, decodeSignalPayload} = await import('@lib/phantomchat/mesh-signaling');
    const payload = encodeSignalPayload({t: 'offer', sdp: 'v=0\r\no=...'});
    const parsed = JSON.parse(payload);
    expect(parsed.t).toBe('offer');
    expect(parsed.sdp).toBe('v=0\r\no=...');
    // round-trips through the decoder
    expect(decodeSignalPayload(payload)).toEqual({t: 'offer', sdp: 'v=0\r\no=...'});
  });

  it('encodes a candidate payload (node candidate shape)', async() => {
    const {encodeSignalPayload, decodeSignalPayload} = await import('@lib/phantomchat/mesh-signaling');
    const msg = {t: 'candidate', candidate: 'candidate:1 1 UDP 2122252543 192.168.1.1 50000 typ host', sdpMid: '0', sdpMLineIndex: 0};
    const decoded = decodeSignalPayload(encodeSignalPayload(msg));
    expect(decoded.t).toBe('candidate');
    expect(decoded.candidate).toContain('candidate:1');
    expect(decoded.sdpMid).toBe('0');
    expect(decoded.sdpMLineIndex).toBe(0);
  });

  it('encodes hello / bye control signals', async() => {
    const {encodeSignalPayload, decodeSignalPayload} = await import('@lib/phantomchat/mesh-signaling');
    expect(decodeSignalPayload(encodeSignalPayload({t: 'hello'}))).toEqual({t: 'hello'});
    expect(decodeSignalPayload(encodeSignalPayload({t: 'bye'}))).toEqual({t: 'bye'});
  });

  it('decodes an answer payload', async() => {
    const {decodeSignalPayload} = await import('@lib/phantomchat/mesh-signaling');
    const decoded = decodeSignalPayload(JSON.stringify({t: 'answer', sdp: 'v=0\r\no=answer...'}));
    expect(decoded).not.toBeNull();
    expect(decoded.t).toBe('answer');
    expect(decoded.sdp).toBe('v=0\r\no=answer...');
  });

  it('returns null for non-signal / malformed content', async() => {
    const {decodeSignalPayload} = await import('@lib/phantomchat/mesh-signaling');
    expect(decodeSignalPayload('just text')).toBeNull();
    expect(decodeSignalPayload(JSON.stringify({t: 'other'}))).toBeNull();
    expect(decodeSignalPayload(JSON.stringify({t: 'offer'}))).toBeNull(); // offer missing sdp
    expect(decodeSignalPayload(JSON.stringify({t: 'candidate'}))).toBeNull(); // candidate missing candidate
  });

  it('identifies the signal kind', async() => {
    const {isSignalKind} = await import('@lib/phantomchat/mesh-signaling');
    const {SIGNAL_KIND} = await import('@lib/phantomchat/webrtc-config');
    expect(isSignalKind(SIGNAL_KIND)).toBe(true);
    expect(isSignalKind(1059)).toBe(false);
    expect(isSignalKind(29001)).toBe(false); // the old, mismatched kind
  });
});
