import {describe, expect, it, beforeEach, afterEach} from 'vitest';
import {mkdtempSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writeReport, type ReportInput} from '../../../scripts/explorer/reporter';

describe('reporter error kind', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'exp-reporter-err-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, {recursive: true, force: true});
  });

  it('writes an errors/<id>/ directory with stderr.log + report.md when kind=error', async() => {
    const input: ReportInput = {
      reportRoot: tmpRoot,
      kind: 'error',
      goal: 'send a message',
      trace: [],
      finding: null,
      screenshots: [],
      errorReason: 'driver failed to boot: harness timed out waiting for userA onboarding',
      errorStderr: '[harness] boot: ...\n[ERROR] First-install popup intercepted click\n'
    };
    const dir = await writeReport(input);
    expect(dir).toMatch(/errors\/[0-9a-f-]+$/);
    expect(existsSync(join(dir, 'report.md'))).toBe(true);
    expect(existsSync(join(dir, 'stderr.log'))).toBe(true);
    const md = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(md).toContain('# Error');
    expect(md).toContain('driver failed to boot');
    const stderr = readFileSync(join(dir, 'stderr.log'), 'utf8');
    expect(stderr).toContain('First-install popup');
  });
});
