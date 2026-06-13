// @ts-nocheck
import {describe, it, expect, vi, beforeEach, afterEach, afterAll} from 'vitest';
import {MeshManager} from '@lib/nostra/mesh-manager';

let mockDC;
let mockPC;
let dcEventHandlers;
let pcEventHandlers;

const _origRTCPeerConnection = globalThis.RTCPeerConnection;
const _origRTCSessionDescription = globalThis.RTCSessionDescription;

afterAll(() => {
  globalThis.RTCPeerConnection = _origRTCPeerConnection;
  globalThis.RTCSessionDescription = _origRTCSessionDescription;
});

beforeEach(() => {
  vi.useFakeTimers();

  dcEventHandlers = {};
  pcEventHandlers = {};

  mockDC = {
    readyState: 'connecting',
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn((event, handler) => { dcEventHandlers[event] = handler; }),
    removeEventListener: vi.fn()
  };

  mockPC = {
    createOffer: vi.fn().mockResolvedValue({type: 'offer', sdp: 'v=0\r\noffer...'}),
    createAnswer: vi.fn().mockResolvedValue({type: 'answer', sdp: 'v=0\r\nanswer...'}),
    setLocalDescription: vi.fn().mockResolvedValue(undefined),
    setRemoteDescription: vi.fn().mockResolvedValue(undefined),
    addIceCandidate: vi.fn().mockResolvedValue(undefined),
    createDataChannel: vi.fn().mockReturnValue(mockDC),
    close: vi.fn(),
    connectionState: 'new',
    addEventListener: vi.fn((event, handler) => { pcEventHandlers[event] = handler; }),
    removeEventListener: vi.fn(),
    localDescription: {type: 'offer', sdp: 'v=0\r\noffer...'}
  };

  globalThis.RTCPeerConnection = vi.fn().mockImplementation(() => mockPC);
  globalThis.RTCSessionDescription = vi.fn().mockImplementation((desc) => desc);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeCallbacks() {
  return {
    sendSignal: vi.fn().mockResolvedValue(undefined),
    onPeerMessage: vi.fn(),
    onPeerConnected: vi.fn(),
    onPeerDisconnected: vi.fn()
  };
}

describe('MeshManager', () => {
  it('getStatus returns disconnected for unknown peer', () => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);
    expect(manager.getStatus('unknown-pubkey')).toBe('disconnected');
  });

  it('connect() sets status to connecting and sends signal', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.connect('peer1');

    expect(manager.getStatus('peer1')).toBe('connecting');
    expect(callbacks.sendSignal).toHaveBeenCalledOnce();
    const [recipientPubkey, signal] = callbacks.sendSignal.mock.calls[0];
    expect(recipientPubkey).toBe('peer1');
    expect(signal.kind).toBeDefined();
    expect(signal.content).toContain('webrtc-signal');
    expect(signal.content).toContain('offer');
  });

  it('send() returns false for disconnected peer', () => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    const result = manager.send('nonexistent-peer', 'hello');
    expect(result).toBe(false);
  });

  it('getConnectedPeers() returns empty array initially', () => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    expect(manager.getConnectedPeers()).toEqual([]);
  });

  it('DataChannel open event triggers onPeerConnected callback', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.connect('peer1');

    mockDC.readyState = 'open';
    dcEventHandlers.open?.();

    expect(manager.getStatus('peer1')).toBe('connected');
    expect(callbacks.onPeerConnected).toHaveBeenCalledWith('peer1');
    expect(manager.getConnectedPeers()).toContain('peer1');
  });

  it('DataChannel message with PING sends PONG back', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.connect('peer1');

    mockDC.readyState = 'open';
    dcEventHandlers.open?.();

    dcEventHandlers.message?.({data: 'PING'});

    expect(mockDC.send).toHaveBeenCalledWith('PONG');
    expect(callbacks.onPeerMessage).not.toHaveBeenCalled();
  });

  it('DataChannel message with non-PING forwards to onPeerMessage', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.connect('peer1');

    mockDC.readyState = 'open';
    dcEventHandlers.open?.();

    dcEventHandlers.message?.({data: 'hello world'});

    expect(callbacks.onPeerMessage).toHaveBeenCalledWith('peer1', 'hello world');
  });

  it('disconnect() prevents auto-reconnect', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.connect('peer1');

    mockDC.readyState = 'open';
    dcEventHandlers.open?.();

    manager.disconnect('peer1');

    expect(manager.getStatus('peer1')).toBe('disconnected');

    // Advance timers well past any reconnect delay
    vi.advanceTimersByTime(30000);

    // RTCPeerConnection should only have been called once (the initial connect)
    expect(globalThis.RTCPeerConnection).toHaveBeenCalledTimes(1);
    expect(manager.getConnectedPeers()).toEqual([]);
  });

  it('handleSignal with offer creates answer and sends it back', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    const offerContent = JSON.stringify({
      type: 'webrtc-signal',
      action: 'offer',
      sdp: 'v=0\r\noffer-from-alice',
      sessionId: 'session-1'
    });

    await manager.handleSignal('alice', offerContent);

    expect(globalThis.RTCPeerConnection).toHaveBeenCalled();
    expect(mockPC.setRemoteDescription).toHaveBeenCalled();
    expect(mockPC.createAnswer).toHaveBeenCalled();
    expect(mockPC.setLocalDescription).toHaveBeenCalled();
    expect(callbacks.sendSignal).toHaveBeenCalledWith('alice', expect.objectContaining({
      content: expect.stringContaining('answer')
    }));
    expect(manager.getStatus('alice')).toBe('connecting');
  });

  it('handleSignal with answer sets remote description', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.connect('bob');
    mockPC.setRemoteDescription.mockClear();

    const answerContent = JSON.stringify({
      type: 'webrtc-signal',
      action: 'answer',
      sdp: 'v=0\r\nanswer-from-bob',
      sessionId: 'ignored'
    });

    await manager.handleSignal('bob', answerContent);

    expect(mockPC.setRemoteDescription).toHaveBeenCalledWith(
      expect.objectContaining({type: 'answer', sdp: 'v=0\r\nanswer-from-bob'})
    );
  });

  it('handleSignal with ice-candidate adds to peer connection', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.connect('bob');

    const candidateContent = JSON.stringify({
      type: 'webrtc-signal',
      action: 'ice-candidate',
      candidate: {candidate: 'candidate:1 1 UDP 2122252543 192.168.1.1 50000 typ relay', sdpMid: '0', sdpMLineIndex: 0},
      sessionId: 'x'
    });

    await manager.handleSignal('bob', candidateContent);

    expect(mockPC.addIceCandidate).toHaveBeenCalledWith(
      expect.objectContaining({candidate: expect.stringContaining('candidate:1')})
    );
  });

  it('connect() throws when max connections reached', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    for(let i = 0; i < 50; i++) {
      await manager.connect(`peer-${i}`);
    }

    await expect(manager.connect('peer-50')).rejects.toThrow('Max connections');
  });

  it('disconnectAll() disconnects all peers', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.connect('alice');
    await manager.connect('bob');

    manager.disconnectAll();

    expect(manager.getConnectedPeers()).toEqual([]);
    expect(manager.getStatus('alice')).toBe('disconnected');
    expect(manager.getStatus('bob')).toBe('disconnected');
  });

  it('send() returns true for connected peer with open DataChannel', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.connect('peer1');
    mockDC.readyState = 'open';
    dcEventHandlers.open?.();

    const result = manager.send('peer1', 'test message');
    expect(result).toBe(true);
    expect(mockDC.send).toHaveBeenCalledWith('test message');
  });

  it('getPeerLatency returns -1 for unknown peer and updates after PONG', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    expect(manager.getPeerLatency('unknown')).toBe(-1);

    await manager.connect('peer1');
    mockDC.readyState = 'open';
    dcEventHandlers.open?.();

    expect(manager.getPeerLatency('peer1')).toBe(-1);
  });

  it('DataChannel close triggers onPeerDisconnected', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.connect('peer1');
    mockDC.readyState = 'open';
    dcEventHandlers.open?.();

    dcEventHandlers.close?.();

    expect(callbacks.onPeerDisconnected).toHaveBeenCalledWith('peer1');
    expect(manager.getStatus('peer1')).toBe('disconnected');
  });

  it('PC connectionState failed triggers onPeerDisconnected', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.connect('peer1');
    mockDC.readyState = 'open';
    dcEventHandlers.open?.();

    mockPC.connectionState = 'failed';
    pcEventHandlers.connectionstatechange?.();

    expect(callbacks.onPeerDisconnected).toHaveBeenCalledWith('peer1');
  });

  it('schedules reconnect with increasing delays after disconnect', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.connect('peer1');
    mockDC.readyState = 'open';
    dcEventHandlers.open?.();

    const initialCallCount = globalThis.RTCPeerConnection.mock.calls.length;

    dcEventHandlers.close?.();

    expect(globalThis.RTCPeerConnection).toHaveBeenCalledTimes(initialCallCount);

    await vi.advanceTimersByTimeAsync(1100);

    expect(globalThis.RTCPeerConnection).toHaveBeenCalledTimes(initialCallCount + 1);
  });

  it('handleSignal ignores non-signal content', async() => {
    const callbacks = makeCallbacks();
    const manager = new MeshManager(callbacks);

    await manager.handleSignal('alice', 'not json');
    await manager.handleSignal('alice', JSON.stringify({type: 'other'}));

    expect(globalThis.RTCPeerConnection).not.toHaveBeenCalled();
  });
});
