// PWA archives remain DRAFT releases: publishing them would poison Electron's
// releases.atom feed. Pages publication and the archive's audit record are separate.
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkCompatibility} from '../channels/check.mjs';

const gh = (...args) => execFileSync('gh', args, {encoding: 'utf8'}).trim();
const repo = () => process.env.GITHUB_REPOSITORY || 'phantomyard/phantomchat';
function validPwaRecord(record) {
  return record?.schema === 1 && ['preview', 'stable'].includes(record.operation) &&
    /^[a-f0-9]{40}$/.test(record.source) && /^[a-f0-9]{40}$/.test(record.stableRef) &&
    /^\d+\.\d+\.\d+$/.test(record.version) && /^\d+\.\d+\.\d+$/.test(record.stableVersion) &&
    /^pwa-v\d+\.\d+\.\d+$/.test(record.previewRelease) &&
    typeof record.publishedAt === 'string' && Number.isFinite(Date.parse(record.publishedAt));
}
export function selectRelease(releases, kind, input = '') {
  const eligible = releases.filter(r => {
    if(kind === 'electron') return !r.draft && r.prerelease && /^phantomchat-v\d+\.\d+\.\d+$/.test(r.tag_name);
    return r.draft && /^pwa-v\d+\.\d+\.\d+(?:-stable-\d+)?$/.test(r.tag_name) &&
      validPwaRecord(r.record) && (kind === 'site' || r.record.operation === 'preview');
  });
  if(input) {
    const found = eligible.find(r => r.tag_name === input);
    if(!found) throw new Error(`No successfully published ${kind} Preview release: ${input}`);
    return found;
  }
  return eligible.sort((a, b) => {
    const date = r => kind === 'electron' ? r.published_at : r.record.publishedAt;
    return date(b).localeCompare(date(a)) || b.id - a.id;
  })[0];
}
function releases() {
  const pages = JSON.parse(gh('api', '--paginate', '--slurp', `repos/${repo()}/releases?per_page=100`));
  return pages.flat().map(r => {
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
  const entries = execFileSync('tar', ['-tzf', `${directory}/bundle.tar.gz`], {encoding: 'utf8'}).trim().split('\n');
  if(entries.some(p => p.startsWith('/') || p.split('/').includes('..') || !/^(site|stable-candidate)(\/|$)/.test(p))) throw new Error('Unsafe archive path');
  // Only regular files/directories are permitted; never extract symlinks/devices.
  const types = execFileSync('tar', ['-tvzf', `${directory}/bundle.tar.gz`], {encoding: 'utf8'}).trim().split('\n');
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
      config.stableRef = current.record.stableRef;
      config.stableVersion = current.record.stableVersion;
      writeFileSync(`${workspace}/baseline.json`, JSON.stringify(config));
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
        const approvals = JSON.parse(readFileSync('scripts/channels/config.json'));
        checkCompatibility({...approvals, stableRef: selected.record.source}, current.record.source);
      }
      cpSync(`${live}/site`, `${workspace}/payload/site`, {recursive: true});
      cpSync(`${source}/stable-candidate`, `${workspace}/payload/stable-candidate`, {recursive: true});
      replaceRoot(`${workspace}/payload/site`, `${source}/stable-candidate`);
      tag = `pwa-v${selected.record.version}-stable-${process.env.GITHUB_RUN_ID}`;
      record = {...current.record, operation: 'stable', stableRef: selected.record.source, stableVersion: selected.record.version};
      delete record.publishedAt;
    }
    const channels = {stable: record.stableRef, preview: record.source};
    writeFileSync(`${workspace}/payload/site/channels.json`, JSON.stringify(channels) + '\n');
    // The full site snapshot and prebuilt Stable variant are immutable assets.
    execFileSync('tar', ['-czf', `${workspace}/bundle.tar.gz`, '-C', `${workspace}/payload`, 'site', 'stable-candidate']);
    writeFileSync(`${workspace}/SHA256SUMS.txt`, `${digest(`${workspace}/bundle.tar.gz`)}  bundle.tar.gz\n`);
    writeFileSync(`${workspace}/record.json`, JSON.stringify(record));
    gh('release', 'create', tag, '--repo', repo(), '--draft', '--target', process.env.GITHUB_SHA,
      '--title', `PWA ${record.operation}: ${record.version}`, '--notes-file', `${workspace}/record.json`,
      `${workspace}/bundle.tar.gz`, `${workspace}/SHA256SUMS.txt`);
    output('tag', tag);
    return;
  }
  if(command === 'published') {
    const tag = process.env.RELEASE_TAG;
    const release = all.find(r => r.tag_name === tag && r.draft && r.record?.schema === 1);
    if(!release || release.record.publishedAt) throw new Error('Missing/unexpected unpublished PWA archive');
    release.record.publishedAt = new Date().toISOString();
    writeFileSync(`${workspace}/published.json`, JSON.stringify(release.record));
    gh('release', 'edit', tag, '--repo', repo(), '--notes-file', `${workspace}/published.json`);
    return;
  }
  throw new Error(`Unknown command ${command}`);
}
if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv[2]);
