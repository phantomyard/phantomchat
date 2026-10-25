// @vitest-environment node
import {afterEach, describe, expect, it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {checkCompatibility} from '../../scripts/channels/check.mjs';

const original = process.cwd();
let dir: string;
afterEach(() => {
  process.chdir(original);
  if(dir) rmSync(dir, {recursive: true, force: true});
});
function fixture() {
  mkdirSync('.channel-build', {recursive: true});
  dir = mkdtempSync(resolve('.channel-build/gate-'));
  process.chdir(dir);
  const git = (...args: string[]) => execFileSync('git', args).toString().trim();
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  mkdirSync('src');
  writeFileSync('src/store.ts', 'const version = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'Stable');
  const stableRef = git('rev-parse', 'HEAD');
  writeFileSync('src/store.ts', 'const version = 2;\n');
  git('add', '.');
  git('commit', '-qm', 'Preview');
  return {stableRef, compatibilityApprovals: {}};
}
describe('shared-state release gate', () => {
  it('rejects unapproved storage changes', () => {
    expect(() => checkCompatibility(fixture())).toThrow('compatibility review required');
  });
  it('requires both exact approved hashes and invalidates stale approvals', () => {
    const config = fixture();
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    config.compatibilityApprovals['src/store.ts'] = {stable: hash('const version = 1;\n'), preview: hash('const version = 2;\n')};
    expect(checkCompatibility(config)).toEqual(['src/store.ts']);
    config.compatibilityApprovals['src/store.ts'].preview = hash('different');
    expect(() => checkCompatibility(config)).toThrow('compatibility review required');
  });
});
