import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFrontendProxy, DEFAULT_FRONTEND_ORIGIN, resolveFrontendOrigin} from './frontendProxy';
import {READY_PATH, SPLASH_PATH} from './splash';
import {buildCsp} from './csp';

const ORIGIN = 'https://frontend.test';
const INDEX = '<html><script>boot()</script><script src="x.js"></script></html>';

type Call = {url: string, init: RequestInit};

describe('frontend proxy', () => {
  let cacheDir: string;
  let calls: Call[];
  let upstream: (url: string) => Response | Promise<Response>;

  const proxy = () => createFrontendProxy({
    origin: ORIGIN,
    cacheDir,
    fetch: async(url, init) => {
      calls.push({url, init});
      return upstream(url);
    }
  });
  const get = (path: string, init?: RequestInit) => new Request('app://localhost' + path, init);
  const offline = () => {
    upstream = () => {
      throw new TypeError('net::ERR_INTERNET_DISCONNECTED');
    };
  };

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'frontend-proxy-'));
    calls = [];
    upstream = () => new Response(INDEX, {headers: {'content-type': 'text/html; charset=utf-8'}});
  });
  afterEach(() => rmSync(cacheDir, {recursive: true, force: true}));

  it('serves documents from the pinned origin with redirects refused and a revalidation', async() => {
    const response = await proxy().handle(get('/index.html?pc_cb=1'));
    expect(await response.text()).toBe(INDEX);
    expect(calls[0].url).toBe(ORIGIN + '/index.html?pc_cb=1');
    expect(calls[0].init.redirect).toBe('error');
    expect(calls[0].init.cache).toBe('no-cache');
  });

  it('hashes the fetched document inline scripts into its CSP', async() => {
    const response = await proxy().handle(get('/index.html'));
    const csp = response.headers.get('content-security-policy');
    expect(csp).toBe(buildCsp(INDEX));
    expect(csp).toMatch(/script-src 'self' 'wasm-unsafe-eval' 'sha256-/);
    expect(csp).not.toContain('unsafe-inline\' \'sha');
  });

  it('gives non-documents a CSP with no inline script hashes', async() => {
    upstream = () => new Response('x', {headers: {'content-type': 'text/javascript'}});
    const response = await proxy().handle(get('/worker-AbCd1234.js'));
    expect(response.headers.get('content-security-policy')).toBe(buildCsp());
  });

  it('never lets a path reach another origin', async() => {
    const response = await proxy().handle(new Request('app://localhost//evil.test/x'));
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('refuses writes without calling upstream', async() => {
    const response = await proxy().handle(get('/index.html', {method: 'POST', body: 'x'}));
    expect(response.status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  it('serves the last document offline', async() => {
    const instance = proxy();
    await instance.handle(get('/index.html'));
    offline();
    const response = await instance.handle(get('/index.html'));
    expect(await response.text()).toBe(INDEX);
    expect(response.headers.get('content-security-policy')).toBe(buildCsp(INDEX));
  });

  it('sees a new deploy of a mutable file instead of its local copy', async() => {
    const instance = proxy();
    upstream = () => new Response('1.0.1');
    await instance.handle(get('/version'));
    upstream = () => new Response('1.0.2');
    expect(await (await instance.handle(get('/version'))).text()).toBe('1.0.2');
  });

  it('serves hashed assets from disk without touching the network', async() => {
    const instance = proxy();
    upstream = () => new Response('code', {headers: {'content-type': 'text/javascript'}});
    await instance.handle(get('/index-7LfOX5uN.js'));
    calls = [];
    const response = await instance.handle(get('/index-7LfOX5uN.js'));
    expect(await response.text()).toBe('code');
    expect(response.headers.get('content-type')).toBe('text/javascript');
    expect(calls).toHaveLength(0);
  });

  it('shows the splash for a document with no copy and no network', async() => {
    offline();
    const response = await proxy().handle(get('/index.html'));
    expect(await response.text()).toContain('Looking for updates');
    expect(response.status).toBe(200);
  });

  it('fails an asset with no copy and no network', async() => {
    offline();
    expect((await proxy().handle(get('/a-7LfOX5uN.js'))).status).toBe(502);
  });

  it('keeps the local copy when upstream has a server error', async() => {
    const instance = proxy();
    await instance.handle(get('/index.html'));
    upstream = () => new Response('bad gateway', {status: 502});
    expect(await (await instance.handle(get('/index.html'))).text()).toBe(INDEX);
  });

  it('does not cache a 404 as the file', async() => {
    const instance = proxy();
    upstream = () => new Response('missing', {status: 404});
    expect((await instance.handle(get('/gone.json'))).status).toBe(404);
    offline();
    expect((await instance.handle(get('/gone.json'))).status).toBe(502);
  });

  it('passes a range request through uncached', async() => {
    upstream = () => new Response('ab', {status: 206, headers: {'content-range': 'bytes 0-1/4'}});
    const response = await proxy().handle(get('/media.mp3', {headers: {Range: 'bytes=0-1'}}));
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-1/4');
    expect(calls[0].init.headers).toEqual({Range: 'bytes=0-1'});
  });

  it('offline HEAD and Range requests answer from the stored copy (#356)', async() => {
    const instance = proxy();
    upstream = () => new Response('abcdef', {headers: {'content-type': 'audio/mpeg'}});
    expect(await (await instance.handle(get('/media.mp3'))).text()).toBe('abcdef');
    offline();
    const ranged = await instance.handle(get('/media.mp3', {headers: {Range: 'bytes=2-3'}}));
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe('bytes 2-3/6');
    expect(await ranged.text()).toBe('cd');
    const suffix = await instance.handle(get('/media.mp3', {headers: {Range: 'bytes=-2'}}));
    expect(await suffix.text()).toBe('ef');
    const head = await instance.handle(get('/media.mp3', {method: 'HEAD'}));
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('6');
    expect((await instance.handle(get('/media.mp3', {headers: {Range: 'bytes=9-'}}))).status).toBe(416);
  });

  it('offline HEAD or Range with no stored copy is a 502, not a rejection', async() => {
    offline();
    expect((await proxy().handle(get('/never.mp3', {headers: {Range: 'bytes=0-1'}}))).status).toBe(502);
    expect((await proxy().handle(get('/never.mp3', {method: 'HEAD'}))).status).toBe(502);
  });

  it('an entry document whose scripts or stylesheets are missing is not an entry (#356)', async() => {
    const html = '<html><link rel="stylesheet" href="/app-AbCd1234.css"><link rel="icon" href="/fav.ico"><script type="module" src="/main-AbCd1234.js"></script><script src="https://other.test/x.js"></script></html>';
    const instance = proxy();
    upstream = () => new Response(html, {headers: {'content-type': 'text/html'}});
    expect((await instance.handle(get(READY_PATH))).status).toBe(204);
    // Interrupted first load: document on disk, its assets are not.
    expect(instance.hasEntry()).toBe(false);
    upstream = () => new Response('body{}', {headers: {'content-type': 'text/css'}});
    await instance.handle(get('/app-AbCd1234.css'));
    expect(instance.hasEntry()).toBe(false);
    upstream = () => new Response('boot()', {headers: {'content-type': 'text/javascript'}});
    await instance.handle(get('/main-AbCd1234.js'));
    // The icon and the cross-origin script do not gate the launch.
    expect(instance.hasEntry()).toBe(true);
  });

  it('first launch: splash until ready has stored the entry document', async() => {
    const instance = proxy();
    expect(instance.hasEntry()).toBe(false);
    expect(await (await instance.handle(get(SPLASH_PATH))).text()).toContain('Looking for updates');
    expect(calls).toHaveLength(0);

    offline();
    expect((await instance.handle(get(READY_PATH))).status).toBe(503);
    expect(instance.hasEntry()).toBe(false);

    upstream = () => new Response(INDEX, {headers: {'content-type': 'text/html'}});
    expect((await instance.handle(get(READY_PATH))).status).toBe(204);
    // The document alone is not enough: its x.js has to be on disk too.
    expect(instance.hasEntry()).toBe(false);
    await instance.handle(get('/x.js'));
    expect(instance.hasEntry()).toBe(true);

    offline();
    expect(await (await instance.handle(get('/'))).text()).toBe(INDEX);
  });

  it('does not report ready on an upstream error', async() => {
    upstream = () => new Response('down', {status: 500});
    const instance = proxy();
    expect((await instance.handle(get(READY_PATH))).status).toBe(503);
    expect(instance.hasEntry()).toBe(false);
  });
});

describe('frontend origin', () => {
  it('a packaged app ignores the override', () => {
    expect(resolveFrontendOrigin(true, 'https://evil.test')).toBe(DEFAULT_FRONTEND_ORIGIN);
  });
  it('an unpackaged run may use a test origin', () => {
    expect(resolveFrontendOrigin(false, 'http://127.0.0.1:9/x')).toBe('http://127.0.0.1:9');
    expect(resolveFrontendOrigin(false, undefined)).toBe(DEFAULT_FRONTEND_ORIGIN);
  });
});
