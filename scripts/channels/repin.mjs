// Re-derives the `published` review column after a PWA Stable promotion (#301).
//
// A promotion moves the deployed Stable to a commit nobody derived approvals
// for, so until the table is re-pinned every PR (and main's own deploy) fails
// the deployed-baseline gate on files it never touched. pwa-promote.yml runs
// this as its last step and opens the result as a PR: main is protected, so a
// human reviews and merges it like any other change.
//
// What it rewrites, and what it refuses to:
//  - `published` on EVERY row is recomputed from the deployed commit, not just
//    the rows a failing run named (the last two hand re-pins both missed rows).
//  - `publishedStableRef` becomes the deployed commit.
//  - `stable` (the repository pin) and `preview` (the reviewed candidate bytes)
//    are never touched. A promotion only moves already-reviewed Preview bytes
//    into Stable; it is no reason to approve new candidate content. A gated
//    file with no row, or whose candidate bytes no row approves, stops the
//    re-pin and is named, because that needs a review rather than a stamp.
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {atBaseline, baselineDigestFor, checkCompatibility, fileDigest, gatedFiles} from './check.mjs';
import {fetchPublishedChannels} from './check-published.mjs';

export function repin(config, deployed, candidate = 'HEAD', cwd = process.cwd()) {
  if(!/^[a-f0-9]{40}$/.test(deployed)) throw new Error(`Deployed Stable must be a full commit SHA: ${deployed}`);
  const approvals = config.compatibilityApprovals;
  const {gated} = gatedFiles(deployed, candidate, cwd);
  const missing = gated.filter(file => !approvals[file]);
  const unreviewed = gated.filter(file => approvals[file] && approvals[file].preview !== fileDigest(candidate, file, cwd));
  if(missing.length || unreviewed.length) {
    throw new Error([
      'Re-pin refused: these files need a compatibility review, not a re-stamp.',
      ...missing.map(file => `no approval row: ${file}`),
      ...unreviewed.map(file => `candidate bytes not approved: ${file}`)
    ].join('\n'));
  }
  const next = {...config, publishedStableRef: deployed, compatibilityApprovals: {}};
  for(const [file, row] of Object.entries(approvals)) {
    next.compatibilityApprovals[file] = {...row, published: fileDigest(deployed, file, cwd)};
  }
  // Prove the result passes the same gate CI and the deploy run use.
  const baseline = atBaseline(next, deployed);
  checkCompatibility(baseline, candidate, cwd, baselineDigestFor(baseline));
  return next;
}

// Pages can serve the previous channels.json for a short while after deploy.
export async function waitForDeployed(expected, fetcher = fetch, attempts = 20, delayMs = 15000) {
  let seen;
  for(let i = 0; i < attempts; i++) {
    seen = (await fetchPublishedChannels(fetcher)).stable;
    if(!expected || seen === expected) return seen;
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error(`Deployed Stable is ${seen}, expected ${expected}; not re-pinning against the wrong commit`);
}

if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = 'scripts/channels/config.json';
  const text = readFileSync(path, 'utf8');
  // The deployed SHA comes from the same authenticated source check-published
  // reads; EXPECTED_STABLE only makes the run wait for Pages to serve it.
  const deployed = await waitForDeployed(process.env.EXPECTED_STABLE || '');
  const next = JSON.stringify(repin(JSON.parse(text), deployed), null, 2) + '\n';
  if(next === text) console.log(`Approvals already describe deployed Stable ${deployed}`);
  else writeFileSync(path, next);
  console.log(`deployed=${deployed}`);
}
