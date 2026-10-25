import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

export function checkCompatibility(config, candidate = 'HEAD') {
  const git = (...args) => execFileSync('git', args);
  const files = git('diff', '--name-only', config.stableRef, candidate, '--', 'src', 'public', 'index.html').toString().trim().split('\n').filter(Boolean);
  const blocked = files.filter(file => {
    if(file.startsWith('src/tests/')) return false;
    // Only presentation assets are intrinsically storage-neutral. JS/TS,
    // HTML and JSON (including schemas and manifests) require explicit review.
    if(/\.(scss|css|svg|png|jpe?g|webp|woff2?|ttf|ico)$/.test(file)) return false;
    const digest = ref => {
      try { return createHash('sha256').update(git('show', `${ref}:${file}`)).digest('hex'); }
      catch { return 'absent'; }
    };
    const approval = config.compatibilityApprovals[file];
    return !approval || approval.stable !== digest(config.stableRef) || approval.preview !== digest(candidate);
  });
  if(blocked.length) throw new Error(`Shared-state compatibility review required (exact Stable/Preview hashes):\n${blocked.join('\n')}`);
  return files;
}
if(process.argv[1]?.endsWith('/check.mjs')) {
  checkCompatibility(JSON.parse(readFileSync('scripts/channels/config.json', 'utf8')), process.argv[2] || 'HEAD');
}
