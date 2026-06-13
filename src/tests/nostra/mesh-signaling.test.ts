// @ts-nocheck
import {describe, it, expect} from 'vitest';

describe('MeshSignaling', () => {
  it('should create a signal event with correct kind and content', async() => {
    const {createSignalEvent} = await import('@lib/nostra/mesh-signaling');
    const {SIGNAL_KIND} = await import('@lib/nostra/webrtc-config');

    const signal = createSignalEvent({
      action: 'offer',
      sdp: 'v=0\r\no=...',
      sessionId: 'session-123'
    });

    expect(signal.kind).toBe(SIGNAL_KIND);
    const parsed = JSON.parse(signal.content);
    expect(parsed.type).toBe('webrtc-signal');
    expect(parsed.action).toBe('offer');
    expect(parsed.sdp).toBe('v=0\r\no=...');
    expect(parsed.sessionId).toBe('session-123');
  });

  it('should create ice-candidate signal without sdp', async() => {
    const {createSignalEvent} = await import('@lib/nostra/mesh-signaling');

    const signal = createSignalEvent({
      action: 'ice-candidate',
      candidate: {candidate: 'candidate:1 1 UDP 2122252543 192.168.1.1 50000 typ host', sdpMid: '0', sdpMLineIndex: 0},
      sessionId: 'session-456'
    });

    const parsed = JSON.parse(signal.content);
    expect(parsed.action).toBe('ice-candidate');
    expect(parsed.candidate.candidate).toContain('candidate:1');
    expect(parsed.sdp).toBeUndefined();
  });

  it('should parse valid signal content', async() => {
    const {parseSignalContent} = await import('@lib/nostra/mesh-signaling');

    const content = JSON.stringify({
      type: 'webrtc-signal',
      action: 'answer',
      sdp: 'v=0\r\no=answer...',
      sessionId: 'session-789'
    });

    const signal = parseSignalContent(content);
    expect(signal).not.toBeNull();
    expect(signal.action).toBe('answer');
    expect(signal.sessionId).toBe('session-789');
  });

  it('should return null for non-signal content', async() => {
    const {parseSignalContent} = await import('@lib/nostra/mesh-signaling');
    expect(parseSignalContent('just text')).toBeNull();
    expect(parseSignalContent(JSON.stringify({type: 'other'}))).toBeNull();
    expect(parseSignalContent(JSON.stringify({type: 'webrtc-signal'}))).toBeNull(); // missing action+sessionId
  });

  it('should identify signal kind', async() => {
    const {isSignalKind} = await import('@lib/nostra/mesh-signaling');
    const {SIGNAL_KIND} = await import('@lib/nostra/webrtc-config');
    expect(isSignalKind(SIGNAL_KIND)).toBe(true);
    expect(isSignalKind(1059)).toBe(false);
    expect(isSignalKind(0)).toBe(false);
  });

  it('should create answer signal event', async() => {
    const {createSignalEvent} = await import('@lib/nostra/mesh-signaling');

    const signal = createSignalEvent({
      action: 'answer',
      sdp: 'v=0\r\nanswer-sdp',
      sessionId: 'session-abc'
    });

    const parsed = JSON.parse(signal.content);
    expect(parsed.action).toBe('answer');
    expect(parsed.sdp).toBe('v=0\r\nanswer-sdp');
    expect(parsed.candidate).toBeUndefined();
  });
});
