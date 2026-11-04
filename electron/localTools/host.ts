/*
 * Local tools on this PC for Phantom contacts (phantombot #747, contacts
 * redesign). A remote phantom whose Local tools switch is ON can run bash,
 * read, write, edit, ls, find and grep here. The protocol is unchanged from
 * #405 (docs/LOCAL-TOOLS.md); the tools now run in the bundled phantombot
 * engine (`tools.run`) instead of an embedded Pi.
 *
 * The renderer holds the principal's key, so it unwraps, verifies and sends;
 * this decides. No Electron import, so vitest drives it directly.
 */
import {randomBytes} from 'node:crypto';
import {appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {hostname} from 'node:os';
import {dirname, join} from 'node:path';
import {
  decideToolCall, isEnabled, isHexPubkey, LOCAL_TOOL_NAMES, parseLocalAccess, parseToolCall, rememberCall, setOwner,
  type CallGroupInfo, type LocalAccessState, type LocalToolName, type ToolCall
} from './localAccess';

export const RESULT_CHUNK_CHARS = 24_000;
export const LOCAL_ACCESS_FILE = 'local-access.json';

export interface ToolResult {
  status: 'ok' | 'error' | 'cancelled' | 'timeout';
  output: string;
  exit?: number;
  truncated?: boolean;
}

export type ToolMessage =
  | {t: 'capability'; deviceId: string; deviceName: string; platform: string; tools: readonly LocalToolName[]}
  | {t: 'revoked'; deviceId: string}
  | {t: 'result'; callId: string; seq: number; total: number; data: string};

/** One result as one or more messages. A receiver joins `data` and parses it. */
export function chunkResult(callId: string, result: ToolResult, chunkChars = RESULT_CHUNK_CHARS): ToolMessage[] {
  const json = JSON.stringify(result);
  const total = Math.max(1, Math.ceil(json.length / chunkChars));
  const out: ToolMessage[] = [];
  for(let seq = 0; seq < total; seq++) {
    out.push({t: 'result', callId, seq, total, data: json.slice(seq * chunkChars, (seq + 1) * chunkChars)});
  }
  return out;
}

/** The bundled engine's tools.run / tools.cancel, as main's host client exposes them. */
export interface EngineTools {
  run(runId: string, tool: LocalToolName, args: Record<string, unknown>, timeoutMs?: number): Promise<ToolResult>;
  cancel(runId: string): Promise<void>;
}

export interface LocalToolsHostOptions {
  dataDir: string;
  tools: EngineTools;
  /** Native dialog in main; true only on an explicit Allow. */
  confirm(contactName: string): Promise<boolean>;
  /** Running call count changed (for an activity indicator). */
  onActivity?(running: number): void;
  now?: () => number;
  newDeviceId?: () => string;
  deviceName?: string;
}

interface Running {
  sender: string;
  callId: string;
  runId: string;
  cancelled: boolean;
}

export class LocalToolsHost {
  private state: LocalAccessState;
  private readonly running = new Set<Running>();
  private nextRun = 0;

  constructor(private readonly options: LocalToolsHostOptions) {
    const newDeviceId = options.newDeviceId ?? (() => randomBytes(16).toString('hex'));
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.statePath, 'utf8'));
    } catch{
      raw = undefined;
    }
    this.state = parseLocalAccess(raw, newDeviceId);
    if(raw === undefined) this.save();
  }

  private get statePath(): string {
    return join(this.options.dataDir, LOCAL_ACCESS_FILE);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private save(): void {
    mkdirSync(this.options.dataDir, {recursive: true});
    const tmp = this.statePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), {mode: 0o600});
    renameSync(tmp, this.statePath);
  }

  /** Who is signed in. A different identity starts with every switch OFF. */
  setOwner(ownerPubkey: string): void {
    if(!isHexPubkey(ownerPubkey)) return;
    if(setOwner(this.state, ownerPubkey)) this.revokeAll();
    this.save();
  }

  enabled(): string[] {
    return Object.keys(this.state.enabled);
  }

  capability(): ToolMessage {
    return {
      t: 'capability',
      deviceId: this.state.deviceId,
      deviceName: this.options.deviceName ?? hostname(),
      platform: process.platform,
      tools: LOCAL_TOOL_NAMES
    };
  }

  /**
   * Flip one contact's switch. ON asks in the native dialog; OFF never asks and
   * cancels what that contact has running. Returns the state main ended up
   * with, and the message the contact should now be sent.
   */
  async setLocalAccess(pubkey: string, on: boolean, contactName: string): Promise<{enabled: boolean; notify: ToolMessage | null}> {
    if(!isHexPubkey(pubkey) || !this.state.ownerPubkey || pubkey === this.state.ownerPubkey) return {enabled: false, notify: null};
    const current = isEnabled(this.state, pubkey);
    if(on === current) return {enabled: current, notify: null};
    if(on) {
      if(!await this.options.confirm(contactName)) return {enabled: false, notify: null};
      this.state.enabled[pubkey] = this.now();
      this.save();
      return {enabled: true, notify: this.capability()};
    }
    delete this.state.enabled[pubkey];
    this.save();
    this.revoke(pubkey);
    return {enabled: false, notify: {t: 'revoked', deviceId: this.state.deviceId}};
  }

  /** One verified rumor from `sender`. What comes back is what to send them: usually nothing. */
  async handleMessage(sender: string, payload: unknown, group: CallGroupInfo | null): Promise<ToolMessage[]> {
    if(!isHexPubkey(sender) || !payload || typeof payload !== 'object') return [];
    const message = payload as {t?: unknown; callId?: unknown};
    switch(message.t) {
      case 'hello':
        return isEnabled(this.state, sender) ? [this.capability()] : [];
      case 'cancel':
        if(typeof message.callId === 'string') this.cancel(sender, message.callId);
        return [];
      case 'call': {
        const call = parseToolCall(payload);
        if(!call) return [];
        if(decideToolCall({state: this.state, sender, call, group, now: this.now()}) !== 'run') return [];
        rememberCall(this.state, sender, call, this.now());
        this.save();
        return chunkResult(call.callId, await this.run(sender, call));
      }
      default:
        return [];
    }
  }

  get runningCount(): number {
    return this.running.size;
  }

  private async run(sender: string, call: ToolCall): Promise<ToolResult> {
    // The sender picks callId; the engine sees an id of ours, unique per run.
    const entry: Running = {sender, callId: call.callId, runId: `lt-${++this.nextRun}-${this.now()}`, cancelled: false};
    this.running.add(entry);
    this.options.onActivity?.(this.running.size);
    let result: ToolResult;
    try {
      result = await this.options.tools.run(entry.runId, call.tool, call.args, call.timeoutMs);
    } catch(err) {
      result = {status: 'error', output: err instanceof Error ? err.message : String(err)};
    } finally {
      this.running.delete(entry);
      this.options.onActivity?.(this.running.size);
    }
    if(entry.cancelled) result = {...result, status: 'cancelled'};
    this.log(sender, call, result);
    return result;
  }

  /** A contact may only cancel its own call. */
  private cancel(sender: string, callId: string): void {
    for(const entry of this.running) {
      if(entry.sender !== sender || entry.callId !== callId) continue;
      entry.cancelled = true;
      void this.options.tools.cancel(entry.runId).catch(() => {});
    }
  }

  private revoke(sender: string): void {
    for(const entry of this.running) {
      if(entry.sender !== sender) continue;
      entry.cancelled = true;
      void this.options.tools.cancel(entry.runId).catch(() => {});
    }
  }

  private revokeAll(): void {
    for(const entry of this.running) {
      entry.cancelled = true;
      void this.options.tools.cancel(entry.runId).catch(() => {});
    }
  }

  /** Metadata only. Commands and file contents stay out of the log. */
  private log(sender: string, call: ToolCall, result: ToolResult): void {
    try {
      const path = join(this.options.dataDir, 'local-tools.log');
      mkdirSync(dirname(path), {recursive: true});
      appendFileSync(path, JSON.stringify({
        at: new Date(this.now()).toISOString(),
        contact: sender,
        tool: call.tool,
        status: result.status,
        exit: result.exit
      }) + '\n', {mode: 0o600});
    } catch(err) {
      console.error('could not write the local tool log', err);
    }
  }
}
