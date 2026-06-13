import {describe, expect, it, beforeEach, afterEach} from 'vitest';
import {mkdtempSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadCoverage, recordRun, pickColdZone, type CoverageStore} from '../../../scripts/explorer/areas-coverage';

describe('areas coverage tracker', () => {
  let tmpRoot: string;
  let storePath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'exp-coverage-'));
    storePath = join(tmpRoot, 'areas-coverage.json');
  });

  afterEach(() => {
    rmSync(tmpRoot, {recursive: true, force: true});
  });

  it('loadCoverage returns {} when the file does not exist', async() => {
    const c = await loadCoverage(storePath);
    expect(c).toEqual({});
  });

  it('recordRun creates the store on first call', async() => {
    await recordRun(storePath, 'messaging', '2026-04-30T10:00:00Z');
    const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as CoverageStore;
    expect(parsed.messaging).toMatchObject({runs: 1, last_run: '2026-04-30T10:00:00Z'});
  });

  it('recordRun bumps count for repeat areas', async() => {
    await recordRun(storePath, 'profile', 't0');
    await recordRun(storePath, 'profile', 't1');
    await recordRun(storePath, 'media', 't2');
    const c = await loadCoverage(storePath);
    expect(c.profile.runs).toBe(2);
    expect(c.media.runs).toBe(1);
    expect(c.profile.last_run).toBe('t1');
  });

  it('pickColdZone returns an area not in the store when one is missing', async() => {
    await recordRun(storePath, 'messaging', 't0');
    await recordRun(storePath, 'navigation', 't1');
    const cold = await pickColdZone(storePath, ['messaging', 'navigation', 'profile', 'media', 'edge', 'network', 'settings']);
    expect(['profile', 'media', 'edge', 'network', 'settings']).toContain(cold);
  });

  it('pickColdZone returns the area with the lowest count when all are in the store', async() => {
    await recordRun(storePath, 'messaging', 't0');
    await recordRun(storePath, 'messaging', 't1');
    await recordRun(storePath, 'profile', 't2');
    const cold = await pickColdZone(storePath, ['messaging', 'profile']);
    expect(cold).toBe('profile');
  });
});
