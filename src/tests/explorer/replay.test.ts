import {describe, expect, it} from 'vitest';
import {parseTraceFile} from '../../../scripts/explorer/replay';
import {writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

describe('replay parser', () => {
  it('parses a 2-step trace file', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'replay-'));
    const trace: Array<{step: number; intent: string; params: Record<string, unknown>; atomic_trace: unknown[]}> = [
      {step: 1, intent: 'send_text_message', params: {from: 'userA', text: 'a'}, atomic_trace: []},
      {step: 2, intent: 'react_to_message', params: {from: 'userB', emoji: '🔥'}, atomic_trace: []}
    ];
    writeFileSync(join(tmp, 'trace.jsonl'), trace.map((s) => JSON.stringify(s)).join('\n') + '\n');
    const parsed = parseTraceFile(join(tmp, 'trace.jsonl'));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].intent).toBe('send_text_message');
    rmSync(tmp, {recursive: true, force: true});
  });

  it('throws on malformed JSON', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'replay-'));
    writeFileSync(join(tmp, 'trace.jsonl'), 'not json\n');
    expect(() => parseTraceFile(join(tmp, 'trace.jsonl'))).toThrow();
    rmSync(tmp, {recursive: true, force: true});
  });
});
