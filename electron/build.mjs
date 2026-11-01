/*
 * PhantomChat desktop — Electron build script.
 *
 * 1. Bundles electron/main.ts and electron/preload.ts to CJS in electron/dist/.
 * 2. Copies the Pi harness next to them.
 *
 * The frontend is not part of this build: the app loads it from the live PWA.
 */
import {build} from 'esbuild';
import {execSync} from 'child_process';
import {cpSync, mkdirSync, realpathSync, rmSync} from 'fs';
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

// --- Pi harness (issue #276) ------------------------------------------------
// Shipped as plain files in resources/pi (electron-builder extraResources): Node
// cannot run an ES module tree from inside app.asar.
// It has its own package and lockfile, so PWA builds never install it.
const harness = join(here, 'pi-harness');
execSync('pnpm install --frozen-lockfile --ignore-workspace --ignore-scripts --prod', {cwd: harness, stdio: 'inherit'});
const pi = realpathSync(join(harness, 'node_modules/@earendil-works/pi-coding-agent'));
const piOut = join(dist, 'pi');
rmSync(piOut, {recursive: true, force: true});
mkdirSync(piOut, {recursive: true});
cpSync(join(pi, 'package.json'), join(piOut, 'package.json'));
cpSync(join(pi, 'dist', 'bundle'), join(piOut, 'dist', 'bundle'), {recursive: true});
