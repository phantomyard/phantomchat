// Minimal OCI registry client for the PWA build store (GitHub Packages, ghcr.io).
// Each PWA build is ONE artifact: a single bundle.tar.gz layer, with the
// deployment record in a manifest annotation. Publishing a build re-pushes the
// manifest with the updated record (the layer is not re-uploaded) and moves the
// `live` / `preview` tags, so selection never has to list every build.
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';

export const RECORD_ANNOTATION = 'ai.phantomyard.pwa.record';
const MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const ARTIFACT = 'application/vnd.phantomyard.pwa.v1';
const LAYER = 'application/vnd.phantomyard.pwa.bundle.v1.tar+gzip';
const EMPTY = {mediaType: 'application/vnd.oci.empty.v1+json', digest: `sha256:${sha256('{}')}`, size: 2};
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function storeFromEnv(env = process.env) {
  const repo = env.GITHUB_REPOSITORY || 'phantomyard/phantomchat';
  return new OciStore({
    registry: env.PWA_REGISTRY || 'https://ghcr.io',
    name: env.PWA_PACKAGE || `${repo.split('/')[0]}/phantomchat-pwa`.toLowerCase(),
    source: `${env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}`,
    token: env.GH_TOKEN,
  });
}

export class OciStore {
  constructor({registry, name, source, token}) {
    Object.assign(this, {registry: registry.replace(/\/$/, ''), name, source, token});
  }
  async auth() {
    if(this.bearer !== undefined) return this.bearer;
    const url = `${this.registry}/token?scope=repository:${this.name}:pull,push`;
    const headers = this.token ? {Authorization: `Basic ${Buffer.from(`x-access-token:${this.token}`).toString('base64')}`} : {};
    const res = await fetch(url, {headers});
    if(!res.ok) throw new Error(`Registry token request failed: HTTP ${res.status}`);
    this.bearer = (await res.json()).token || '';
    return this.bearer;
  }
  async request(path, init = {}) {
    const url = path.startsWith('http') ? path : `${this.registry}/v2/${this.name}${path}`;
    const headers = {...init.headers, Authorization: `Bearer ${await this.auth()}`};
    return fetch(url, {...init, headers});
  }
  async blobExists(digest) {
    const res = await this.request(`/blobs/${digest}`, {method: 'HEAD'});
    return res.ok;
  }
  async pushBlob(bytes) {
    const digest = `sha256:${sha256(bytes)}`;
    if(await this.blobExists(digest)) return {digest, size: bytes.length};
    const start = await this.request('/blobs/uploads/', {method: 'POST', headers: {'Content-Length': '0'}});
    if(start.status !== 202) throw new Error(`Blob upload start failed: HTTP ${start.status}`);
    const location = new URL(start.headers.get('location'), this.registry);
    location.searchParams.set('digest', digest);
    const put = await this.request(location.href, {method: 'PUT', body: bytes,
      headers: {'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length)}});
    if(put.status !== 201) throw new Error(`Blob upload failed: HTTP ${put.status}`);
    return {digest, size: bytes.length};
  }
  // Returns {manifest, record, layer} or null when the tag does not exist.
  async get(tag) {
    if(!TAG.test(tag)) throw new Error(`Invalid PWA build tag: ${tag}`);
    const res = await this.request(`/manifests/${tag}`, {headers: {Accept: MANIFEST}});
    if(res.status === 404) return null;
    if(!res.ok) throw new Error(`Manifest ${tag} read failed: HTTP ${res.status}`);
    const manifest = await res.json();
    if(manifest.artifactType !== ARTIFACT || manifest.layers?.length !== 1 || manifest.layers[0].mediaType !== LAYER) {
      throw new Error(`${tag} is not a PWA build artifact`);
    }
    let record;
    try { record = JSON.parse(manifest.annotations?.[RECORD_ANNOTATION]); } catch { throw new Error(`${tag} has no readable record`); }
    return {tag, manifest, record, layer: manifest.layers[0]};
  }
  async putManifest(tags, layer, record) {
    // The config blob must exist before a manifest may reference it.
    await this.pushBlob(Buffer.from('{}'));
    const manifest = {schemaVersion: 2, mediaType: MANIFEST, artifactType: ARTIFACT, config: EMPTY, layers: [layer],
      annotations: {
        'org.opencontainers.image.source': this.source,
        'org.opencontainers.image.title': `PWA ${record.operation} ${record.version}`,
        [RECORD_ANNOTATION]: JSON.stringify(record),
      }};
    const body = JSON.stringify(manifest);
    for(const tag of tags) {
      if(!TAG.test(tag)) throw new Error(`Invalid PWA build tag: ${tag}`);
      const res = await this.request(`/manifests/${tag}`, {method: 'PUT', body, headers: {'Content-Type': MANIFEST}});
      if(res.status !== 201) throw new Error(`Manifest ${tag} write failed: HTTP ${res.status}`);
    }
  }
  async push(tag, bundlePath, record) {
    const blob = await this.pushBlob(readFileSync(bundlePath));
    const layer = {mediaType: LAYER, ...blob, annotations: {'org.opencontainers.image.title': 'bundle.tar.gz'}};
    await this.putManifest([tag], layer, record);
  }
  // Writes bundle.tar.gz + SHA256SUMS.txt so verifyArchive() can check it.
  async download(build, directory) {
    const res = await this.request(`/blobs/${build.layer.digest}`);
    if(!res.ok) throw new Error(`Bundle download for ${build.tag} failed: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const hex = sha256(bytes);
    if(`sha256:${hex}` !== build.layer.digest) throw new Error(`Bundle digest mismatch for ${build.tag}`);
    writeFileSync(`${directory}/bundle.tar.gz`, bytes);
    writeFileSync(`${directory}/SHA256SUMS.txt`, `${hex}  bundle.tar.gz\n`);
  }
}
