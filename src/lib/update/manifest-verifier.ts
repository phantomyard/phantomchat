import type {Manifest, IntegrityResult, IntegrityVerdict} from '@lib/update/types';
import {updateTransport} from '@lib/update/update-transport';

interface ManifestSource {
  name: string;
  url: string;
}

export const MANIFEST_SOURCES: ManifestSource[] = [
  {name: 'cdn', url: '/update-manifest.json'},
  {name: 'github-pages', url: 'https://nostra-chat.github.io/nostra-chat/update-manifest.json'},
  {name: 'ipfs', url: 'https://ipfs.nostra.chat/update-manifest.json'}
];

function getSources(): ManifestSource[] {
  if(typeof globalThis !== 'undefined') {
    const override = (globalThis as any).__NOSTRA_TEST_MANIFEST_SOURCES__;
    if(Array.isArray(override)) return override;
  }
  return MANIFEST_SOURCES;
}

const SUPPORTED_SCHEMAS: ReadonlyArray<number> = [1, 2];

// `fetchOne` returns a tagged result instead of throwing so the caller can
// tell network failures apart from validation failures. Before this split,
// any error at a source — HTTP 500, invalid JSON, or unsupported schema —
// produced the same `offline` top-level verdict, which made the 0.15.0
// "offline → unsupported schemaVersion 2" report look like network trouble
// when the real cause was a client pinned to schema 1 while the release
// manifest had moved to 2.
type FetchOneResult =
  | {kind: 'ok'; manifest: Manifest}
  | {kind: 'network'; error: string}
  | {kind: 'validation'; error: string};

async function fetchOne(source: ManifestSource): Promise<FetchOneResult> {
  let res: Response;
  try {
    res = await updateTransport.fetch(source.url, {cache: 'no-store'});
  } catch(err) {
    return {kind: 'network', error: err instanceof Error ? err.message : String(err)};
  }
  if(!res.ok) return {kind: 'network', error: `HTTP ${res.status}`};
  let m: Manifest;
  try {
    m = await res.json() as Manifest;
  } catch(err) {
    return {kind: 'validation', error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`};
  }
  if(!SUPPORTED_SCHEMAS.includes(m.schemaVersion)) {
    return {kind: 'validation', error: `unsupported schemaVersion ${m.schemaVersion}`};
  }
  if(!m.version || !m.swUrl || !m.bundleHashes || !m.bundleHashes[m.swUrl]) {
    return {kind: 'validation', error: 'malformed manifest'};
  }
  return {kind: 'ok', manifest: m};
}

function keyFields(m: Manifest): string {
  return JSON.stringify({
    version: m.version,
    gitSha: m.gitSha,
    swUrl: m.swUrl,
    swHash: m.bundleHashes[m.swUrl]
  });
}

export async function verifyManifestsAcrossSources(): Promise<IntegrityResult> {
  const sources = getSources();
  const results = await Promise.all(sources.map(fetchOne));

  const sourcesBreakdown: IntegrityResult['sources'] = sources.map((src, i) => {
    const r = results[i];
    if(r.kind === 'ok') {
      return {name: src.name, status: 'ok', version: r.manifest.version, gitSha: r.manifest.gitSha, swUrl: r.manifest.swUrl};
    }
    return {name: src.name, status: 'error', error: r.error};
  });

  const ok = results
  .map((r, i) => r.kind === 'ok' ? {source: sources[i].name, manifest: r.manifest} : null)
  .filter((x): x is {source: string; manifest: Manifest} => x !== null);

  const checkedAt = Date.now();

  if(ok.length === 0) {
    // Distinguish a pure network outage (every source errored at the network
    // level) from a deployment/config issue (at least one source responded
    // but the manifest it served failed schema or shape validation).
    const anyValidation = results.some((r) => r.kind === 'validation');
    const verdict: IntegrityVerdict = anyValidation ? 'error' : 'offline';
    return {verdict, sources: sourcesBreakdown, checkedAt};
  }

  if(ok.length === 1) {
    return {verdict: 'insufficient', sources: sourcesBreakdown, checkedAt};
  }

  const byKey = new Map<string, Manifest>();
  for(const {manifest} of ok) {
    byKey.set(keyFields(manifest), manifest);
  }

  if(byKey.size > 1) {
    return {verdict: 'conflict', sources: sourcesBreakdown, checkedAt};
  }

  const agreed = ok[0].manifest;
  const verdict: IntegrityVerdict = ok.length >= 3 ? 'verified' : 'verified-partial';
  return {verdict, manifest: agreed, sources: sourcesBreakdown, checkedAt};
}
