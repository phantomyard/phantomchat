import crypto from 'crypto';

// Setup crypto for jsdom environment
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const globalScope: any = typeof globalThis !== 'undefined' ? globalThis :
                         typeof global !== 'undefined' ? global :
                         typeof self !== 'undefined' ? self : {};

if(!globalScope.crypto) {
  Object.defineProperty(globalScope, 'crypto', {
    value: {
      subtle: crypto.webcrypto.subtle,
      getRandomValues: crypto.webcrypto.getRandomValues.bind(crypto.webcrypto)
    },
    configurable: true,
    writable: true
  });
}

// jsdom's Blob lacks arrayBuffer(); polyfill via FileReader for test runs
if(typeof globalScope.Blob !== 'undefined' && typeof globalScope.Blob.prototype.arrayBuffer !== 'function') {
  globalScope.Blob.prototype.arrayBuffer = function(this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

// Mock WebRTC APIs for testing
if(typeof global.RTCPeerConnection === 'undefined') {
  class MockRTCPeerConnection {
    signalingState: RTCSignalingState = 'stable';
    iceConnectionState: RTCIceConnectionState = 'new';
    iceGatheringState: RTCIceGatheringState = 'new';
    connectionState: string = 'new';
    localDescription: RTCSessionDescription | null = null;
    remoteDescription: RTCSessionDescription | null = null;
    private listeners: Map<string, Set<(...args: any[]) => void>> = new Map();

    constructor(_config?: RTCConfiguration) {}

    addEventListener(event: string, handler: (...args: any[]) => void) {
      if(!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event)!.add(handler);
    }

    removeEventListener(event: string, handler: (...args: any[]) => void) {
      this.listeners.get(event)?.delete(handler);
    }

    dispatchEvent(event: Event): boolean {
      const handlers = this.listeners.get(event.type);
      if(handlers) {
        handlers.forEach(h => h(event));
      }
      return true;
    }

    async createOffer(): Promise<RTCSessionDescriptionInit> {
      return {type: 'offer', sdp: 'mock-offer-sdp'};
    }

    async createAnswer(): Promise<RTCSessionDescriptionInit> {
      return {type: 'answer', sdp: 'mock-answer-sdp'};
    }

    async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
      this.localDescription = desc as RTCSessionDescription;
      this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
      this.dispatchEvent(new Event('signalingstatechange'));
    }

    async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
      this.remoteDescription = desc as RTCSessionDescription;
      this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
      this.dispatchEvent(new Event('signalingstatechange'));
    }

    async addIceCandidate(_candidate: RTCIceCandidateInit): Promise<void> {}

    createDataChannel(label: string, _data?: RTCDataChannelInit): RTCDataChannel {
      return createMockRTCDataChannel(label);
    }
  }

  class MockRTCDataChannel {
    label: string;
    readyState: RTCDataChannelState = 'connecting';
    binaryType: BinaryType = 'arraybuffer';
    bufferedAmount: number = 0;
    bufferedAmountLowThreshold: number = 0;
    maxPacketLifeTime: number | null = null;
    maxRetransmits: number | null = null;
    negotiated: boolean = false;
    ordered: boolean = true;
    priority: RTCPriorityType = 'low';
    id: number | null = null;
    protocol: string = '';
    reliable: boolean = true;

    private listeners: Map<string, Set<(...args: any[]) => void>> = new Map();

    constructor(label: string) {
      this.label = label;
    }

    get onopen(): ((this: RTCDataChannel, ev: Event) => void) | null { return null; }
    set onopen(_value: ((this: RTCDataChannel, ev: Event) => void) | null) {}
    get onclose(): ((this: RTCDataChannel, ev: Event) => void) | null { return null; }
    set onclose(_value: ((this: RTCDataChannel, ev: Event) => void) | null) {}
    get onmessage(): ((this: RTCDataChannel, ev: MessageEvent) => void) | null { return null; }
    set onmessage(_value: ((this: RTCDataChannel, ev: MessageEvent) => void) | null) {}
    get onerror(): ((this: RTCDataChannel, ev: Event) => void) | null { return null; }
    set onerror(_value: ((this: RTCDataChannel, ev: Event) => void) | null) {}

    addEventListener(event: string, handler: (...args: any[]) => void) {
      if(!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event)!.add(handler);
    }

    removeEventListener(event: string, handler: (...args: any[]) => void) {
      this.listeners.get(event)?.delete(handler);
    }

    dispatchEvent(event: Event): boolean {
      const handlers = this.listeners.get(event.type);
      if(handlers) {
        handlers.forEach(h => h(event));
      }
      return true;
    }

    send(_data: string | ArrayBuffer | Blob): boolean {
      if(this.readyState !== 'open') return false;
      return true;
    }

    close(): void {
      this.readyState = 'closed';
      this.dispatchEvent(new Event('close'));
    }

    get onbufferedamountlow(): ((this: RTCDataChannel, ev: Event) => void) | null { return null; }
    set onbufferedamountlow(_value: ((this: RTCDataChannel, ev: Event) => void) | null) {}
  }

  class MockRTCSessionDescription {
    type: RTCSdpType;
    sdp: string;
    constructor(init: RTCSessionDescriptionInit) {
      this.type = init.type;
      this.sdp = init.sdp || '';
    }
  }

  class MockRTCIceCandidate {
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
    usernameFragment: string | null;

    constructor(init: RTCIceCandidateInit) {
      this.candidate = init.candidate || '';
      this.sdpMid = init.sdpMid ?? null;
      this.sdpMLineIndex = init.sdpMLineIndex ?? null;
      this.usernameFragment = init.usernameFragment ?? null;
    }
  }

  function createMockRTCDataChannel(label: string): RTCDataChannel {
    return new MockRTCDataChannel(label) as unknown as RTCDataChannel;
  }

  // Assign to global scope
  (global as any).RTCPeerConnection = MockRTCPeerConnection;
  (global as any).RTCSessionDescription = MockRTCSessionDescription;
  (global as any).RTCIceCandidate = MockRTCIceCandidate;
}
