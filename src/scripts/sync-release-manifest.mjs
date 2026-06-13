#!/usr/bin/env node
/**
 * Keep `.release-please-manifest.json` in sync with `package.json`'s version.
 *
 * Why: release-please tracks the "last released" version via its manifest, not
 * from git tags or package.json. A manual `pnpm version patch` bumps package.json
 * + creates the tag, but leaves the manifest stale — release-please then keeps
 * proposing an already-released version (see PR #33 incident).
 *
 * Modes:
 *   --check   exit 1 if manifest.version !== package.json.version (used in preversion)
 *   (none)    write package.json.version into manifest (used in version hook)
 */
import {readFileSync, writeFileSync} from 'node:fs';

const PKG_PATH = 'package.json';
const MANIFEST_PATH = '.release-please-manifest.json';
const KEY = '.';
const CHECK_ONLY = process.argv.includes('--check');

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const pkgVersion = pkg.version;
const manifestVersion = manifest[KEY];

if(CHECK_ONLY) {
  if(pkgVersion !== manifestVersion) {
    console.error(
      `[sync-release-manifest] MISMATCH: package.json=${pkgVersion} but ` +
      `.release-please-manifest.json=${manifestVersion}.\n` +
      `Run: node src/scripts/sync-release-manifest.mjs  (then git add + commit)`
    );
    process.exit(1);
  }
  process.exit(0);
}

if(pkgVersion === manifestVersion) {
  process.exit(0);
}

manifest[KEY] = pkgVersion;
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
console.log(`[sync-release-manifest] ${manifestVersion} -> ${pkgVersion}`);
