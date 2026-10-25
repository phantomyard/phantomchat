// @vitest-environment node
import {describe, expect, it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {checkCompatibility} from '../../scripts/channels/check.mjs';

const ref = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim();
describe('shared-state release gate', () => {
  it('accepts identical sources', () => {
    expect(checkCompatibility({stableRef: ref, compatibilityApprovals: {}}, ref)).toEqual([]);
  });
  it('rejects unapproved application changes relative to the first commit', () => {
    const first = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD']).toString().trim().split('\n')[0];
    expect(() => checkCompatibility({stableRef: first, compatibilityApprovals: {}}, ref)).toThrow('compatibility review required');
  });
});
