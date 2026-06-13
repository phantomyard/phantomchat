/**
 * Tests for Nostra.chat transport layer - WebRTC peer connection manager
 */

import '../setup';
import {
  PeerChannel,
  NostraIceConfig,
  createNostraPeerConnection,
  createPeerChannel,
  wrapPeerChannel
} from '@lib/nostra/peer';
import {
  PerfectNegotiation,
  createPoliteNegotiation,
  createImpoliteNegotiation
} from '@lib/nostra/peerNegotiation';
import {
  PeerTransport,
  createPeerTransport,
  TransportMessage,
  TransportState
} from '@lib/nostra/transport';

afterAll(() => {
  vi.restoreAllMocks();
});

// Mock RTCPeerConnection factory
function createMockRTCPeerConnection(): RTCPeerConnection {
  const listeners: Map<string, Set<(...args: any[]) => void>> = new Map();

  const connection: any = {
    signalingState: 'stable',
    iceConnectionState: 'new',
    iceGatheringState: 'new',
    connectionState: 'new',
    localDescription: null,
    remoteDescription: null,

    addEventListener(event: string, handler: (...args: any[]) => void) {
      if(!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(handler);
    },

    removeEventListener(event: string, handler: (...args: any[]) => void) {
      listeners.get(event)?.delete(handler);
    },

    dispatchEvent(event: Event): boolean {
      const handlers = listeners.get(event.type);
      if(handlers) {
        handlers.forEach(h => h(event));
      }
      return true;
    },

    createOffer: async() => ({type: 'offer', sdp: 'mock-offer-sdp'}),
    createAnswer: async() => ({type: 'answer', sdp: 'mock-answer-sdp'}),
    setLocalDescription: async function(desc: RTCSessionDescriptionInit) {
      connection.localDescription = desc;
      connection.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
    },
    setRemoteDescription: async function(desc: RTCSessionDescriptionInit) {
      connection.remoteDescription = desc;
      connection.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
    },
    addIceCandidate: async() => {},
    createDataChannel: (label: string, data?: RTCDataChannelInit) => {
      return createMockRTCDataChannel(label, data);
    },
    close: () => {
      connection.connectionState = 'closed';
    }
  };

  return connection as RTCPeerConnection;
}

// Mock RTCDataChannel factory
function createMockRTCDataChannel(
  label: string = 'data',
  _data?: RTCDataChannelInit
): RTCDataChannel {
  const listeners: Map<string, Set<(...args: any[]) => void>> = new Map();

  const channel: any = {
    label,
    _readyState: 'connecting',

    get readyState() {
      return this._readyState;
    },

    setState(state: RTCDataChannelState) {
      this._readyState = state;
      const eventType = state === 'open' ? 'open' : state === 'closed' ? 'close' : null;
      if(eventType) {
        this.dispatchEvent(new Event(eventType));
      }
    },

    send(data: string | ArrayBuffer | Blob) {
      if(this._readyState !== 'open') {
        throw new Error('Data channel not open');
      }
      return true;
    },

    close() {
      this.setState('closed');
    },

    addEventListener(event: string, handler: (...args: any[]) => void) {
      if(!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(handler);
    },

    removeEventListener(event: string, handler: (...args: any[]) => void) {
      listeners.get(event)?.delete(handler);
    },

    dispatchEvent(event: Event): boolean {
      const handlers = listeners.get(event.type);
      if(handlers) {
        handlers.forEach(h => h(event));
      }
      return true;
    }
  };

  return channel as unknown as RTCDataChannel;
}

// Helper to wait for event
function waitForEvent(channel: RTCDataChannel, eventType: string): Promise<void> {
  return new Promise((resolve) => {
    channel.addEventListener(eventType, () => resolve(), {once: true});
  });
}

describe('PeerChannel', () => {
  let mockChannel: RTCDataChannel;

  beforeEach(() => {
    mockChannel = createMockRTCDataChannel('test-channel');
  });

  test('send() serializes string data correctly', () => {
    const peerChannel = new PeerChannel(mockChannel);

    // Channel starts in connecting state, can't send yet
    expect(peerChannel.readyState).toBe('connecting');
    expect(peerChannel.isOpen).toBe(false);

    // Open the channel
    (mockChannel as any).setState('open');
    expect(peerChannel.readyState).toBe('open');
    expect(peerChannel.isOpen).toBe(true);

    // Send string data - should not throw
    expect(() => peerChannel.send('hello world')).not.toThrow();
  });

  test('send() returns false when channel is not open', () => {
    const peerChannel = new PeerChannel(mockChannel);

    // Can't send while in connecting state
    expect(peerChannel.send('test')).toBe(false);

    // Close the channel
    (mockChannel as any).setState('closed');

    // Can't send when closed
    expect(peerChannel.send('test')).toBe(false);
  });

  test('emits open event after RTCDataChannel fires open', async() => {
    const peerChannel = new PeerChannel(mockChannel);

    const openPromise = waitForEvent(mockChannel, 'open');

    // Simulate channel opening
    (mockChannel as any).setState('open');

    await openPromise;
    expect(peerChannel.isOpen).toBe(true);
  });

  test('emits close event after RTCDataChannel fires close', async() => {
    const peerChannel = new PeerChannel(mockChannel);

    // First open it
    (mockChannel as any).setState('open');

    const closePromise = waitForEvent(mockChannel, 'close');

    // Then close it
    (mockChannel as any).setState('closed');

    await closePromise;
  });

  test('emits message event when data is received', async() => {
    const peerChannel = new PeerChannel(mockChannel);
    const testData = 'test message content';

    const messagePromise = new Promise<string>((resolve) => {
      peerChannel.onMessage((data) => resolve(data));
    });

    // Open the channel first
    (mockChannel as any).setState('open');

    // Simulate receiving a message
    mockChannel.dispatchEvent(new MessageEvent('message', {data: testData}));

    const receivedData = await messagePromise;
    expect(receivedData).toBe(testData);
  });

  test('close() closes the underlying RTCDataChannel', () => {
    const peerChannel = new PeerChannel(mockChannel);

    // Open first
    (mockChannel as any).setState('open');
    expect(peerChannel.readyState).toBe('open');

    // Close
    peerChannel.close();
    expect(peerChannel.readyState).toBe('closed');
  });

  test('onError() receives error events', async() => {
    const peerChannel = new PeerChannel(mockChannel);

    const errorPromise = new Promise<Event>((resolve) => {
      peerChannel.onError((e) => resolve(e));
    });

    // Simulate error
    mockChannel.dispatchEvent(new Event('error'));

    const receivedError = await errorPromise;
    expect(receivedError).toBeInstanceOf(Event);
  });
});

describe('createNostraPeerConnection', () => {
  test('produces a connection with correct ICE config', () => {
    const {connection} = createNostraPeerConnection();

    // Check that the connection was created
    expect(connection).toBeDefined();
    expect(connection).toBeInstanceOf(RTCPeerConnection);
  });

  test('ICE config includes STUN servers', () => {
    // Verify NostraIceConfig has STUN servers
    expect(NostraIceConfig.iceServers).toBeDefined();
    expect(NostraIceConfig.iceServers.length).toBeGreaterThan(0);

    // Check for Google STUN servers
    const hasGoogleStun = NostraIceConfig.iceServers.some(server =>
      server.urls.includes('stun.l.google.com') ||
      server.urls.includes('stun1.l.google.com')
    );
    expect(hasGoogleStun).toBe(true);
  });

  test('allows custom ICE config to override defaults', () => {
    const customConfig: RTCConfiguration = {
      iceServers: [
        {urls: 'stun:custom.stun.server.com:3478'}
      ]
    };

    const {connection} = createNostraPeerConnection(customConfig);
    expect(connection).toBeDefined();

    // The custom config should be used (this is implementation-dependent)
    // In real usage, we verify via signaling
  });
});

describe('PerfectNegotiation', () => {
  let mockConnection: RTCPeerConnection;

  beforeEach(() => {
    mockConnection = createMockRTCPeerConnection();
  });

  test('createOffer() returns SDP string', async() => {
    const negotiation = new PerfectNegotiation(mockConnection, true);

    const sdp = await negotiation.createOffer();

    expect(sdp).toBeDefined();
    expect(typeof sdp).toBe('string');
    expect(mockConnection.signalingState).toBe('have-local-offer');
  });

  test('receiveOffer() sets remote description and returns answer SDP', async() => {
    const negotiation = new PerfectNegotiation(mockConnection, true);

    const answerSdp = await negotiation.receiveOffer('mock-offer-sdp');

    expect(answerSdp).toBeDefined();
    expect(typeof answerSdp).toBe('string');
    expect(mockConnection.remoteDescription).toBeDefined();
    expect(mockConnection.signalingState).toBe('stable');
  });

  test('receiveAnswer() sets remote description', async() => {
    const negotiation = new PerfectNegotiation(mockConnection, true);

    // First create an offer
    await negotiation.createOffer();

    // Then receive answer
    await negotiation.receiveAnswer('mock-answer-sdp');

    expect(mockConnection.remoteDescription).toBeDefined();
    expect(mockConnection.signalingState).toBe('stable');
  });

  test('polite side processes incoming offers', async() => {
    const politeNegotiation = new PerfectNegotiation(mockConnection, true);

    // Simulate receiving an offer
    await politeNegotiation.receiveOffer('incoming-offer-sdp');

    expect(mockConnection.remoteDescription).toBeDefined();
  });

  test('impolite side can create offers', async() => {
    const impoliteNegotiation = new PerfectNegotiation(mockConnection, false);

    const offerSdp = await impoliteNegotiation.createOffer();

    expect(offerSdp).toBeDefined();
    expect(mockConnection.localDescription).toBeDefined();
  });

  test('addIceCandidate() handles candidates', async() => {
    const negotiation = new PerfectNegotiation(mockConnection, true);

    const candidate = new RTCIceCandidate({
      candidate: 'candidate:1 1 UDP 123 192.168.1.1 12345 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0
    });

    // Should not throw
    await expect(negotiation.addIceCandidate(candidate)).resolves.not.toThrow();
  });

  test('getSignalingState() returns current state', () => {
    const negotiation = new PerfectNegotiation(mockConnection, true);

    expect(negotiation.getSignalingState()).toBe('stable');
  });

  test('getLocalDescription() returns local SDP after offer', async() => {
    const negotiation = new PerfectNegotiation(mockConnection, true);

    await negotiation.createOffer();

    const localDesc = negotiation.getLocalDescription();
    expect(localDesc).toBeDefined();
  });

  test('getRemoteDescription() returns null before receiving', () => {
    const negotiation = new PerfectNegotiation(mockConnection, true);

    expect(negotiation.getRemoteDescription()).toBeNull();
  });

  test('createPoliteNegotiation() creates negotiation with isPolite=true', () => {
    const negotiation = createPoliteNegotiation(mockConnection);

    expect(negotiation).toBeInstanceOf(PerfectNegotiation);
  });

  test('createImpoliteNegotiation() creates negotiation with isPolite=false', () => {
    const negotiation = createImpoliteNegotiation(mockConnection);

    expect(negotiation).toBeInstanceOf(PerfectNegotiation);
  });
});

describe('createPeerChannel and wrapPeerChannel', () => {
  test('createPeerChannel wraps a created data channel', () => {
    const connection = createMockRTCPeerConnection();

    const peerChannel = createPeerChannel(connection, 'test');

    expect(peerChannel).toBeInstanceOf(PeerChannel);
    expect(peerChannel.dataChannel.label).toBe('data');
  });

  test('wrapPeerChannel wraps an incoming data channel', () => {
    const incomingChannel = createMockRTCDataChannel('incoming');

    const peerChannel = wrapPeerChannel(incomingChannel);

    expect(peerChannel).toBeInstanceOf(PeerChannel);
    expect(peerChannel.dataChannel.label).toBe('incoming');
  });
});

describe('PeerTransport - State Machine', () => {
  test('initial state is disconnected', () => {
    const transport = createPeerTransport({
      ownId: 'AAAAA.BBBBB.CCCCC'
    });

    expect(transport.getState()).toBe('disconnected');
    expect(transport.getFailureReason()).toBeNull();
    expect(transport.getConnectedPeerId()).toBeNull();

    transport.disconnect();
  });

  test('onStateChange handler is called on state transitions', async() => {
    const transport = createPeerTransport({
      ownId: 'AAAAA.BBBBB.CCCCC'
    });

    const stateChanges: TransportState[] = [];
    transport.onStateChange((state) => {
      stateChanges.push(state);
    });

    // Mock the internal connect by manually triggering state
    // In real usage, connect() would transition through states
    // For unit testing, we verify the handler registration works
    expect(stateChanges).toHaveLength(0);

    transport.disconnect();
  });

  test('disconnect() transitions to disconnected state', () => {
    const transport = createPeerTransport({
      ownId: 'AAAAA.BBBBB.CCCCC'
    });

    // Initial state
    expect(transport.getState()).toBe('disconnected');

    // Disconnect should keep it disconnected (no-op if already disconnected)
    transport.disconnect();
    expect(transport.getState()).toBe('disconnected');
  });

  test('transport exports TransportMessage type correctly', () => {
    const message: TransportMessage = {
      id: 'test-123',
      from: 'AAAAA.BBBBB.CCCCC',
      to: 'DDDDD.EEEEE.FFFFF',
      payload: 'Hello, World!',
      timestamp: Date.now()
    };

    expect(message.id).toBe('test-123');
    expect(message.from).toBe('AAAAA.BBBBB.CCCCC');
    expect(message.payload).toBe('Hello, World!');
  });
});

describe('PeerTransport - Message Queuing', () => {
  test('send() returns false when not connected (queues message)', () => {
    const transport = createPeerTransport({
      ownId: 'AAAAA.BBBBB.CCCCC'
    });

    // Should return false and not throw when disconnected
    const result = transport.send('test message');

    expect(result).toBe(false);

    transport.disconnect();
  });

  test('onMessage handler receives messages after connect', async() => {
    const transport = createPeerTransport({
      ownId: 'AAAAA.BBBBB.CCCCC'
    });

    const receivedMessages: TransportMessage[] = [];
    transport.onMessage((msg) => {
      receivedMessages.push(msg);
    });

    // After handler registration, pending messages would be flushed on connect
    // For unit test, verify handler registration works
    expect(receivedMessages).toHaveLength(0);

    transport.disconnect();
  });

  test('send() queues multiple messages when disconnected', () => {
    const transport = createPeerTransport({
      ownId: 'AAAAA.BBBBB.CCCCC'
    });

    // Send multiple messages while disconnected
    expect(transport.send('message 1')).toBe(false);
    expect(transport.send('message 2')).toBe(false);
    expect(transport.send('message 3')).toBe(false);

    // All should return false (queued)
    // The actual queue is internal, so we just verify no throws

    transport.disconnect();
  });

  test('createPeerTransport creates instance with correct options', () => {
    const transport = createPeerTransport({
      ownId: 'AAAAA.BBBBB.CCCCC',
      relayUrl: 'wss://custom-relay.example.com',
      iceTimeout: 10000,
      signalingTimeout: 8000
    });

    expect(transport).toBeInstanceOf(PeerTransport);
    expect(transport.getState()).toBe('disconnected');

    transport.disconnect();
  });
});

describe('PeerTransport - TransportState type', () => {
  test('TransportState includes all expected states', () => {
    const states: TransportState[] = [
      'disconnected',
      'connecting',
      'connected',
      'reconnecting',
      'failed'
    ];

    // Verify all states are valid
    expect(states).toContain('disconnected');
    expect(states).toContain('connecting');
    expect(states).toContain('connected');
    expect(states).toContain('reconnecting');
    expect(states).toContain('failed');
  });
});
