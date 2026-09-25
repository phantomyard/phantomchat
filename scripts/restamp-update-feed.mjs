/*
 * Re-stamp an electron-updater feed against the artifacts actually on disk.
 *
 * WHY THIS EXISTS. The Windows installers are Authenticode signed after
 * electron-builder has already packaged them and written `latest.yml`.
 * Authenticode embeds the signature INSIDE the PE, so the signed installer
 * has a different sha512 and a different size than the feed describes.
 * electron-updater verifies the downloaded file against the feed's sha512 and
 * REFUSES to install on a mismatch — so an un-restamped feed does not degrade
 * gracefully, it breaks updates for every Windows user with a checksum error.
 *
 * Why not sign inside electron-builder's own `sign` hook instead (which would
 * keep the feed correct for free): that hook fires for every signable file in
 * the package — the app executable and the uninstaller as well as the
 * installer — and cloud signing is metered per signing operation. Signing the
 * published installer only is the deliberate trade; this script is what pays
 * for it.
 *
 * `blockMapSize` is DROPPED rather than recomputed. It describes a blockmap of
 * the pre-signing bytes, and the blockmap file is not published as a release
 * asset anyway, so differential download already falls back to a full
 * download. Keeping a stale number would be a claim about bytes that no
 * longer exist.
 *
 * Fails closed: a file named in the feed that is missing from the directory
 * aborts, rather than publishing a feed still advertising pre-signing hashes.
 *
 * Usage: node scripts/restamp-update-feed.mjs <feed.yml> [artifact-dir]
 */
import {createHash} from 'crypto';
import {readFileSync, writeFileSync} from 'fs';
import path from 'path';
import {load, dump} from 'js-yaml';

/**
 * electron-builder's hash format for update feeds: sha512, base64-encoded.
 * @param {Buffer} buf
 * @returns {string}
 */
export function sha512Base64(buf) {
  return createHash('sha512').update(buf).digest('base64');
}

/**
 * @param {string} raw feed YAML
 * @param {(url: string) => Buffer} readArtifact resolves a feed `url` to the
 *   bytes that will actually be published under that name. Injected so the
 *   whole function is testable without a filesystem.
 * @returns {string} feed YAML restamped against those bytes
 */
export function restampUpdateFeed(raw, readArtifact) {
  const doc = load(raw);
  if(!doc || typeof doc !== 'object') throw new Error('feed is not a YAML mapping');
  if(!Array.isArray(doc.files) || doc.files.length === 0) throw new Error('feed has no files[]');

  const files = doc.files.map((file) => {
    if(!file || typeof file.url !== 'string') throw new Error('malformed file entry in feed');
    const bytes = readArtifact(file.url);
    if(!bytes || bytes.length === 0) throw new Error(`artifact for ${file.url} is missing or empty`);
    const {blockMapSize, ...rest} = file;
    return {...rest, sha512: sha512Base64(bytes), size: bytes.length};
  });

  // The top-level path/sha512 are the legacy single-file fields old clients
  // read. merge-update-feed.mjs keeps them in step with files[0]; preserve
  // that invariant here rather than leaving them pointing at pre-signing
  // hashes, which is the same bug one level up.
  const out = {...doc, files, path: files[0].url, sha512: files[0].sha512};
  return dump(out, {lineWidth: -1, noRefs: true});
}

// CLI
if(process.argv[1] && process.argv[1].endsWith('restamp-update-feed.mjs')) {
  const [feedPath, dir = path.dirname(feedPath)] = process.argv.slice(2);
  if(!feedPath) {
    console.error('usage: restamp-update-feed.mjs <feed.yml> [artifact-dir]');
    process.exit(2);
  }
  const restamped = restampUpdateFeed(readFileSync(feedPath, 'utf8'), (url) => readFileSync(path.join(dir, url)));
  writeFileSync(feedPath, restamped, 'utf8');
  console.log(`restamped ${feedPath} against artifacts in ${dir}`);
  console.log(restamped);
}
