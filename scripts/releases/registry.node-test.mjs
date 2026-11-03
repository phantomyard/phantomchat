import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {execFileSync, execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {selectRelease, digest, verifyArchive, pruneVersions} from './registry.mjs';

// In-memory OCI registry: just the endpoints oci.mjs uses.
function mockRegistry() {
  const blobs = new Map(), manifests = new Map();
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = Buffer.concat(chunks);
      if(url.pathname === '/token') return res.end(JSON.stringify({token: 't'}));
      let m;
      if((m = url.pathname.match(/^\/v2\/.+\/blobs\/uploads\/$/))) { res.writeHead(202, {Location: '/upload/1'}); return res.end(); }
      if(url.pathname === '/upload/1') {
        const d = url.searchParams.get('digest');
        if(d !== `sha256:${createHash('sha256').update(body).digest('hex')}`) { res.writeHead(400); return res.end(); }
        blobs.set(d, body); res.writeHead(201); return res.end();
      }
      if((m = url.pathname.match(/^\/v2\/.+\/blobs\/(.+)$/))) {
        if(!blobs.has(m[1])) { res.writeHead(404); return res.end(); }
        res.writeHead(200); return res.end(req.method === 'HEAD' ? undefined : blobs.get(m[1]));
      }
      if((m = url.pathname.match(/^\/v2\/.+\/manifests\/(.+)$/))) {
        if(req.method === 'PUT') {
          const manifest = JSON.parse(body);
          if(![manifest.config, ...manifest.layers].every(b => blobs.has(b.digest))) { res.writeHead(400); return res.end(); }
          manifests.set(m[1], body); res.writeHead(201); return res.end();
        }
        if(!manifests.has(m[1])) { res.writeHead(404); return res.end(); }
        return res.end(manifests.get(m[1]));
      }
      res.writeHead(500); res.end();
    });
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({server, manifests, url: `http://127.0.0.1:${server.address().port}`})));
}


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
test('Preview publication preserves Stable; promotion reuses prepared bytes and retains Preview', async() => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-flow-'));
  const script = resolve('scripts/releases/registry.mjs');
  const registry = await mockRegistry();
  try {
    mkdirSync(`${dir}/bin`);
    // Legacy draft releases: the deployed site (a Stable promotion) and the
    // newest published Preview. The store must import both, then never write
    // a release again.
    mkdirSync(`${dir}/legacy/site/preview`, {recursive: true});
    mkdirSync(`${dir}/legacy/stable-candidate`, {recursive: true});
    writeFileSync(`${dir}/legacy/site/index.html`, 'original-stable');
    writeFileSync(`${dir}/legacy/site/preview/index.html`, 'preview-zero');
    writeFileSync(`${dir}/legacy/stable-candidate/index.html`, 'promoted-preview-zero');
    const assets = tag => {
      const a = `${dir}/assets-${tag}`; mkdirSync(a);
      execFileSync('tar', ['-czf', `${a}/bundle.tar.gz`, '-C', `${dir}/legacy`, 'site', 'stable-candidate']);
      writeFileSync(`${a}/SHA256SUMS.txt`, `${digest(`${a}/bundle.tar.gz`)}  bundle.tar.gz\n`);
      return a;
    };
    const legacy = (id, operation, tag) => ({id, tag_name: tag, draft: true, assetsDir: assets(tag),
      body: JSON.stringify({schema: 1, operation, source: 'c'.repeat(40), stableRef: 'b'.repeat(40), version: '1.0.90', stableVersion: '1.0.1', previewRelease: 'pwa-v1.0.90', publishedAt: `2026-10-0${id}T12:00:00Z`})});
    writeFileSync(`${dir}/state.json`, JSON.stringify([legacy(1, 'preview', 'pwa-v1.0.90'), legacy(2, 'stable', 'pwa-v1.0.90-stable-9')]));
    // No network or live credentials. Model the gh boundary: release reads only.
    writeFileSync(`${dir}/bin/gh`, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const a = process.argv.slice(2), file = process.env.MOCK_STATE;
fs.appendFileSync(file + '.calls', a.join(' ') + '\\n');
const list = JSON.parse(fs.readFileSync(file));
if(a[0] === 'api' && a.includes('-X')) process.exit();
if(a[0] === 'api' && a.some(x => x.includes('/packages/'))) process.exit();
if(a[0] === 'api') { console.log(list.map(r => JSON.stringify(r)).join('\\n')); process.exit(); }
const option = name => a[a.indexOf(name) + 1];
if(a[1] === 'download') {
  const r = list.find(r => r.tag_name === a[2]);
  for(const f of fs.readdirSync(r.assetsDir)) fs.copyFileSync(path.join(r.assetsDir,f), path.join(option('--dir'),f));
} else throw Error('unexpected gh call ' + a.join(' '));
`, {mode: 0o755});
    const env = {...process.env, PATH: `${dir}/bin:${process.env.PATH}`, MOCK_STATE: `${dir}/state.json`, PWA_REGISTRY: registry.url, PWA_PACKAGE: 'o/phantomchat-pwa', GH_TOKEN: 'x', GITHUB_RUN_ID: '100', GITHUB_RUN_NUMBER: '100', GITHUB_SHA: 'a'.repeat(40), GITHUB_OUTPUT: ''};
    const run = command => promisify(execFile)(process.execPath, [script, command], {cwd: dir, env, encoding: 'utf8'});
    const record = tag => JSON.parse(JSON.parse(registry.manifests.get(tag)).annotations['ai.phantomyard.pwa.record']);
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
    // First run on an empty store imports the legacy drafts.
    await run('baseline');
    assert.equal(record('live').operation, 'stable');
    assert.equal(record('preview').previewRelease, 'pwa-v1.0.90');
    assert.ok(registry.manifests.has('pwa-v1.0.90-stable-9'));
    build('must-not-ship-regenerated-stable', 'preview-one');
    await run('prepare-preview');
    assert.equal(readFileSync(`${dir}/.release-work/payload/site/index.html`, 'utf8'), 'original-stable');
    // An unpublished build must not become the baseline.
    clean();
    await run('baseline');
    assert.equal(JSON.parse(readFileSync(`${dir}/.release-work/current.json`)).operation, 'stable');
    assert.equal(record('pwa-v1.0.100').publishedAt, undefined);
    env.RELEASE_TAG = 'pwa-v1.0.100'; await run('published');
    await assert.rejects(run('published'), /unexpected unpublished/);
    assert.equal(record('live').version, '1.0.100');
    assert.equal(record('preview').version, '1.0.100');
    clean();
    env.GITHUB_RUN_ID = '101'; env.GITHUB_RUN_NUMBER = '101';
    await run('baseline');
    build('must-not-ship-regenerated-stable', 'preview-two');
    await run('prepare-preview');
    assert.equal(readFileSync(`${dir}/.release-work/payload/site/index.html`, 'utf8'), 'original-stable');
    assert.equal(readFileSync(`${dir}/.release-work/payload/site/preview/index.html`, 'utf8'), 'preview-two');
    env.RELEASE_TAG = 'pwa-v1.0.101'; await run('published');
    clean();
    env.GITHUB_RUN_ID = '102'; env.GITHUB_RUN_NUMBER = '102';
    await run('prepare-stable'); // omitted release selects newest published Preview
    assert.equal(readFileSync(`${dir}/.release-work/payload/site/index.html`, 'utf8'), 'promoted-preview-two');
    assert.equal(readFileSync(`${dir}/.release-work/payload/site/preview/index.html`, 'utf8'), 'preview-two');
    const promoted = JSON.parse(readFileSync(`${dir}/.release-work/record.json`));
    assert.equal(promoted.stableRef, 'a'.repeat(40));
    assert.equal(promoted.stableVersion, '1.0.101');
    env.RELEASE_TAG = 'pwa-v1.0.101-stable-102'; await run('published');
    assert.equal(record('live').operation, 'stable');
    // A promotion never moves `preview`.
    assert.deepEqual([record('preview').operation, record('preview').version], ['preview', '1.0.101']);
    clean();
    env.RELEASE_INPUT = 'pwa-v1.0.100'; env.GITHUB_RUN_ID = '103';
    await run('prepare-stable');
    assert.equal(readFileSync(`${dir}/.release-work/payload/site/index.html`, 'utf8'), 'promoted-preview-one');
    assert.equal(readFileSync(`${dir}/.release-work/payload/site/preview/index.html`, 'utf8'), 'preview-two');
    clean();
    env.RELEASE_INPUT = 'pwa-v1.0.101-stable-102';
    await assert.rejects(run('prepare-stable'), /No successfully published pwa Preview/);
    // A prepared Preview whose deploy never succeeded can't be promoted.
    clean(); delete env.RELEASE_INPUT;
    env.GITHUB_RUN_ID = '104'; env.GITHUB_RUN_NUMBER = '104';
    await run('baseline');
    build('unused', 'preview-failed');
    await run('prepare-preview');
    clean();
    env.RELEASE_INPUT = 'pwa-v1.0.104';
    await assert.rejects(run('prepare-stable'), /not a successfully published/);
    // The store replaced releases: nothing but reads and the one-off import.
    const calls = readFileSync(`${dir}/state.json.calls`, 'utf8');
    assert.doesNotMatch(calls, /release (create|edit|delete)/);
    assert.equal(calls.match(/release download/g).length, 2);
  } finally {
    registry.server.close();
    rmSync(dir, {recursive: true, force: true});
  }
});
test('prune keeps live, preview and the newest builds; drops superseded manifests', () => {
  const v = (id, tags) => ({id, created_at: `2026-11-0${id}T00:00:00Z`, metadata: {container: {tags}}});
  const versions = [v(1, ['pwa-v1.0.1', 'live']), v(2, ['pwa-v1.0.2']), v(3, ['pwa-v1.0.3']), v(4, ['pwa-v1.0.4', 'preview']), v(5, []), v(6, ['pwa-v1.0.6'])];
  assert.deepEqual(pruneVersions(versions, 2).map(x => x.id).sort(), [2, 5]);
  assert.deepEqual(pruneVersions(versions, 9).map(x => x.id), [5]);
});
