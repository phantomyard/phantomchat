import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {selectRelease, digest, verifyArchive} from './registry.mjs';

const pwa = (id, operation = 'preview') => ({id, draft: true, tag_name: `pwa-v1.0.${id}`,
  record: {schema: 1, source: 'a'.repeat(40), stableRef: 'b'.repeat(40), version: `1.0.${id}`, stableVersion: '1.0.1', previewRelease: `pwa-v1.0.${id}`, publishedAt: `2026-10-${id}T12:00:00Z`, operation}});
test('default selection isolates products, excludes drafts/unpublished candidates, and orders by publication', () => {
  const releases = [pwa(21), pwa(22, 'stable'), {...pwa(23), record: {schema: 1}},
    {id: 24, draft: false, prerelease: true, tag_name: 'phantomchat-v1.0.24', published_at: '2026-10-24T12:00:00Z'},
    {id: 25, draft: true, prerelease: true, tag_name: 'phantomchat-v1.0.25'}];
  assert.equal(selectRelease(releases, 'pwa').id, 21);
  assert.equal(selectRelease(releases, 'site').id, 22);
  assert.equal(selectRelease(releases, 'electron').id, 24);
  assert.equal(selectRelease(releases, 'pwa', 'pwa-v1.0.21').id, 21);
  assert.throws(() => selectRelease(releases, 'pwa', 'phantomchat-v1.0.24'));
  assert.throws(() => selectRelease(releases, 'pwa', 'pwa-v1.0.23'));
  releases.push({id: 26, draft: false, prerelease: false, tag_name: 'phantomchat-v1.0.26', published_at: '2026-10-26T12:00:00Z'});
  assert.throws(() => selectRelease(releases, 'electron'), /already Stable/);
  assert.equal(selectRelease(releases, 'electron', 'phantomchat-v1.0.24').id, 24);
});
test('archive checksum and tar entry safety fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-test-'));
  try {
    mkdirSync(`${dir}/source/site`, {recursive: true});
    mkdirSync(`${dir}/source/stable-candidate`);
    mkdirSync(`${dir}/assets`);
    writeFileSync(`${dir}/source/site/index.html`, 'fixture');
    execFileSync('tar', ['-czf', `${dir}/assets/bundle.tar.gz`, '-C', `${dir}/source`, 'site', 'stable-candidate']);
    const checksum = () => writeFileSync(`${dir}/assets/SHA256SUMS.txt`, `${digest(`${dir}/assets/bundle.tar.gz`)}  bundle.tar.gz\n`);
    checksum();
    verifyArchive(`${dir}/assets`);
    writeFileSync(`${dir}/assets/bundle.tar.gz`, 'corrupt');
    assert.throws(() => verifyArchive(`${dir}/assets`), /checksum/);
    execFileSync('ln', ['-s', '/etc/passwd', `${dir}/source/site/link`]);
    execFileSync('tar', ['-czf', `${dir}/assets/bundle.tar.gz`, '-C', `${dir}/source`, 'site', 'stable-candidate']);
    checksum();
    assert.throws(() => verifyArchive(`${dir}/assets`), /entry type/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
test('Preview publication preserves Stable; promotion reuses prepared bytes and retains Preview', () => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-flow-'));
  const script = resolve('scripts/releases/registry.mjs');
  try {
    mkdirSync(`${dir}/bin`);
    writeFileSync(`${dir}/state.json`, '[]');
    // No network, live credentials, or live releases. Model the gh boundary.
    writeFileSync(`${dir}/bin/gh`, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const a = process.argv.slice(2), file = process.env.MOCK_STATE;
const list = JSON.parse(fs.readFileSync(file));
if(a[0] === 'api') { console.log(list.map(r => JSON.stringify(r)).join('\\n')); process.exit(); }
const tag = a[2];
const option = name => a[a.indexOf(name) + 1];
if(a[1] === 'create') {
  if(list.some(r => r.tag_name === tag)) throw Error('duplicate');
  const dest = path.join(path.dirname(file), 'assets-' + tag); fs.mkdirSync(dest);
  for(const asset of a.slice(-2)) fs.copyFileSync(asset, path.join(dest, path.basename(asset)));
  list.push({id:list.length + 1, tag_name:tag, draft:true, body:fs.readFileSync(option('--notes-file'),'utf8'), assetsDir:dest});
} else if(a[1] === 'edit') list.find(r => r.tag_name === tag).body = fs.readFileSync(option('--notes-file'),'utf8');
else if(a[1] === 'download') {
  const r = list.find(r => r.tag_name === tag);
  for(const f of fs.readdirSync(r.assetsDir)) fs.copyFileSync(path.join(r.assetsDir,f), path.join(option('--dir'),f));
} else throw Error('unexpected gh call');
fs.writeFileSync(file, JSON.stringify(list));
`, {mode: 0o755});
    const env = {...process.env, PATH: `${dir}/bin:${process.env.PATH}`, MOCK_STATE: `${dir}/state.json`, GITHUB_RUN_ID: '100', GITHUB_RUN_NUMBER: '100', GITHUB_SHA: 'a'.repeat(40), GITHUB_OUTPUT: ''};
    const run = command => execFileSync(process.execPath, [script, command], {cwd: dir, env, encoding: 'utf8'});
    const clean = () => rmSync(`${dir}/.release-work`, {recursive: true, force: true});
    mkdirSync(`${dir}/scripts/channels`, {recursive: true});
    writeFileSync(`${dir}/scripts/channels/config.json`, JSON.stringify({stableRef:'b'.repeat(40), stableVersion:'1.0.1'}));
    const build = (stable, preview) => {
      mkdirSync(`${dir}/dist/preview`, {recursive:true});
      mkdirSync(`${dir}/dist-stable-candidate`, {recursive:true});
      writeFileSync(`${dir}/dist/index.html`, stable);
      writeFileSync(`${dir}/dist/preview/index.html`, preview);
      writeFileSync(`${dir}/dist-stable-candidate/index.html`, `promoted-${preview}`);
    };
    build('original-stable', 'preview-one');
    run('prepare-preview');
    // Unpublished archive must not become a baseline.
    clean();
    run('baseline');
    assert.throws(() => readFileSync(`${dir}/.release-work/current.json`));
    env.RELEASE_TAG = 'pwa-v1.0.100'; run('published');
    clean();
    env.GITHUB_RUN_ID = '101'; env.GITHUB_RUN_NUMBER = '101';
    run('baseline');
    build('must-not-ship-regenerated-stable', 'preview-two');
    run('prepare-preview');
    assert.equal(readFileSync(`${dir}/.release-work/payload/site/index.html`, 'utf8'), 'original-stable');
    assert.equal(readFileSync(`${dir}/.release-work/payload/site/preview/index.html`, 'utf8'), 'preview-two');
    env.RELEASE_TAG = 'pwa-v1.0.101'; run('published');
    clean();
    env.GITHUB_RUN_ID = '102'; env.GITHUB_RUN_NUMBER = '102';
    run('prepare-stable'); // omitted release selects newest published Preview
    assert.equal(readFileSync(`${dir}/.release-work/payload/site/index.html`, 'utf8'), 'promoted-preview-two');
    assert.equal(readFileSync(`${dir}/.release-work/payload/site/preview/index.html`, 'utf8'), 'preview-two');
    const record = JSON.parse(readFileSync(`${dir}/.release-work/record.json`));
    assert.equal(record.stableRef, 'a'.repeat(40));
    assert.equal(record.stableVersion, '1.0.101');
    clean();
    env.RELEASE_INPUT = 'pwa-v1.0.100';
    run('prepare-stable');
    assert.equal(readFileSync(`${dir}/.release-work/payload/site/index.html`, 'utf8'), 'promoted-preview-one');
    assert.equal(readFileSync(`${dir}/.release-work/payload/site/preview/index.html`, 'utf8'), 'preview-two');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
