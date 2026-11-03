// PWA archives remain DRAFT releases: publishing them would poison Electron's
// releases.atom feed. Pages publication and the archive's audit record are separate.
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {atBaseline, baselineDigestFor, checkCompatibility} from '../channels/check.mjs';

const gh = (...args) => execFileSync('gh', args, {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024}).trim();
const repo = () => process.env.GITHUB_REPOSITORY || 'phantomyard/phantomchat';
function validPwaRecord(record) {
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
// The record rides inside an HTML comment so the Releases page shows a
// readable summary instead of raw JSON. `>` is escaped so the payload can
// never close the comment early. Bodies that are bare JSON (drafts made before
// this format) still parse, so no existing archive becomes unselectable.
const RECORD_MARK = '<!-- pwa-record ';
export function parseRecord(body) {
  if(typeof body !== 'string') return undefined;
  const start = body.indexOf(RECORD_MARK);
  const text = start === -1 ? body : body.slice(start + RECORD_MARK.length, body.indexOf(' -->', start));
  try { return JSON.parse(text); } catch { return undefined; }
}
export function releaseTitle(record) {
  return record.operation === 'stable'
    ? `PWA Stable ${record.stableVersion} (promoted)`
    : `PWA Preview ${record.version}`;
}
export function renderRecord(record, repository = repo()) {
  const commit = sha => `[\`${sha.slice(0, 7)}\`](https://github.com/${repository}/commit/${sha})`;
  const stable = record.operation === 'stable';
  const rows = stable
    ? [['Promoted to Stable', `${record.stableVersion} (${commit(record.stableRef)})`],
      ['Preview at the time', `${record.version} (${commit(record.source)})`]]
    : [['Built from', `${record.version} (${commit(record.source)})`],
      ['Stable at the time', `${record.stableVersion} (${commit(record.stableRef)})`]];
  rows.push(['Live since', record.publishedAt ? record.publishedAt.replace('T', ' ').replace(/\.\d+Z$|Z$/, ' UTC') : 'not published yet']);
  return [
    `PhantomChat web app (chat.phantomyard.ai), ${stable ? 'Stable promotion' : 'Preview build'}.`,
    '',
    '| | |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    '',
    'Internal archive: the deploy and promote workflows read this draft. Keep it a draft; do not publish or delete it.',
    '',
    `${RECORD_MARK}${JSON.stringify(record).replace(/>/g, '\\u003e')} -->`,
    '',
  ].join('\n');
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
function releases() {
  const rows = gh('api', '--paginate', `repos/${repo()}/releases?per_page=100`,
    '--jq', '.[] | {id,tag_name,draft,prerelease,published_at,body} | @json');
  return rows.split('\n').filter(Boolean).map(row => JSON.parse(row)).map(r => {
    const record = parseRecord(r.body);
    if(record !== undefined) r.record = record; // else Desktop/historical release.
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
function download(release, directory) {
  mkdirSync(directory, {recursive: true});
  gh('release', 'download', release.tag_name, '--repo', repo(), '--dir', directory);
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
  const all = releases();
  if(command === 'resolve-electron') {
    const selected = selectRelease(all, 'electron', process.env.RELEASE_INPUT || '');
    if(!selected) throw new Error('No published Electron Preview release');
    output('tag', selected.tag_name);
    return;
  }
  mkdirSync(workspace, {recursive: true});
  if(command === 'baseline') {
    const current = selectRelease(all, 'site');
    if(current) {
      download(current, `${workspace}/current`);
      writeFileSync(`${workspace}/current.json`, JSON.stringify(current.record));
      // Build/check against the actual deployed Stable, not an obsolete source pin.
      const config = JSON.parse(readFileSync('scripts/channels/config.json'));
      writeFileSync(`${workspace}/baseline.json`, JSON.stringify(deployBaseline(config, current.record)));
      output('baseline', `${workspace}/baseline.json`);
    }
    return;
  }
  if(command === 'prepare-preview' || command === 'prepare-stable') {
    const version = `1.0.${process.env.GITHUB_RUN_NUMBER}`;
    let tag = `pwa-v${version}`;
    let record;
    mkdirSync(`${workspace}/payload`, {recursive: true});
    if(command === 'prepare-preview') {
      cpSync('dist', `${workspace}/payload/site`, {recursive: true});
      cpSync('dist-stable-candidate', `${workspace}/payload/stable-candidate`, {recursive: true});
      const config = JSON.parse(readFileSync(process.env.CHANNEL_BASELINE || 'scripts/channels/config.json'));
      record = {schema: 1, operation: 'preview', source: process.env.GITHUB_SHA, version,
        stableRef: config.stableRef, stableVersion: config.stableVersion, previewRelease: tag};
      if(existsSync(`${workspace}/current.json`)) {
        const current = JSON.parse(readFileSync(`${workspace}/current.json`));
        replaceRoot(`${workspace}/payload/site`, `${workspace}/current/unpacked/site`);
        record.stableRef = current.stableRef;
        record.stableVersion = current.stableVersion;
      }
    } else {
      const selected = selectRelease(all, 'pwa', process.env.RELEASE_INPUT || '');
      const current = selectRelease(all, 'site');
      if(!selected || !current) throw new Error('No published PWA Preview release');
      const source = download(selected, `${workspace}/selected`);
      const live = download(current, `${workspace}/live`);
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
    // The full site snapshot and prebuilt Stable variant are immutable assets.
    execFileSync('tar', ['-czf', `${workspace}/bundle.tar.gz`, '-C', `${workspace}/payload`, 'site', 'stable-candidate']);
    writeFileSync(`${workspace}/SHA256SUMS.txt`, `${digest(`${workspace}/bundle.tar.gz`)}  bundle.tar.gz\n`);
    writeFileSync(`${workspace}/record.json`, JSON.stringify(record));
    writeFileSync(`${workspace}/notes.md`, renderRecord(record));
    gh('release', 'create', tag, '--repo', repo(), '--draft', '--target', process.env.GITHUB_SHA,
      '--title', releaseTitle(record), '--notes-file', `${workspace}/notes.md`,
      `${workspace}/bundle.tar.gz`, `${workspace}/SHA256SUMS.txt`);
    output('tag', tag);
    return;
  }
  if(command === 'published') {
    const tag = process.env.RELEASE_TAG;
    const release = all.find(r => r.tag_name === tag && r.draft && r.record?.schema === 1);
    if(!release || release.record.publishedAt) throw new Error('Missing/unexpected unpublished PWA archive');
    release.record.publishedAt = new Date().toISOString();
    writeFileSync(`${workspace}/published.md`, renderRecord(release.record));
    gh('release', 'edit', tag, '--repo', repo(), '--notes-file', `${workspace}/published.md`);
    return;
  }
  if(command === 'restyle') {
    // One-off: rewrite existing drafts into the readable format. The record
    // itself is carried over unchanged and re-parsed before each write.
    const apply = process.env.RESTYLE_APPLY === '1';
    for(const r of all.filter(r => r.draft && /^pwa-v/.test(r.tag_name) && r.record?.schema === 1)) {
      const body = renderRecord(r.record);
      if(JSON.stringify(parseRecord(body)) !== JSON.stringify(r.record)) throw new Error(`Round-trip mismatch for ${r.tag_name}`);
      if(body === r.body) continue;
      console.log(`${apply ? 'restyle' : 'would restyle'} ${r.tag_name} -> ${releaseTitle(r.record)}`);
      if(!apply) continue;
      writeFileSync(`${workspace}/restyle.md`, body);
      gh('release', 'edit', r.tag_name, '--repo', repo(), '--title', releaseTitle(r.record), '--notes-file', `${workspace}/restyle.md`);
    }
    return;
  }
  throw new Error(`Unknown command ${command}`);
}
if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv[2]);
