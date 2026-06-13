import {describe, expect, it, beforeEach, afterEach} from 'vitest';
import {mkdtempSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writeReport, type ReportInput} from '../../../scripts/explorer/reporter';

describe('explorer reporter', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'exp-reporter-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, {recursive: true, force: true});
  });

  it('writes a FIND-<id>/ directory with trace.jsonl, report.md, signature.txt', async() => {
    const input: ReportInput = {
      reportRoot: tmpRoot,
      kind: 'finding',
      goal: 'send a message',
      trace: [
        {step: 1, intent: 'send_text_message', params: {from: 'userA', text: 'hi'},
         atomic_trace: [{type: 'click', page: 'A', selector: '.send'}]}
      ],
      finding: {
        oracle: 'console_error',
        page: 'A',
        message: '[ERROR] something broke',
        hash: 'deadbeef'
      },
      screenshots: []
    };
    const dir = await writeReport(input);
    expect(dir).toMatch(/FIND-[0-9a-f]{8}$/);
    expect(existsSync(join(dir, 'trace.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'report.md'))).toBe(true);
    expect(existsSync(join(dir, 'signature.txt'))).toBe(true);
    expect(readFileSync(join(dir, 'signature.txt'), 'utf8')).toContain('console_error');
  });

  it('writes a runs/<run-id>/ directory when kind=run (no finding)', async() => {
    const input: ReportInput = {
      reportRoot: tmpRoot,
      kind: 'run',
      goal: 'send a message',
      trace: [{step: 1, intent: 'send_text_message', params: {from: 'userA', text: 'hi'}, atomic_trace: []}],
      finding: null,
      screenshots: []
    };
    const dir = await writeReport(input);
    expect(dir).toMatch(/runs\/[0-9a-f-]+$/);
    expect(existsSync(join(dir, 'trace.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'report.md'))).toBe(true);
  });
});
