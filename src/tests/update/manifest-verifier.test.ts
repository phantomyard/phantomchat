import {describe, it, expect, afterEach} from 'vitest';
import {verifyManifestsAcrossSources, MANIFEST_SOURCES} from '@lib/update/manifest-verifier';
import {setUpdateTransport, resetUpdateTransport} from '@lib/update/update-transport';
import type {Manifest} from '@lib/update/types';

type SourceName = 'cdn' | 'github-pages' | 'ipfs';

const validManifest = (overrides: Partial<Manifest> = {}): Manifest => ({
  schemaVersion: 1,
  version: '0.8.0',
  gitSha: 'abc123',
  published: '2026-05-10T12:00:00Z',
  swUrl: './sw-xyz.js',
  bundleHashes: {'./sw-xyz.js': 'sha256-aaa', './index.html': 'sha256-bbb'},
  changelog: 'changes',
  ...overrides
});

function mockBySource(results: Record<SourceName, Manifest | Error>): void {
  const byUrl = new Map<string, Manifest | Error>();
  for(const src of MANIFEST_SOURCES) {
    byUrl.set(src.url, results[src.name as SourceName]);
  }
  setUpdateTransport(async(url: any) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const result = byUrl.get(urlStr);
    if(result === undefined) throw new Error(`no mock for ${urlStr}`);
    if(result instanceof Error) throw result;
    return new Response(JSON.stringify(result), {status: 200}) as any;
  });
}

describe('verifyManifestsAcrossSources', () => {
  afterEach(() => resetUpdateTransport());

  it('returns verified when all 3 sources agree', async() => {
    const m = validManifest();
    mockBySource({'cdn': m, 'github-pages': m, 'ipfs': m});

    const result = await verifyManifestsAcrossSources();
    expect(result.verdict).toBe('verified');
    expect(result.manifest).toEqual(m);
    expect(result.sources.filter(s => s.status === 'ok')).toHaveLength(3);
  });

  it('returns verified-partial when 2 succeed and 1 offline, and the 2 agree', async() => {
    const m = validManifest();
    mockBySource({'cdn': m, 'github-pages': m, 'ipfs': new Error('offline')});

    const result = await verifyManifestsAcrossSources();
    expect(result.verdict).toBe('verified-partial');
    expect(result.manifest).toEqual(m);
  });

  it('returns conflict when sources disagree on version', async() => {
    const m1 = validManifest({version: '0.8.0'});
    const m2 = validManifest({version: '0.9.0'});
    mockBySource({'cdn': m1, 'github-pages': m2, 'ipfs': m1});

    const result = await verifyManifestsAcrossSources();
    expect(result.verdict).toBe('conflict');
  });

  it('returns insufficient when only 1 source succeeds', async() => {
    const m = validManifest();
    mockBySource({'cdn': m, 'github-pages': new Error('nope'), 'ipfs': new Error('nope')});

    const result = await verifyManifestsAcrossSources();
    expect(result.verdict).toBe('insufficient');
  });

  it('returns offline when all sources fail', async() => {
    mockBySource({'cdn': new Error('nope'), 'github-pages': new Error('nope'), 'ipfs': new Error('nope')});

    const result = await verifyManifestsAcrossSources();
    expect(result.verdict).toBe('offline');
    expect(result.manifest).toBeUndefined();
  });

  it('rejects manifests with unknown schemaVersion with verdict error (not offline)', async() => {
    const m = validManifest({schemaVersion: 99});
    mockBySource({'cdn': m, 'github-pages': m, 'ipfs': m});

    const result = await verifyManifestsAcrossSources();
    // Historically this returned 'offline', conflating network failure with
    // schema rejection — the symptom surfaced in 0.15.0 when clients pinned
    // to schema 1 met manifests that had moved to schema 2.
    expect(result.verdict).toBe('error');
    expect(result.sources.every((s) => s.status === 'error')).toBe(true);
    expect(result.sources[0].error).toMatch(/unsupported schemaVersion 99/);
  });

  it('accepts schemaVersion 2 (current release shape)', async() => {
    const m = validManifest({schemaVersion: 2});
    mockBySource({'cdn': m, 'github-pages': m, 'ipfs': m});

    const result = await verifyManifestsAcrossSources();
    expect(result.verdict).toBe('verified');
  });

  it('tolerates changelog differences across sources (whitespace etc.)', async() => {
    const base = validManifest();
    mockBySource({
      'cdn': {...base, changelog: 'foo'},
      'github-pages': {...base, changelog: 'foo\n'},
      'ipfs': {...base, changelog: 'bar'}
    });

    const result = await verifyManifestsAcrossSources();
    expect(result.verdict).toBe('verified');
  });
});
