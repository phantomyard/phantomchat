/*
 * resolve-release-version.sh contract tests (issue #150 PR#1 review, round 3).
 *
 * Runs the real script with stubbed GITHUB_REF / GITHUB_RUN_NUMBER inputs —
 * no network, no real workflow. Covers Kai's blocker: `desktop-v*` is not a
 * safety boundary (Git tag names may legally contain `$(...)`, backticks,
 * `;`, `|`), so the version must be validated against the exact supported
 * grammar — numeric semver X.Y.Z — before any output is emitted.
 */
import {describe, it, expect} from 'vitest';
import {spawnSync} from 'node:child_process';

const SCRIPT = 'scripts/resolve-release-version.sh';

function run(ref: string, runNumber: string) {
  return spawnSync('bash', [SCRIPT, ref, runNumber], {encoding: 'utf8'});
}

function parseOutput(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.trim().split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

describe('resolve-release-version.sh', () => {
  it('resolves a tag push to the tag version + tag + trigger', () => {
    const r = run('refs/tags/desktop-v1.0.42', '7');
    expect(r.status).toBe(0);
    expect(parseOutput(r.stdout)).toEqual({
      version: '1.0.42',
      tag: 'desktop-v1.0.42',
      trigger: 'tag',
    });
  });

  it('resolves a non-tag ref to the run-number version + synthesized tag', () => {
    const r = run('refs/heads/main', '7');
    expect(r.status).toBe(0);
    expect(parseOutput(r.stdout)).toEqual({
      version: '1.0.7',
      tag: 'desktop-v1.0.7',
      trigger: 'manual',
    });
  });

  it.each([
    ['refs/tags/desktop-v1.0.0$(id)', 'command substitution'],
    ['refs/tags/desktop-v1.0.0`id`', 'backticks'],
    ['refs/tags/desktop-v1.0.0;id', 'semicolon'],
    ['refs/tags/desktop-v1.0.0|id', 'pipe'],
    ['refs/tags/desktop-v1.0.0&&id', '&&'],
    ['refs/tags/desktop-v1.0.0-beta', 'prerelease suffix outside grammar'],
    ['refs/tags/desktop-v1.0', 'two-component version'],
    ['refs/tags/desktop-v01.0.3', 'leading-zero component'],
    ['refs/tags/desktop-v', 'empty version'],
    ['refs/tags/desktop-v1.0.0/x', 'slash in version'],
    ['refs/tags/desktop-v1 0.0', 'whitespace in version'],
  ])('rejects %s (%s) and emits nothing', (ref) => {
    const r = run(ref, '7');
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
  });

  it('rejects a non-numeric run number on the manual path', () => {
    const r = run('refs/heads/main', '7; touch pwned');
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
  });

  it('never lets a refused tag reach stdout even with a valid ref shape', () => {
    // The workflow pipes stdout straight into $GITHUB_OUTPUT; a stray line
    // would be enough to smuggle a value through.
    const r = run('refs/tags/desktop-v1.0.0$(curl example.test)', '7');
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('version=');
  });
});
