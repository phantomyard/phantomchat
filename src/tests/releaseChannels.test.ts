// @vitest-environment node
import {afterEach, describe, expect, it} from 'vitest';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {checkCompatibility, baselineDigestFor} from '../../scripts/channels/check.mjs';
import {checkPromotion, deployBaseline} from '../../scripts/releases/registry.mjs';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {checkPublishedCompatibility} from '../../scripts/channels/check-published.mjs';

let dir: string;
afterEach(() => {
  if(dir) rmSync(dir, {recursive: true, force: true});
});
function fixture(): {stableRef: string; compatibilityApprovals: Record<string, {stable: string; preview: string}>} {
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
  it('against the deployed Stable, approves exact candidate bytes whatever was promoted', () => {
    // c1 = repo pin (the last Electron release), c2 = deployed Stable (a PWA
    // promotion, which mints no release tag), c3 = this PR.
    const config = fixture();
    const pin = config.stableRef;
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const deployed = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: dir}).toString().trim();
    writeFileSync(resolve(dir, 'src/store.ts'), 'const version = 3;\n');
    execFileSync('git', ['commit', '-qam', 'Preview'], {cwd: dir});
    expect(pin).not.toBe(deployed);
    config.compatibilityApprovals['src/store.ts'] = {stable: hash('const version = 1;\n'), preview: hash('const version = 3;\n')};
    const baseline = {...config, stableRef: deployed, pinRef: pin};
    expect(baselineDigestFor(baseline)).toBe('deployed');
    // No config change after the promotion: the row approves the candidate.
    expect(checkCompatibility(baseline, 'HEAD', dir, 'deployed')).toEqual(['src/store.ts']);
    // The pin's exact digest still applies when checking against the pin...
    expect(checkCompatibility(config, 'HEAD', dir)).toEqual(['src/store.ts']);
    // ...and would be wrong against the deployed content.
    expect(() => checkCompatibility(baseline, 'HEAD', dir, 'stable')).toThrow('compatibility review required');
    // Unreviewed candidate bytes, or a missing row, fail closed.
    config.compatibilityApprovals['src/store.ts'].preview = hash('stale');
    expect(() => checkCompatibility(baseline, 'HEAD', dir, 'deployed')).toThrow('compatibility review required');
    expect(() => checkCompatibility({...baseline, compatibilityApprovals: {}}, 'HEAD', dir, 'deployed')).toThrow('src/store.ts');
    // ...and the check.mjs CLI resolves the same mode from CHANNEL_BASELINE.
    config.compatibilityApprovals['src/store.ts'].preview = hash('const version = 3;\n');
    writeFileSync(resolve(dir, 'baseline.json'), JSON.stringify({...config, stableRef: deployed, pinRef: pin}));
    const cli = spawnSync(process.execPath, [resolve('scripts/channels/check.mjs')], {
      cwd: dir,
      env: {...process.env, CHANNEL_BASELINE: resolve(dir, 'baseline.json')},
      encoding: 'utf8'
    });
    expect(cli.stderr).toBe('');
    expect(cli.status).toBe(0);
  });
  it('picks the pin rule only when the baseline IS the pin', () => {
    const pin = 'a'.repeat(40);
    expect(baselineDigestFor({stableRef: pin})).toBe('stable');
    expect(baselineDigestFor({stableRef: pin, pinRef: pin})).toBe('stable');
    expect(baselineDigestFor({stableRef: 'b'.repeat(40), pinRef: pin})).toBe('deployed');
  });
  it('the deploy builder resolves the column from the baseline registry writes', () => {
    // registry.mjs `baseline` is the only producer of the file build.mjs reads
    // as CHANNEL_BASELINE, so the pin has to survive that rewrite. If it does
    // not, both refs look identical, the selector returns `stable`, and the
    // original outage is back with no other test failing.
    const config = {stableRef: 'a'.repeat(40), stableVersion: '1.0.1', compatibilityApprovals: {}};
    const record = {stableRef: 'b'.repeat(40), stableVersion: '1.0.9'};
    const baseline = deployBaseline(config, record);
    expect(baseline.pinRef).toBe(config.stableRef);
    expect(baseline.stableRef).toBe(record.stableRef);
    expect(baseline.stableVersion).toBe('1.0.9');
    expect(baselineDigestFor(baseline)).toBe('deployed');
    // The repository config is not a baseline: it carries no pinRef, and its
    // stableRef is the pin.
    expect(baselineDigestFor(config)).toBe('stable');
  });
  it('build.mjs derives its column instead of trusting the default', () => {
    // build.mjs imports checkCompatibility and calls it directly, so no CLI
    // test covers the deploy lane's call site. `pnpm run build` cannot run in
    // a test, so the call shape is what is asserted: dropping the fourth
    // argument silently restores the pin's column for a deployed baseline.
    const builder = readFileSync(join(process.cwd(), 'scripts', 'channels', 'build.mjs'), 'utf8');
    expect(builder).toMatch(/checkCompatibility\(config, candidate, root, baselineDigestFor\(config\)\)/);
  });

  // pin (v1) -> deployed Stable (v2) -> newly promoted Stable (v3) -> main (v4)
  const promotionHistory = () => {
    const config = fixture();
    const git = (...args: string[]) => execFileSync('git', args, {cwd: dir}).toString().trim();
    const deployed = git('rev-parse', 'HEAD');
    for(const version of [3, 4]) {
      writeFileSync(resolve(dir, 'src/store.ts'), `const version = ${version};\n`);
      git('commit', '-qam', `v${version}`);
    }
    const promoted = git('rev-parse', 'HEAD~1');
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const v = (n: number) => hash(`const version = ${n};\n`);
    config.compatibilityApprovals['src/store.ts'] = {stable: v(1), preview: v(4)};
    return {config, pin: config.stableRef, deployed, promoted, v};
  };
  const channelsAt = (stable: string): typeof fetch => async() => new Response(JSON.stringify({stable, preview: stable}));

  it('the PR gate applies the pin rule after a rollback to the pin (#377)', async() => {
    const {config, pin} = promotionHistory();
    await expect(checkPublishedCompatibility(config, 'HEAD', dir, channelsAt(pin))).resolves.toEqual(['src/store.ts']);
    const wrongPin = {...config, compatibilityApprovals: {'src/store.ts': {...config.compatibilityApprovals['src/store.ts'], stable: 'f'.repeat(64)}}};
    await expect(checkPublishedCompatibility(wrongPin, 'HEAD', dir, channelsAt(pin))).rejects.toThrow('src/store.ts');
  });

  it('a promotion leaves the PR gate green with no config change (#301)', async() => {
    const {config, deployed, promoted} = promotionHistory();
    await expect(checkPublishedCompatibility(config, 'HEAD', dir, channelsAt(deployed))).resolves.toEqual(['src/store.ts']);
    await expect(checkPublishedCompatibility(config, 'HEAD', dir, channelsAt(promoted))).resolves.toEqual(['src/store.ts']);
    // Content nobody reviewed still blocks against any deployed Stable.
    const drifted = {...config, compatibilityApprovals: {'src/store.ts': {...config.compatibilityApprovals['src/store.ts'], preview: 'f'.repeat(64)}}};
    await expect(checkPublishedCompatibility(drifted, 'HEAD', dir, channelsAt(promoted))).rejects.toThrow('src/store.ts');
  });

  it('an explicit older promotion checks the rule that matches its base (#374)', () => {
    const {config, deployed, pin} = promotionHistory();
    expect(checkPromotion(config, deployed, 'HEAD', dir)).toEqual(['src/store.ts']);
    expect(checkPromotion(config, pin, 'HEAD', dir)).toEqual(['src/store.ts']);
    const drifted = {...config, compatibilityApprovals: {'src/store.ts': {...config.compatibilityApprovals['src/store.ts'], preview: 'f'.repeat(64)}}};
    expect(() => checkPromotion(drifted, deployed, 'HEAD', dir)).toThrow('compatibility review required');
  });

  it('the promote workflow opens no PR and needs no extra token', () => {
    const workflow = readFileSync(join(process.cwd(), '.github', 'workflows', 'pwa-promote.yml'), 'utf8');
    expect(workflow).not.toMatch(/pull-requests: write|gh pr create|REPIN_PR_TOKEN|repin\.mjs/);
  });
});
