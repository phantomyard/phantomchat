import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export function checkCompatibility(config, candidate = 'HEAD', cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, {cwd});
  const files = git('diff', '--name-only', config.stableRef, candidate, '--', 'src', 'public', 'index.html', 'pnpm-lock.yaml', 'package.json', 'electron').toString().trim().split('\n').filter(Boolean);
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
if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkCompatibility(JSON.parse(readFileSync('scripts/channels/config.json', 'utf8')), process.argv[2] || 'HEAD');
}
