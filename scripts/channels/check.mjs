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
  if(config.stableRef === pin) return 'stable';
  if(config.stableRef === config.publishedStableRef) return 'published';
  throw new Error(`Deployed Stable ${config.stableRef} matches neither the repository pin ${pin} nor the derived published column ${config.publishedStableRef || '(absent)'}; re-derive scripts/channels/config.json`);
}
export function checkCompatibility(config, candidate = 'HEAD', cwd = process.cwd(), baselineDigest = 'stable') {
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
    // `published` is the same review recorded against the DEPLOYED Stable when
    // that is a different commit from the repo pin. A row without it was only
    // ever reviewed at the pin, which is the same thing while the two agree.
    const approved = approval?.[baselineDigest] ?? approval?.stable;
    return !approval || approved !== digest(config.stableRef) || approval.preview !== digest(candidate);
  });
  if(blocked.length) throw new Error(`Shared-state compatibility review required (exact Stable/Preview hashes):\n${blocked.join('\n')}`);
  return files;
}
if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(process.env.CHANNEL_BASELINE || 'scripts/channels/config.json', 'utf8'));
  checkCompatibility(config, process.argv[2] || 'HEAD', process.cwd(), baselineDigestFor(config));
}
