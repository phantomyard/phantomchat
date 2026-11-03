/*
 * Main-process side of the phantombot bridge: starts the bundled host on first
 * use, speaks its JSON-lines protocol, and checks every renderer request before
 * it gets there. No Electron import, so vitest drives it with a fake process.
 *
 * The host is per app: its root is <userData>/phantombot, so the app's
 * personas, encrypted vaults and memory never touch a phantombot installed on
 * the same machine, and the engine's root lock refuses a second writer.
 */
import {spawn as nodeSpawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {isPhantombotMethod, MAX_REQUEST_BYTES, type PhantombotMethod} from './methods';

export interface BridgeFailure {
  code: string;
  message: string;
}

export type BridgeResult = {ok: true; value: unknown} | {ok: false; error: BridgeFailure};

export type TurnEventListener = (turnId: string, event: unknown) => void;

type Spawn = (command: string, args: string[], options: object) => ChildProcessWithoutNullStreams;

export interface HostClientOptions {
  binary: string;
  root: string;
  spawn?: Spawn;
  /** One stderr line from the host (the engine's redacted JSON log). */
  log?: (line: string) => void;
}

class HostError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function hostBinaryPath(isPackaged: boolean, resourcesPath: string, bundleDir: string, platform = process.platform): string {
  const name = platform === 'win32' ? 'phantombot-host.exe' : 'phantombot-host';
  return isPackaged ? join(resourcesPath, 'phantombot', name) : join(bundleDir, 'phantombot', name);
}

/**
 * Only the app's own top frame may call the bridge: the PWA served on
 * app://localhost, or the dev server in development. An iframe, a navigated
 * window or any other origin gets nothing.
 */
export function isAllowedCaller(frameUrl: string | undefined, isMainFrame: boolean, devUrl?: string): boolean {
  if(!isMainFrame || !frameUrl) return false;
  let url: URL;
  try {
    url = new URL(frameUrl);
  } catch{
    return false;
  }
  if(url.protocol === 'app:' && url.host === 'localhost') return true;
  if(!devUrl) return false;
  try {
    const dev = new URL(devUrl);
    return url.protocol === dev.protocol && url.host === dev.host;
  } catch{
    return false;
  }
}

/** Shape checks before a request leaves main: allowlisted method, plain JSON object, size cap. */
export function checkRequest(method: unknown, params: unknown): {method: PhantombotMethod; params: Record<string, unknown>} | BridgeFailure {
  if(!isPhantombotMethod(method)) return {code: 'invalid_argument', message: 'unknown method'};
  if(params === undefined) params = {};
  if(typeof params !== 'object' || params === null || Array.isArray(params)) {
    return {code: 'invalid_argument', message: 'params must be an object'};
  }
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(params));
  } catch{
    return {code: 'invalid_argument', message: 'params must be JSON'};
  }
  if(size > MAX_REQUEST_BYTES) return {code: 'invalid_argument', message: 'request too large'};
  return {method, params: params as Record<string, unknown>};
}

export class PhantombotHostClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private pending = new Map<number, {resolve: (value: unknown) => void; reject: (err: HostError) => void}>();
  private turnListeners = new Map<string, TurnEventListener>();
  private exited: Promise<void> | undefined;

  constructor(private readonly options: HostClientOptions) {}

  get running(): boolean {
    return !!this.child;
  }

  private start(): ChildProcessWithoutNullStreams {
    if(this.child) return this.child;
    const env = {...process.env};
    // The host is a Bun binary, not Electron: never hand it Electron's node mode.
    delete env.ELECTRON_RUN_AS_NODE;
    const child = (this.options.spawn ?? (nodeSpawn as unknown as Spawn))(
      this.options.binary,
      ['--root', this.options.root],
      {stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true}
    );
    this.child = child;
    createInterface({input: child.stdout}).on('line', (line) => this.onLine(line));
    createInterface({input: child.stderr}).on('line', (line) => this.options.log?.(line));
    this.exited = new Promise((resolve) => {
      const done = (reason: string) => {
        if(this.child !== child) return resolve();
        this.child = undefined;
        this.turnListeners.clear();
        for(const {reject} of this.pending.values()) reject(new HostError('host_exited', reason));
        this.pending.clear();
        resolve();
      };
      child.on('error', (err) => done(`phantombot could not start: ${err.message}`));
      child.on('exit', (code, signal) => done(`phantombot stopped (${signal ?? code})`));
    });
    // A write after the host died surfaces as 'exit'; keep it off the uncaught path.
    child.stdin.on('error', () => {});
    return child;
  }

  private onLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch{
      return;
    }
    if(!message || typeof message !== 'object') return;
    if(message.event === 'turn' && typeof message.turnId === 'string') {
      this.turnListeners.get(message.turnId)?.(message.turnId, message.data);
      return;
    }
    if(typeof message.id !== 'number') return;
    const waiter = this.pending.get(message.id);
    if(!waiter) return;
    this.pending.delete(message.id);
    if(message.error) {
      waiter.reject(new HostError(String(message.error.code ?? 'internal'), String(message.error.message ?? 'failed')));
    } else {
      waiter.resolve(message.result);
    }
  }

  /** Send one request. A `persona.turn` streams its events to `onTurnEvent` until it settles. */
  async call(method: PhantombotMethod, params: Record<string, unknown>, onTurnEvent?: TurnEventListener): Promise<BridgeResult> {
    const turnId = method === 'persona.turn' && typeof params.turnId === 'string' ? params.turnId : undefined;
    try {
      const child = this.start();
      const id = this.nextId++;
      if(turnId && onTurnEvent) {
        if(this.turnListeners.has(turnId)) throw new HostError('invalid_argument', `turn ${turnId} is already running`);
        this.turnListeners.set(turnId, onTurnEvent);
      }
      const value = await new Promise<unknown>((resolve, reject) => {
        this.pending.set(id, {resolve, reject});
        child.stdin.write(JSON.stringify({id, method, params}) + '\n');
      }).finally(() => {
        if(turnId && this.turnListeners.get(turnId) === onTurnEvent) this.turnListeners.delete(turnId);
      });
      return {ok: true, value};
    } catch(err) {
      const error = err instanceof HostError ?
        {code: err.code, message: err.message} :
        {code: 'internal', message: err instanceof Error ? err.message : String(err)};
      return {ok: false, error};
    }
  }

  /**
   * Close stdin so the host cancels its turns and releases the root, then
   * kill it if it has not gone within `graceMs`.
   */
  async shutdown(graceMs = 5000): Promise<void> {
    const child = this.child;
    if(!child) return;
    child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          child.kill();
          resolve();
        }, graceMs);
      })
    ]);
    clearTimeout(timer);
  }
}
