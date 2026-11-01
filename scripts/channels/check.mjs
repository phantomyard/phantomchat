import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

// Which files changed relative to the Stable baseline, and which of those have
// no exactly-matching approval for the Preview blob this tree ships.
//
// Only the Preview column is authoritative. It is the reviewed artefact: the
// exact blob that would be published. The Stable column records the blob the
// reviewer compared against, and it is bound to the baseline ref in force when
// the row was written. A published Stable advances on every promotion, so a
// recorded Stable digest legitimately falls behind the baseline; gating on it
// turns every promotion into a red main until all drifted rows are re-pinned
// by hand. Drift is therefore reported, not fatal, and the exact Preview hash
// remains the thing that must match.
export function checkCompatibility(config, candidate = 'HEAD', cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, {cwd});
  const files = git('diff', '--name-only', config.stableRef, candidate, '--', 'src', 'public', 'index.html', 'pnpm-lock.yaml', 'package.json', 'electron').toString().trim().split('\n').filter(Boolean);
  const digest = (ref, file) => {
    try { return createHash('sha256').update(git('show', `${ref}:${file}`)).digest('hex'); }
    catch { return 'absent'; }
  };
  const drifted = [];
  const blocked = files.filter(file => {
    if(file.startsWith('src/tests/')) return false;
    // Only presentation assets are intrinsically storage-neutral. JS/TS,
    // HTML and JSON (including schemas and manifests) require explicit review.
    if(/\.(scss|css|svg|png|jpe?g|webp|woff2?|ttf|ico)$/.test(file)) return false;
    const approval = config.compatibilityApprovals[file];
    if(!approval || approval.preview !== digest(candidate, file)) return true;
    if(approval.stable !== digest(config.stableRef, file)) drifted.push(file);
    return false;
  });
  if(drifted.length) {
    console.error(`Stable baseline ${config.stableRef} has moved past ${drifted.length} approved row(s):\n${drifted.join('\n')}\n` +
      'Their Preview hashes still match, so they stay approved; re-pin the Stable column when convenient.');
  }
  if(blocked.length) throw new Error(`Shared-state compatibility review required (exact Preview hash):\n${blocked.join('\n')}`);
  return files;
}
if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkCompatibility(JSON.parse(readFileSync(process.env.CHANNEL_BASELINE || 'scripts/channels/config.json', 'utf8')), process.argv[2] || 'HEAD');
}
