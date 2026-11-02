/*
 * The wire format for remote tool calls (issue #276), carried in NIP-17 rumors
 * marked with a ['phantomchat-local-tools', '1'] tag. The renderer owns the
 * principal's key, so it unwraps, verifies and sends; everything here decides.
 *
 * See docs/EXTERNAL-AI.md for the whole protocol.
 */
import type {LocalToolName} from './localAccess';
import type {ToolResult} from './localTools';

export const RESULT_CHUNK_CHARS = 24_000;

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
