#!/usr/bin/env node
/**
 * Fetch a fresh Tor microdesc consensus + microdescriptors from
 * collector.torproject.org, strip the CollecTor @type annotations, brotli-
 * compress, and write to public/webtor/.
 *
 * webtor-rs has a hardcoded reference to a stale cache on
 * privacy-ethereum.github.io. The fetch shim in webtor-fallback.ts redirects
 * those URLs to the local copies produced by this script.
 *
 * Run manually: node scripts/update-tor-consensus.mjs
 * Run pre-build: see package.json prebuild hook (TODO).
 */
import {brotliCompressSync, constants} from 'node:zlib';
import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public', 'webtor');

const COLLECTOR = 'https://collector.torproject.org';
const CONS_DIR = '/recent/relay-descriptors/microdescs/consensus-microdesc/';
const MICRO_DIR = '/recent/relay-descriptors/microdescs/micro/';

async function fetchText(url) {
  const r = await fetch(url);
  if(!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`);
  return r.text();
}

async function listLatest(dirUrl, prefix) {
  const html = await fetchText(dirUrl);
  const matches = [...html.matchAll(/href="([0-9][^"]+)"/g)].map(m => m[1]);
  if(matches.length === 0) throw new Error(`no files matched in ${dirUrl}`);
  matches.sort();
  return matches[matches.length - 1];
}

function stripTypeAnnotations(text) {
  return text.split('\n').filter(line => !line.startsWith('@type ')).join('\n');
}

function compressBr(text) {
  // arti's brotli decoder rejects streams that use the large-window extension.
  // Force the standard 22-bit max window so the output stays in baseline brotli.
  return brotliCompressSync(Buffer.from(text, 'utf8'), {
    params: {
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      [constants.BROTLI_PARAM_QUALITY]: 9,
      [constants.BROTLI_PARAM_LGWIN]: 22
    }
  });
}

async function main() {
  console.log('Fetching latest consensus-microdesc directory listing...');
  const consName = await listLatest(COLLECTOR + CONS_DIR);
  console.log('  → latest:', consName);
  const consText = await fetchText(COLLECTOR + CONS_DIR + consName);
  const consClean = stripTypeAnnotations(consText);
  console.log('  consensus size:', consClean.length, 'bytes (uncompressed)');

  console.log('Fetching latest micro directory listing...');
  const microName = await listLatest(COLLECTOR + MICRO_DIR);
  console.log('  → latest:', microName);
  const microText = await fetchText(COLLECTOR + MICRO_DIR + microName);
  const microClean = stripTypeAnnotations(microText);
  console.log('  microdescriptors size:', microClean.length, 'bytes (uncompressed)');

  mkdirSync(OUT_DIR, {recursive: true});

  // NOTE: filenames intentionally do NOT end in .br — Vite (and many static
  // hosts) auto-set Content-Encoding: br for .br files, which makes the
  // browser pre-decompress the body before the WASM sees it. The WASM then
  // tries to brotli-decode plaintext and fails with "Invalid Data". Using a
  // .bin extension keeps the bytes opaque end-to-end.
  const consBr = compressBr(consClean);
  writeFileSync(resolve(OUT_DIR, 'consensus.br.bin'), consBr);
  console.log(`Wrote consensus.br.bin: ${consBr.length} bytes`);

  const microBr = compressBr(microClean);
  writeFileSync(resolve(OUT_DIR, 'microdescriptors.br.bin'), microBr);
  console.log(`Wrote microdescriptors.br.bin: ${microBr.length} bytes`);

  // Extract valid-after / valid-until for sanity check
  const validAfter = consClean.match(/^valid-after (.+)$/m)?.[1];
  const validUntil = consClean.match(/^valid-until (.+)$/m)?.[1];
  console.log(`\nConsensus validity: ${validAfter} → ${validUntil}`);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
