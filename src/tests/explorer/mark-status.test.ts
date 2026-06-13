import {describe, expect, it, beforeEach, afterEach} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';

/**
 * Smoke test for the F3 mark-status CLI. The fixer subagent shells out to
 * this script to update seen-signatures.json — the contract being tested
 * is that running it with valid args mutates the store as expected.
 */

const SCRIPT = resolve(__dirname, '../../../scripts/explorer/mark-status.ts');
const TSX = resolve(__dirname, '../../../node_modules/.bin/tsx');
const SIG = 'messaging:send_text_message:A:console_error:e48fd634';

describe('explorer mark-status CLI', () => {
  let tmpRoot: string;
  let storePath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'mark-status-'));
    storePath = join(tmpRoot, 'seen-signatures.json');
    writeFileSync(storePath, JSON.stringify({
      [SIG]: {
        find_id: 'FIND-0be5c329',
        occurrences: 1,
        first_seen: '2026-04-30T21:51:48.091Z',
        last_seen: '2026-04-30T21:51:48.091Z',
        status: 'open'
      }
    }));
  });

  afterEach(() => {
    rmSync(tmpRoot, {recursive: true, force: true});
  });

  it('report-only sets status + reason', () => {
    execFileSync(TSX, [SCRIPT, 'report-only', storePath, SIG, 'category-disallowed:messageport'], {stdio: 'pipe'});
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    expect(store[SIG].status).toBe('report-only');
    expect(store[SIG].report_only_reason).toBe('category-disallowed:messageport');
  });

  it('fix-pr-open sets status + fix_pr + fix_branch', () => {
    execFileSync(TSX, [SCRIPT, 'fix-pr-open', storePath, SIG, 'https://github.com/x/y/pull/42', 'explorer/fix-FIND-0be5c329'], {stdio: 'pipe'});
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    expect(store[SIG].status).toBe('fix-pr-open');
    expect(store[SIG].fix_pr).toBe('https://github.com/x/y/pull/42');
    expect(store[SIG].fix_branch).toBe('explorer/fix-FIND-0be5c329');
  });

  it('fixed flips status to fixed', () => {
    execFileSync(TSX, [SCRIPT, 'fixed', storePath, SIG], {stdio: 'pipe'});
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    expect(store[SIG].status).toBe('fixed');
  });

  it('exits non-zero on missing args', () => {
    expect(() => execFileSync(TSX, [SCRIPT, 'report-only', storePath], {stdio: 'pipe'})).toThrow();
  });

  it('exits non-zero on unknown action', () => {
    expect(() => execFileSync(TSX, [SCRIPT, 'invalid-action', storePath, SIG], {stdio: 'pipe'})).toThrow();
  });
});
