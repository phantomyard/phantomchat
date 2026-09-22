/*
 * PhantomChat desktop — Electron build script.
 *
 * 1. Bundles electron/main.ts and electron/preload.ts to CJS in electron/dist/.
 * 2. Computes a strict Content-Security-Policy for the packaged UI:
 *    the boot-splash <script> blocks in dist/index.html are hashed at build
 *    time so script-src can stay free of 'unsafe-inline'. The resulting
 *    header is written to electron/dist/csp.json and enforced by the main
 *    process on every app:// response.
 */
import {build} from 'esbuild';
import {mkdirSync, writeFileSync, readFileSync} from 'fs';
import {join, dirname} from 'path';
import {fileURLToPath} from 'url';
import {createHash} from 'crypto';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
mkdirSync(dist, {recursive: true});

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: false,
  minify: false,
  logLevel: 'info'
};

await build({
  ...common,
  entryPoints: [join(here, 'main.ts')],
  outfile: join(dist, 'main.cjs')
});

await build({
  ...common,
  entryPoints: [join(here, 'preload.ts')],
  outfile: join(dist, 'preload.cjs')
});

// --- CSP -------------------------------------------------------------------
// Defaults cover what the PWA bundle actually uses: blob workers, wss relays,
// https APIs, data/blob media and Telegram-web style inline styles. Inline
// *scripts* are pinned by hash instead of being allowed wholesale.
const indexHtml = readFileSync(join(here, '../dist/index.html'), 'utf8');
const inlineScripts = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .filter((body) => body.trim().length > 0);

if(inlineScripts.length === 0) {
  throw new Error('no inline scripts found in dist/index.html — CSP hashes would be stale or unnecessary; check the template');
}

const scriptHashes = inlineScripts.map((body) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`);

const csp = [
  "default-src 'self'",
  `script-src 'self' ${scriptHashes.join(' ')}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' wss: https: blob: data:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

writeFileSync(join(dist, 'csp.json'), JSON.stringify({header: csp}, null, 2) + '\n');
console.log(`CSP written with ${scriptHashes.length} inline-script hash(es).`);
