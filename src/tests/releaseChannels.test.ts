// @vitest-environment node
import {afterEach, describe, expect, it} from 'vitest';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {checkCompatibility} from '../../scripts/channels/check.mjs';
import {checkPublishedCompatibility} from '../../scripts/channels/check-published.mjs';

let dir: string;
afterEach(() => {
  if(dir) rmSync(dir, {recursive: true, force: true});
});
function fixture(): {stableRef: string; compatibilityApprovals: Record<string, {stable: string; preview: string; published?: string}>} {
  mkdirSync('.channel-build', {recursive: true});
  dir = mkdtempSync(resolve('.channel-build/gate-'));
  const git = (...args: string[]) => execFileSync('git', args, {cwd: dir}).toString().trim();
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  mkdirSync(resolve(dir, 'src'));
  writeFileSync(resolve(dir, 'src/store.ts'), 'const version = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'Stable');
  const stableRef = git('rev-parse', 'HEAD');
  writeFileSync(resolve(dir, 'src/store.ts'), 'const version = 2;\n');
  git('add', '.');
  git('commit', '-qm', 'Preview');
  return {stableRef, compatibilityApprovals: {}};
}
describe('shared-state release gate', () => {
  it('rejects unapproved storage changes', () => {
    expect(() => checkCompatibility(fixture(), 'HEAD', dir)).toThrow('compatibility review required');
  });
  it('requires both exact approved hashes and invalidates stale approvals', () => {
    const config = fixture();
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    config.compatibilityApprovals['src/store.ts'] = {stable: hash('const version = 1;\n'), preview: hash('const version = 2;\n')};
    expect(checkCompatibility(config, 'HEAD', dir)).toEqual(['src/store.ts']);
    config.compatibilityApprovals['src/store.ts'].preview = hash('different');
    expect(() => checkCompatibility(config, 'HEAD', dir)).toThrow('compatibility review required');
  });
  it('checks the supplied deployed baseline instead of the local pin in the CLI', () => {
    const config = fixture();
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    config.compatibilityApprovals['src/store.ts'] = {
      stable: hash('const version = 1;\n'),
      preview: hash('const version = 2;\n')
    };
    mkdirSync(resolve(dir, 'scripts/channels'), {recursive: true});
    writeFileSync(resolve(dir, 'scripts/channels/config.json'), JSON.stringify(config));
    const baseline = resolve(dir, 'deployed.json');
    const deployed = {...config, compatibilityApprovals: {}};
    writeFileSync(baseline, JSON.stringify(deployed));
    const script = resolve('scripts/channels/check.mjs');
    const run = (baselinePath: string) => spawnSync(process.execPath, [script], {
      cwd: dir,
      env: {...process.env, CHANNEL_BASELINE: baselinePath},
      encoding: 'utf8'
    });
    expect(run('').status).toBe(0);
    const rejected = run(baseline);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('src/store.ts');
    writeFileSync(baseline, JSON.stringify(config));
    expect(run(baseline).status).toBe(0);
    expect(run(resolve(dir, 'missing.json')).status).not.toBe(0);
  });
  it('uses the deployed SHA even when the local pin would pass with no approvals', async() => {
    const config = fixture();
    const deployed = config.stableRef;
    config.stableRef = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: dir}).toString().trim();
    expect(checkCompatibility(config, 'HEAD', dir)).toEqual([]);
    const fetcher: typeof fetch = async(input, options) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe('https://chat.phantomyard.ai/channels.json');
      expect(url.searchParams.has('compatibility')).toBe(true);
      expect(options?.cache).toBe('no-store');
      return new Response(JSON.stringify({stable: deployed, preview: config.stableRef}));
    };
    await expect(checkPublishedCompatibility(config, 'HEAD', dir, fetcher)).rejects.toThrow('src/store.ts');
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    config.compatibilityApprovals['src/store.ts'] = {
      stable: hash('const version = 1;\n'), preview: hash('const version = 2;\n')
    };
    await expect(checkPublishedCompatibility(config, 'HEAD', dir, fetcher)).resolves.toEqual(['src/store.ts']);
  });
  it('fails closed on unavailable or malformed published metadata', async() => {
    const config = fixture();
    await expect(checkPublishedCompatibility(config, 'HEAD', dir, async() => new Response('', {status: 503})))
      .rejects.toThrow('HTTP 503');
    await expect(checkPublishedCompatibility(config, 'HEAD', dir, async() => new Response(JSON.stringify({stable: 'main'}))))
      .rejects.toThrow('Invalid published');
    await expect(checkPublishedCompatibility(config, 'HEAD', dir, async() => { throw new Error('offline'); }))
      .rejects.toThrow('offline');
  });
  it('checks the deployed column when the deployed Stable is ahead of the repo pin', () => {
    // c1 = repo pin (the last Electron release), c2 = deployed Stable (a PWA
    // promotion, which mints no release tag), c3 = this PR.
    const config = fixture();
    const pin = config.stableRef;
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const deployed = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: dir}).toString().trim();
    writeFileSync(resolve(dir, 'src/store.ts'), 'const version = 3;\n');
    execFileSync('git', ['commit', '-qam', 'Preview'], {cwd: dir});
    expect(pin).not.toBe(deployed);

    config.compatibilityApprovals['src/store.ts'] = {
      stable: hash('const version = 1;\n'),
      preview: hash('const version = 3;\n')
    };
    // The repository pin can never describe the deployed content: the row is
    // falsified for c2 unless it carries the digest reviewed there.
    expect(checkCompatibility(config, 'HEAD', dir)).toEqual(['src/store.ts']);
    expect(() => checkCompatibility({...config, stableRef: deployed}, 'HEAD', dir, 'published'))
      .toThrow('compatibility review required');

    config.compatibilityApprovals['src/store.ts'].published = hash('const version = 2;\n');
    expect(checkCompatibility({...config, stableRef: deployed}, 'HEAD', dir, 'published')).toEqual(['src/store.ts']);
    // ...and a wrong deployed digest is rejected, not ignored.
    config.compatibilityApprovals['src/store.ts'].published = hash('stale');
    expect(() => checkCompatibility({...config, stableRef: deployed}, 'HEAD', dir, 'published'))
      .toThrow('compatibility review required');
    // The pin itself is unchanged by the extra column.
    expect(checkCompatibility(config, 'HEAD', dir)).toEqual(['src/store.ts']);
  });
});
