import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

// Rows carry two review columns: `stable` against the repository pin and
// `published` against the DEPLOYED Stable, which a PWA promotion moves without
// minting a phantomchat-v tag. The deploy baseline rewrites stableRef to the
// deployed commit, so it must be compared against the column derived for it.
export function baselineDigestFor(config) {
  // A baseline without pinRef is the repository config itself: stableRef IS
  // the pin. registry.mjs sets pinRef when it substitutes the deployed SHA.
  const pin = config.pinRef ?? config.stableRef;
  // Anything else IS the deployed Stable, whether or not publishedStableRef
  // has caught up with it. A PWA promotion moves the deployed commit without
  // re-deriving that field, so refusing an unrecognised baseline here would
  // take the whole publish lane down on the next merge. Selecting the column
  // instead leaves the exact per-file digest check below to fail closed on
  // precisely the files that changed.
  return config.stableRef === pin ? 'stable' : 'published';
}
// Re-points a config at another Stable baseline while remembering the
// repository pin, so baselineDigestFor can tell the two apart. Every caller
// that swaps stableRef goes through here: a bare {...config, stableRef} makes
// the swapped ref look like the pin and selects the wrong column (#374, #377).
export function atBaseline(config, stableRef) {
  return {...config, pinRef: config.pinRef ?? config.stableRef, stableRef};
}
export function fileDigest(ref, file, cwd = process.cwd()) {
  try { return createHash('sha256').update(execFileSync('git', ['show', `${ref}:${file}`], {cwd, stdio: ['ignore', 'pipe', 'ignore']})).digest('hex'); }
  catch { return 'absent'; }
}
// The files whose exact bytes need a compatibility review between two refs.
export function gatedFiles(stableRef, candidate = 'HEAD', cwd = process.cwd()) {
  const files = execFileSync('git', ['diff', '--name-only', stableRef, candidate, '--', 'src', 'public', 'index.html', 'pnpm-lock.yaml', 'package.json', 'electron'], {cwd}).toString().trim().split('\n').filter(Boolean);
  return {files, gated: files.filter(file => {
    if(file.startsWith('src/tests/')) return false;
    // Only presentation assets are intrinsically storage-neutral. JS/TS,
    // HTML and JSON (including schemas and manifests) require explicit review.
    return !/\.(scss|css|svg|png|jpe?g|webp|woff2?|ttf|ico)$/.test(file);
  })};
}
export function checkCompatibility(config, candidate = 'HEAD', cwd = process.cwd(), baselineDigest = 'stable') {
  const {files, gated} = gatedFiles(config.stableRef, candidate, cwd);
  const blocked = gated.filter(file => {
    const digest = ref => fileDigest(ref, file, cwd);
    const approval = config.compatibilityApprovals[file];
    // `published` is the same review recorded against the DEPLOYED Stable when
    // that is a different commit from the repo pin. A row without it was only
    // ever reviewed at the pin, which is the same thing while the two agree.
    const approved = approval?.[baselineDigest] ?? approval?.stable;
    return !approval || approved !== digest(config.stableRef) || approval.preview !== digest(candidate);
  });
  if(blocked.length) {
    // A deployed baseline that has moved past the derived column is the one
    // failure an operator can only fix by hand, so name it in the error
    // rather than leaving a bare digest mismatch.
    const stale = baselineDigest === 'published' && config.publishedStableRef && config.publishedStableRef !== config.stableRef
      ? `\nThe published column was derived from ${config.publishedStableRef}; re-derive scripts/channels/config.json against ${config.stableRef}.`
      : '';
    throw new Error(`Shared-state compatibility review required (exact Stable/Preview hashes):\n${blocked.join('\n')}${stale}`);
  }
  return files;
}
if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(process.env.CHANNEL_BASELINE || 'scripts/channels/config.json', 'utf8'));
  checkCompatibility(config, process.argv[2] || 'HEAD', process.cwd(), baselineDigestFor(config));
}
