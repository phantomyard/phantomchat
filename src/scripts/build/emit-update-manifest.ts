#!/usr/bin/env tsx
/**
 * Emits dist/update-manifest.json for Phase A controlled updates.
 * Input: dist/ directory (post-build), CHANGELOG.md, package.json
 * Output: dist/update-manifest.json
 */

import {readFileSync, writeFileSync} from 'fs';
import {createHash} from 'crypto';
import {join, relative} from 'path';
import {execSync} from 'child_process';
import {walkFiles, DIST_EXCLUDE_PATTERNS} from './fs-utils';
import {TRUSTED_PUBKEY_FINGERPRINT} from '../../lib/update/signing/trusted-pubkey.generated';

const DIST_DIR = 'dist';
const PKG = JSON.parse(readFileSync('package.json', 'utf8'));
const VERSION: string = PKG.version;
const GIT_SHA: string = process.env.GITHUB_SHA || execSync('git rev-parse HEAD').toString().trim();

function sha256File(path: string): string {
  const h = createHash('sha256');
  // Buffer is runtime-compatible with Uint8Array but TS typings disagree without @types/node.
  h.update(readFileSync(path) as unknown as Uint8Array);
  return 'sha256-' + h.digest('hex');
}

function extractChangelog(version: string): string {
  const raw = readFileSync('CHANGELOG.md', 'utf8');
  const regex = new RegExp(`##\\s*\\[${version.replace(/\./g, '\\.')}\\][\\s\\S]*?(?=\\n##\\s*\\[|$)`);
  const match = raw.match(regex);
  if(!match) return '';
  return match[0].replace(/^##\s*\[[^\]]+\][^\n]*\n+/, '').trim();
}

function resolveSwUrl(distDir: string): string {
  // Vite may emit multiple `sw-*.js` files (the registered SW plus worker-internal
  // chunks that happen to share the naming). The production SW is the one actually
  // registered by the app's main entry chunk, which is referenced from index.html.
  const indexHtml = readFileSync(join(distDir, 'index.html'), 'utf8');
  const mainChunkMatch = indexHtml.match(/index-[a-zA-Z0-9_-]+\.js/);
  if(!mainChunkMatch) {
    throw new Error('Could not locate main entry chunk in dist/index.html');
  }
  const mainChunk = readFileSync(join(distDir, mainChunkMatch[0]), 'utf8');
  const swMatch = mainChunk.match(/sw-[a-zA-Z0-9_-]+\.js/);
  if(!swMatch) {
    throw new Error(`Main chunk ${mainChunkMatch[0]} does not reference any sw-*.js`);
  }
  return './' + swMatch[0];
}

function main() {
  const files = walkFiles(DIST_DIR);
  const bundleHashes: Record<string, string> = {};

  for(const f of files) {
    if(DIST_EXCLUDE_PATTERNS.some(p => p.test(f))) continue;
    const rel = './' + relative(DIST_DIR, f).replace(/\\/g, '/');
    bundleHashes[rel] = sha256File(f);
  }

  const swUrl = resolveSwUrl(DIST_DIR);
  if(!bundleHashes[swUrl]) {
    throw new Error(`Resolved swUrl ${swUrl} not present in bundleHashes`);
  }

  const manifest = {
    schemaVersion: 2,
    version: VERSION,
    gitSha: GIT_SHA,
    published: new Date().toISOString(),
    swUrl,
    signingKeyFingerprint: TRUSTED_PUBKEY_FINGERPRINT,
    securityRelease: process.env.SECURITY_RELEASE === 'true',
    securityRollback: process.env.SECURITY_ROLLBACK === 'true',
    bundleHashes,
    changelog: extractChangelog(VERSION),
    alternateSources: {},
    rotation: null as null | {newPubkey: string; newFingerprint: string; crossCertSig: string}
  };

  const outPath = join(DIST_DIR, 'update-manifest.json');
  writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log(`Emitted ${outPath} for v${VERSION} (${Object.keys(bundleHashes).length} files, swUrl=${swUrl})`);
}

main();
