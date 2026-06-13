/**
 * webtor-wasm TypeScript declarations
 * Built from source at /tmp/webtor-rs/webtor-wasm/pkg/
 * MIT License — privacy-ethereum/webtor-rs
 */

declare module '/webtor/webtor_wasm' {
  export class JsCircuitStatus {
    readonly is_healthy: boolean;
    readonly ready_circuits: number;
    readonly total_circuits: number;
    readonly failed_circuits: number;
    readonly creating_circuits: number;
    readonly has_ready_circuits: boolean;
  }

  export class JsHttpResponse {
    json(): unknown;
    text(): string;
    readonly url: string;
    readonly body: Uint8Array;
    readonly status: number;
    readonly headers: Record<string, string>;
  }

  export class TorClientOptions {
    static snowflakeWebRtc(): TorClientOptions;
    static webtunnel(url: string, fingerprint: string): TorClientOptions;
    withCircuitTimeout(timeout: number): TorClientOptions;
    withBridgeFingerprint(fingerprint: string): TorClientOptions;
    withConnectionTimeout(timeout: number): TorClientOptions;
    withCreateCircuitEarly(create_early: boolean): TorClientOptions;
    withCircuitUpdateAdvance(advance: number): TorClientOptions;
    withCircuitUpdateInterval(interval: number | null): TorClientOptions;
  }

  export class TorClient {
    fetch(url: string): Promise<JsHttpResponse>;
    post(url: string, body: Uint8Array): Promise<JsHttpResponse>;
    postJson(url: string, json_body: string): Promise<JsHttpResponse>;
    request(
      method: string,
      url: string,
      headers: any,
      body?: Uint8Array | null,
      timeout_ms?: number | null
    ): Promise<JsHttpResponse>;
    waitForCircuit(): Promise<void>;
    updateCircuit(deadline_ms: number): Promise<void>;
    getCircuitStatus(): Promise<JsCircuitStatus>;
    getCircuitStatusString(): Promise<string>;
    getCircuitRelays(): Promise<unknown[]>;
    isAborted(): boolean;
    abort(): void;
    close(): Promise<void>;
    static create(options: TorClientOptions): Promise<TorClient>;
    static fetchOneTime(
      snowflake_url: string,
      url: string,
      connection_timeout?: number | null,
      circuit_timeout?: number | null
    ): Promise<JsHttpResponse>;
  }

  export function init(): Promise<void>;
  export function initSync(module: WebAssembly.Module): void;
  export function setDebugEnabled(enabled: boolean): void;
  export function setLogCallback(callback: (msg: string) => void): void;
  export function getVersionInfo(): string;
  export function test_wasm(): string;

  const __wbg_init: (module?: { module_or_path: RequestInfo | URL | Response | BufferSource | WebAssembly.Module } | RequestInfo | URL | Promise<RequestInfo | URL>) => Promise<void>;
  export default __wbg_init;
}
