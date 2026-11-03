// PWA builds live in GitHub Packages (ghcr.io/<owner>/phantomchat-pwa), never on
// the Releases page: a published PWA release would poison Electron's
// releases.atom feed, and drafts cluttered the page. `live` tags the deployed
// site snapshot, `preview` the newest published Preview (see oci.mjs).
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {atBaseline, baselineDigestFor, checkCompatibility} from '../channels/check.mjs';
import {storeFromEnv} from './oci.mjs';

const gh = (...args) => execFileSync('gh', args, {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024}).trim();
const repo = () => process.env.GITHUB_REPOSITORY || 'phantomyard/phantomchat';
export function validPwaRecord(record) {
  return record?.schema === 1 && ['preview', 'stable'].includes(record.operation) &&
    /^[a-f0-9]{40}$/.test(record.source) && /^[a-f0-9]{40}$/.test(record.stableRef) &&
    /^\d+\.\d+\.\d+$/.test(record.version) && /^\d+\.\d+\.\d+$/.test(record.stableVersion) &&
    /^pwa-v\d+\.\d+\.\d+$/.test(record.previewRelease) &&
    typeof record.publishedAt === 'string' && Number.isFinite(Date.parse(record.publishedAt));
}
// The deploy workflow builds against the DEPLOYED Stable, but the review column
// that describes that content is `published`, not `stable`. Keeping the
// repository pin in `pinRef` is the only thing that lets the builder tell the
// two apart: without it `stableRef` looks like the pin, the builder reads the
// `stable` column, and every file differing from the pin blocks the lane.
export function deployBaseline(config, record) {
  return {...config, pinRef: config.stableRef, stableRef: record.stableRef, stableVersion: record.stableVersion};
}
// An explicit older promotion reviews selected -> current Preview. The column
// has to follow that base: `stable` only when it IS the pin, `published` when
// it is the deployed Stable, and fail closed on any other commit (#374).
export function checkPromotion(config, selectedSource, currentSource, cwd = process.cwd()) {
  const base = atBaseline(config, selectedSource);
  return checkCompatibility(base, currentSource, cwd, baselineDigestFor(base));
}
export function selectRelease(releases, kind, input = '') {
  const eligible = releases.filter(r => {
    if(kind === 'electron') return !r.draft && /^phantomchat-v\d+\.\d+\.\d+$/.test(r.tag_name);
    return r.draft && /^pwa-v\d+\.\d+\.\d+(?:-stable-\d+)?$/.test(r.tag_name) &&
      validPwaRecord(r.record) && (kind === 'site' || r.record.operation === 'preview');
  });
  if(input) {
    const found = eligible.find(r => r.tag_name === input);
    if(!found) throw new Error(`No successfully published ${kind} Preview release: ${input}`);
    if(kind === 'electron' && !found.prerelease) throw new Error(`${found.tag_name} is already Stable; refusing to select an older Preview`);
    return found;
  }
  const selected = eligible.sort((a, b) => {
    const date = r => kind === 'electron' ? r.published_at : r.record.publishedAt;
    return date(b).localeCompare(date(a)) || b.id - a.id;
  })[0];
  if(kind === 'electron' && selected && !selected.prerelease) throw new Error(`${selected.tag_name} is already Stable; refusing to select an older Preview`);
  return selected;
}
const PREVIEW_TAG = /^pwa-v\d+\.\d+\.\d+$/;
// The store keeps the newest KEEP build tags; `live` and `preview` are never pruned.
export const KEEP = 5;
async function published(store, tag, operation) {
  const build = await store.get(tag);
  if(!build) return null;
  if(!validPwaRecord(build.record)) throw new Error(`${tag} is not a successfully published PWA build`);
  if(operation && build.record.operation !== operation) throw new Error(`${tag} is not a PWA ${operation} build`);
  return build;
}
export async function selectBuild(store, kind, input = '') {
  if(kind === 'site') return published(store, 'live');
  if(input) {
    if(!PREVIEW_TAG.test(input)) throw new Error(`No successfully published pwa Preview release: ${input}`);
    const found = await published(store, input, 'preview');
    if(!found) throw new Error(`No successfully published pwa Preview release: ${input}`);
    return found;
  }
  return published(store, 'preview', 'preview');
}
// One-off migration from the legacy draft releases: the first run on the new
// store imports the deployed site snapshot (and the newest published Preview,
// so promotion has a candidate) under their original tags. Without this the
// first deploy would have no baseline and would rebuild Stable from source.
export async function importLegacy(store, all, directory) {
  const site = selectRelease(all, 'site');
  if(!site) throw new Error('PWA build store is empty and no legacy draft release exists to import');
  const preview = selectRelease(all, 'pwa');
  for(const [release, tags] of preview && preview.id !== site.id ?
    [[preview, ['preview']], [site, ['live']]] :
    [[site, site.record.operation === 'preview' ? ['live', 'preview'] : ['live']]]) {
    const dir = `${directory}/${release.tag_name}`;
    mkdirSync(dir, {recursive: true});
    gh('release', 'download', release.tag_name, '--repo', repo(), '--dir', dir);
    verifyArchive(dir);
    await store.push(release.tag_name, `${dir}/bundle.tar.gz`, release.record);
    const build = await store.get(release.tag_name);
    await store.putManifest(tags, build.layer, release.record);
    console.log(`Imported legacy ${release.tag_name} as ${tags.join(', ')}`);
  }
}
// ghcr answers 401/403 `denied`, not 404, for a package that does not exist
// yet, so on the first run absence has to be read from those statuses too. The
// import's own push then creates the package, and a real credential problem
// surfaces as that push's status. Anything else (5xx, network) still throws:
// re-importing over an existing `live` would roll the site back.
export const ABSENT_STORE = new Set([401, 403]);
export async function ensureStore(store, directory, list = releases) {
  let live;
  try {
    live = await store.get('live');
  } catch(err) {
    if(!ABSENT_STORE.has(err.status)) throw err;
    console.log(`PWA build store lookup returned HTTP ${err.status}; treating it as not created yet`);
  }
  if(live) return;
  await importLegacy(store, list(), directory);
}
// Best effort: a failed prune must never fail a deploy that already shipped.
export function pruneVersions(versions, keep = KEEP) {
  const build = v => (v.metadata?.container?.tags || []);
  const pinned = v => build(v).some(t => t === 'live' || t === 'preview');
  const tagged = versions.filter(v => build(v).length && !pinned(v))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
  // Untagged versions are manifests superseded when a build was published.
  return [...tagged.slice(keep), ...versions.filter(v => !build(v).length)];
}
function prune(store) {
  const [owner, name] = store.name.split('/');
  const path = `orgs/${owner}/packages/container/${encodeURIComponent(name)}/versions`;
  try {
    const versions = gh('api', '--paginate', `${path}?per_page=100`, '--jq', '.[] | @json')
      .split('\n').filter(Boolean).map(row => JSON.parse(row));
    for(const v of pruneVersions(versions)) gh('api', '-X', 'DELETE', `${path}/${v.id}`);
  } catch(error) {
    console.log(`::warning::PWA build prune skipped: ${error.message}`);
  }
}
function releases() {
  const rows = gh('api', '--paginate', `repos/${repo()}/releases?per_page=100`,
    '--jq', '.[] | {id,tag_name,draft,prerelease,published_at,body} | @json');
  return rows.split('\n').filter(Boolean).map(row => JSON.parse(row)).map(r => {
    try { r.record = JSON.parse(r.body); } catch { /* Desktop/historical release. */ }
    return r;
  });
}
export function digest(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
export function verifyArchive(directory) {
  const names = readdirSync(directory).sort();
  if(JSON.stringify(names) !== JSON.stringify(['SHA256SUMS.txt', 'bundle.tar.gz'])) throw new Error('Unexpected archive assets');
  const expected = readFileSync(`${directory}/SHA256SUMS.txt`, 'utf8');
  if(expected !== `${digest(`${directory}/bundle.tar.gz`)}  bundle.tar.gz\n`) throw new Error('Archive checksum mismatch');
  const entries = execFileSync('tar', ['-tzf', `${directory}/bundle.tar.gz`], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024}).trim().split('\n');
  if(entries.some(p => p.startsWith('/') || p.split('/').includes('..') || !/^(site|stable-candidate)(\/|$)/.test(p))) throw new Error('Unsafe archive path');
  // Only regular files/directories are permitted; never extract symlinks/devices.
  const types = execFileSync('tar', ['-tvzf', `${directory}/bundle.tar.gz`], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024}).trim().split('\n');
  if(types.some(p => !['-', 'd'].includes(p[0]))) throw new Error('Unsafe archive entry type');
}
async function download(store, build, directory) {
  mkdirSync(directory, {recursive: true});
  await store.download(build, directory);
  verifyArchive(directory);
  const out = `${directory}/unpacked`;
  mkdirSync(out);
  execFileSync('tar', ['-xzf', `${directory}/bundle.tar.gz`, '-C', out]);
  return out;
}
function output(key, value) {
  if(process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`, {flag: 'a'});
  console.log(`${key}=${value}`);
}
function replaceRoot(site, root) {
  // Preserve the currently published Preview when promoting a selected release.
  for(const name of readdirSync(site)) if(name !== 'preview') rmSync(`${site}/${name}`, {recursive: true, force: true});
  for(const name of readdirSync(root).filter(name => name !== 'preview')) cpSync(`${root}/${name}`, `${site}/${name}`, {recursive: true});
}
export async function main(command) {
  const workspace = resolve('.release-work');
  if(command === 'resolve-electron') {
    const selected = selectRelease(releases(), 'electron', process.env.RELEASE_INPUT || '');
    if(!selected) throw new Error('No published Electron Preview release');
    output('tag', selected.tag_name);
    return;
  }
  mkdirSync(workspace, {recursive: true});
  const store = storeFromEnv();
  if(command === 'baseline') {
    await ensureStore(store, `${workspace}/legacy`);
    const current = await selectBuild(store, 'site');
    if(!current) throw new Error('PWA build store has no live site snapshot');
    await download(store, current, `${workspace}/current`);
    writeFileSync(`${workspace}/current.json`, JSON.stringify(current.record));
    // Build/check against the actual deployed Stable, not an obsolete source pin.
    const config = JSON.parse(readFileSync('scripts/channels/config.json'));
    writeFileSync(`${workspace}/baseline.json`, JSON.stringify(deployBaseline(config, current.record)));
    output('baseline', `${workspace}/baseline.json`);
    return;
  }
  if(command === 'prepare-preview' || command === 'prepare-stable') {
    const version = `1.0.${process.env.GITHUB_RUN_NUMBER}`;
    let tag = `pwa-v${version}`;
    let record;
    mkdirSync(`${workspace}/payload`, {recursive: true});
    if(command === 'prepare-preview') {
      if(!existsSync(`${workspace}/current.json`)) throw new Error('Run `baseline` first: no deployed site snapshot');
      cpSync('dist', `${workspace}/payload/site`, {recursive: true});
      cpSync('dist-stable-candidate', `${workspace}/payload/stable-candidate`, {recursive: true});
      const current = JSON.parse(readFileSync(`${workspace}/current.json`));
      record = {schema: 1, operation: 'preview', source: process.env.GITHUB_SHA, version,
        stableRef: current.stableRef, stableVersion: current.stableVersion, previewRelease: tag};
      replaceRoot(`${workspace}/payload/site`, `${workspace}/current/unpacked/site`);
    } else {
      await ensureStore(store, `${workspace}/legacy`);
      const selected = await selectBuild(store, 'pwa', process.env.RELEASE_INPUT || '');
      const current = await selectBuild(store, 'site');
      if(!selected || !current) throw new Error('No published PWA Preview release');
      const source = await download(store, selected, `${workspace}/selected`);
      const live = await download(store, current, `${workspace}/live`);
      // An explicit older release must be compatible with the CURRENT Preview,
      // not just the Preview that existed when that release was built.
      if(current.record.source !== selected.record.source) {
        checkPromotion(JSON.parse(readFileSync('scripts/channels/config.json')), selected.record.source, current.record.source);
      }
      cpSync(`${live}/site`, `${workspace}/payload/site`, {recursive: true});
      cpSync(`${source}/stable-candidate`, `${workspace}/payload/stable-candidate`, {recursive: true});
      replaceRoot(`${workspace}/payload/site`, `${source}/stable-candidate`);
      tag = `pwa-v${selected.record.version}-stable-${process.env.GITHUB_RUN_ID}`;
      output('stable_ref', selected.record.source);
      output('stable_version', selected.record.version);
      record = {...current.record, operation: 'stable', stableRef: selected.record.source, stableVersion: selected.record.version};
      delete record.publishedAt;
    }
    const channels = {stable: record.stableRef, preview: record.source};
    writeFileSync(`${workspace}/payload/site/channels.json`, JSON.stringify(channels) + '\n');
    // The full site snapshot and prebuilt Stable variant are one immutable layer.
    execFileSync('tar', ['-czf', `${workspace}/bundle.tar.gz`, '-C', `${workspace}/payload`, 'site', 'stable-candidate']);
    writeFileSync(`${workspace}/record.json`, JSON.stringify(record));
    if(await store.get(tag)) throw new Error(`PWA build ${tag} already exists`);
    await store.push(tag, `${workspace}/bundle.tar.gz`, record);
    output('tag', tag);
    return;
  }
  if(command === 'published') {
    const tag = process.env.RELEASE_TAG;
    const build = await store.get(tag);
    if(!build || build.record?.schema !== 1 || build.record.publishedAt) throw new Error('Missing/unexpected unpublished PWA archive');
    const record = {...build.record, publishedAt: new Date().toISOString()};
    // The build tag first: if moving `live` fails, the record is still accurate.
    await store.putManifest([tag, 'live', ...(record.operation === 'preview' ? ['preview'] : [])], build.layer, record);
    prune(store);
    return;
  }
  throw new Error(`Unknown command ${command}`);
}
if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv[2]);
