// @ts-nocheck
// Opus decoder - placeholder implementation

export type OpusDecodedAudio = {
  channelData: Float32Array[];
  sampleRate: number;
  numberOfFrames: number;
  samplesDecoded: number;
};

export type OpusDecoderInit = {
  sampleRate?: number;
  numberOfChannels?: number;
  channels?: number;
  preSkip?: number;
  streamCount?: number;
  coupledStreamCount?: number;
  channelMappingTable?: number[];
};

export class OpusDecoder {
  constructor(init: OpusDecoderInit) {
    this.sampleRate = init.sampleRate || 48000;
    this.numberOfChannels = init.numberOfChannels || init.channels || 2;
    this.ready = Promise.resolve();
  }

  sampleRate: number;
  numberOfChannels: number;
  ready: Promise<void>;

  async init(): Promise<void> {}

  async decode(input: ArrayBuffer): Promise<OpusDecodedAudio> {
    return {
      channelData: [new Float32Array(0)],
      sampleRate: this.sampleRate,
      numberOfFrames: 0,
      samplesDecoded: 0
    };
  }

  decodeFrame(input: Uint8Array): OpusDecodedAudio {
    return {
      channelData: [new Float32Array(0)],
      sampleRate: this.sampleRate,
      numberOfFrames: 0,
      samplesDecoded: 0
    };
  }

  free(): void {}
  delete(): void {}
}
