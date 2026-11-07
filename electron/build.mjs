/*
 * PhantomChat desktop — Electron build script.
 *
 * 1. Bundles electron/main.ts and electron/preload.ts to CJS in electron/dist/.
 * 2. Compiles the phantombot engine host into electron/dist/phantombot/.
 *
 * The frontend is not part of this build: the app loads it from the live PWA.
 */
import {build} from 'esbuild';
import {mkdirSync} from 'fs';
import {buildHost} from './phantombot/build-host.mjs';
import {join, dirname} from 'path';
import {fileURLToPath} from 'url';

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

// --- phantombot engine host ------------------------------------------------
// One compiled Bun binary (engine + embedded Pi), shipped as a plain file in
// resources/phantombot (electron-builder extraResources): it is executed, so it
// cannot live inside app.asar. See electron/phantombot/build-host.mjs.
// PHANTOMBOT_HOST=skip builds main/preload only (typecheck-style local builds).
// Pin resolution is async: pin.json names a channel and the release is read
// at build time.
if(process.env.PHANTOMBOT_HOST !== 'skip') console.log(await buildHost());
