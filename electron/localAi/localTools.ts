/*
 * Runs one tool call for a remote contact (issue #276). The gate has already
 * passed by the time run() is called; revoke() is what turning the switch OFF
 * calls, and it cancels whatever that contact has in flight.
 */
import {appendFileSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import type {ToolCall} from './localAccess';
import {errorText} from './scrub';

export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
export const MAX_TOOL_TIMEOUT_MS = 600_000;

export interface ToolResult {
  status: 'ok' | 'error' | 'cancelled' | 'timeout';
  output: string;
  exit?: number;
  truncated?: boolean;
}

export type ToolResolver = (name: string) => Promise<{
  execute(id: string, args: unknown, signal: AbortSignal, onUpdate: () => void): Promise<any>;
}>;

interface InFlight {
  sender: string;
  controller: AbortController;
  cancelled: boolean;
}

export class LocalToolRunner {
  private readonly inFlight = new Map<string, InFlight>();

  constructor(private readonly options: {
    resolveTool: ToolResolver;
    logPath: string;
    onActivity(running: number): void;
    now?: () => number;
  }) {}

  get running(): number {
    return this.inFlight.size;
  }

  async run(sender: string, call: ToolCall): Promise<ToolResult> {
    const controller = new AbortController();
    const entry: InFlight = {sender, controller, cancelled: false};
    this.inFlight.set(call.callId, entry);
    this.options.onActivity(this.inFlight.size);

    const requested = typeof call.timeoutMs === 'number' && call.timeoutMs > 0 ? call.timeoutMs : DEFAULT_TOOL_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.min(requested, MAX_TOOL_TIMEOUT_MS));

    let result: ToolResult;
    try {
      const tool = await this.options.resolveTool(call.tool);
      const raw = await tool.execute(call.callId, call.args, controller.signal, () => {});
      result = toResult(raw);
    } catch(err) {
      result = {status: 'error', output: errorText(err)};
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(call.callId);
      this.options.onActivity(this.inFlight.size);
    }

    if(entry.cancelled) result = {...result, status: 'cancelled'};
    else if(timedOut) result = {...result, status: 'timeout'};
    this.log(sender, call, result);
    return result;
  }

  /** A contact may only cancel its own call. */
  cancel(sender: string, callId: string): boolean {
    const entry = this.inFlight.get(callId);
    if(!entry || entry.sender !== sender) return false;
    entry.cancelled = true;
    entry.controller.abort();
    return true;
  }

  revoke(sender: string): number {
    let count = 0;
    for(const entry of this.inFlight.values()) {
      if(entry.sender !== sender) continue;
      entry.cancelled = true;
      entry.controller.abort();
      count++;
    }
    return count;
  }

  /** Metadata only. Commands and file contents stay out of the log. */
  private log(sender: string, call: ToolCall, result: ToolResult): void {
    try {
      mkdirSync(dirname(this.options.logPath), {recursive: true});
      appendFileSync(this.options.logPath, JSON.stringify({
        at: new Date(this.options.now?.() ?? Date.now()).toISOString(),
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

function toResult(raw: any): ToolResult {
  const output = Array.isArray(raw?.content) ?
    raw.content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('') :
    '';
  const structured = raw?.structuredContent;
  return {
    status: raw?.isError ? 'error' : 'ok',
    output,
    ...(typeof structured?.exit_code === 'number' ? {exit: structured.exit_code} : {}),
    ...(structured?.truncated ? {truncated: true} : {})
  };
}
