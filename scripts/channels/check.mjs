import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

// Rows carry `stable` (the repository pin's bytes) and `preview` (the reviewed
// candidate bytes). Against the pin both must match exactly. Against the
// DEPLOYED Stable, which a PWA promotion moves without minting a phantomchat-v
// tag, the baseline bytes are whatever was promoted, so only the candidate
// side is checked: every file that differs from the deployed Stable needs a
// row approving its exact candidate bytes. That is computed live, so a
// promotion needs no config change and no re-pin PR (#301).
export function baselineDigestFor(config) {
  // A baseline without pinRef is the repository config itself: stableRef IS
  // the pin. registry.mjs sets pinRef when it substitutes the deployed SHA.
  const pin = config.pinRef ?? config.stableRef;
  return config.stableRef === pin ? 'stable' : 'deployed';
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
    if(!approval || approval.preview !== digest(candidate)) return true;
    return baselineDigest === 'stable' && approval.stable !== digest(config.stableRef);
  });
  if(blocked.length) {
    throw new Error(`Shared-state compatibility review required (exact Stable/Preview hashes):\n${blocked.join('\n')}`);
  }
  return files;
}
if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(process.env.CHANNEL_BASELINE || 'scripts/channels/config.json', 'utf8'));
  checkCompatibility(config, process.argv[2] || 'HEAD', process.cwd(), baselineDigestFor(config));
}
