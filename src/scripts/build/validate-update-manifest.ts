#!/usr/bin/env tsx
/**
 * Validates a generated update-manifest.json. Used in CI to fail-fast
 * on malformed manifests before publish.
 */

import {readFileSync} from 'fs';
import {join, relative} from 'path';
import {walkFiles, DIST_EXCLUDE_PATTERNS} from './fs-utils';

const PKG = JSON.parse(readFileSync('package.json', 'utf8'));

function die(msg: string): never {
  console.error(`validate-update-manifest: ${msg}`);
  process.exit(1);
}

const manifestPath = process.argv[2];
if(!manifestPath) die('usage: validate-update-manifest.ts <path-to-manifest.json>');

const m = JSON.parse(readFileSync(manifestPath, 'utf8'));

for(const k of ['schemaVersion', 'version', 'gitSha', 'published', 'swUrl', 'bundleHashes', 'changelog']) {
  if(!(k in m)) die(`missing required field: ${k}`);
}

if(m.schemaVersion !== 1 && m.schemaVersion !== 2) {
  throw new Error(`Unsupported schemaVersion ${m.schemaVersion}`);
}
if(m.schemaVersion === 2) {
  if(typeof m.signingKeyFingerprint !== 'string' || !m.signingKeyFingerprint.startsWith('ed25519:')) {
    throw new Error('schemaVersion 2 requires signingKeyFingerprint starting with "ed25519:"');
  }
  if(typeof m.securityRelease !== 'boolean') {
    throw new Error('schemaVersion 2 requires boolean securityRelease');
  }
  if(typeof m.securityRollback !== 'boolean') {
    throw new Error('schemaVersion 2 requires boolean securityRollback');
  }
  if(m.rotation !== null && typeof m.rotation !== 'object') {
    throw new Error('rotation must be null or an object with {newPubkey, newFingerprint, crossCertSig}');
  }
}
if(m.version !== PKG.version) die(`version mismatch: manifest=${m.version} package.json=${PKG.version}`);
if(process.env.GITHUB_SHA && m.gitSha !== process.env.GITHUB_SHA) {
  die(`gitSha mismatch: manifest=${m.gitSha} GITHUB_SHA=${process.env.GITHUB_SHA}`);
}

if(!m.bundleHashes[m.swUrl]) die(`swUrl ${m.swUrl} not found in bundleHashes`);

const distDir = 'dist';
const files = walkFiles(distDir);
const covered = new Set(Object.keys(m.bundleHashes));

const missing: string[] = [];
for(const f of files) {
  if(DIST_EXCLUDE_PATTERNS.some(p => p.test(f))) continue;
  const rel = './' + relative(distDir, f).replace(/\\/g, '/');
  if(!covered.has(rel)) missing.push(rel);
}

if(missing.length > 0) {
  die(`files in dist/ not covered by bundleHashes:\n${missing.map(f => '  - ' + f).join('\n')}`);
}

// NOTE: Ship 1 only checks hash FORMAT. The validator does not re-hash files to
// verify stored hashes match content — this closes when Ship 2 lands and the
// manifest becomes a live security gate. If the emitter is trusted at CI time,
// format-only check catches typos and truncation; tampering detection requires
// a re-hash pass that should be added alongside the client-side consumption.
for(const [k, v] of Object.entries(m.bundleHashes as Record<string, string>)) {
  if(!/^sha256-[a-f0-9]{64}$/.test(v)) die(`invalid hash format for ${k}: ${v}`);
}

if(!m.changelog || m.changelog.trim().length === 0) {
  console.warn(`validate-update-manifest: WARNING changelog is empty for v${m.version}`);
}

console.log(`validate-update-manifest: OK (v${m.version}, ${Object.keys(m.bundleHashes).length} files covered)`);
