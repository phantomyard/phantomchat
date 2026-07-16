import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {uploadToBlossomWithProgress, BLOSSOM_SERVERS} from '@lib/phantomchat/blossom-upload-progress';
import {__resetBlossomServersCacheForTests} from '@lib/phantomchat/blossom-servers';

class MockXHR {
  static instances: MockXHR[] = [];
  upload = {onprogress: null as ((e: {loaded: number; total: number; lengthComputable: boolean}) => void) | null};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  responseText = '';
  status = 0;
  readonly method: string = '';
  readonly url: string = '';
  readonly headers: Record<string, string> = {};
  sentBody: any = null;
  aborted = false;

  open(method: string, url: string) {
    (this as any).method = method;
    (this as any).url = url;
    MockXHR.instances.push(this);
  }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  send(body: any) { this.sentBody = body; }
  abort() { this.aborted = true; this.onabort?.(); }
}

const PRIVKEY_HEX = '0000000000000000000000000000000000000000000000000000000000000001';

// sha256Hex inside uploadToBlossomWithProgress needs several event-loop turns
// to resolve (Blob.arrayBuffer polyfill → crypto.subtle.digest). Spin until
// an XHR instance appears, up to 20 turns.
async function waitForXhr(targetIndex = MockXHR.instances.length) {
  for(let i = 0; i < 20; i++) {
    if(MockXHR.instances.length > targetIndex) return;
    await new Promise(r => setTimeout(r, 0));
  }
}

describe('blossom-upload-progress', () => {
  let origXHR: typeof XMLHttpRequest;

  beforeEach(() => {
    MockXHR.instances = [];
    origXHR = globalThis.XMLHttpRequest;
    (globalThis as any).XMLHttpRequest = MockXHR;
    __resetBlossomServersCacheForTests();
    // Pin server list so tests don't depend on network for /blossom.json.
    if(typeof (globalThis as any).window === 'undefined') {
      (globalThis as any).window = {};
    }
    (globalThis as any).window.__phantomchatTestBlossom = undefined;
  });

  afterEach(() => {
    (globalThis as any).XMLHttpRequest = origXHR;
    __resetBlossomServersCacheForTests();
    if(typeof (globalThis as any).window !== 'undefined') {
      delete (globalThis as any).window.__phantomchatTestBlossom;
    }
  });

  it('uploads to ≥2 servers and returns primary + mirrors', async() => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const progress: number[] = [];

    const promise = uploadToBlossomWithProgress(blob, PRIVKEY_HEX, {
      onProgress: (p) => progress.push(p)
    });

    // First server succeeds — progress reported.
    await waitForXhr();
    const xhr0 = MockXHR.instances[0];
    expect(xhr0.method).toBe('PUT');
    expect(xhr0.url).toBe(BLOSSOM_SERVERS[0] + '/upload');
    expect(xhr0.headers['Authorization']).toMatch(/^Nostr /);
    xhr0.upload.onprogress?.({loaded: 50, total: 100, lengthComputable: true});
    xhr0.upload.onprogress?.({loaded: 100, total: 100, lengthComputable: true});
    xhr0.status = 200;
    xhr0.responseText = JSON.stringify({url: 'https://p.example/x', sha256: 'abc'});
    xhr0.onload?.();

    // Second server also succeeds (mirror write).
    await waitForXhr();
    const xhr1 = MockXHR.instances[1];
    expect(xhr1.url).toBe(BLOSSOM_SERVERS[1] + '/upload');
    xhr1.status = 200;
    xhr1.responseText = JSON.stringify({url: 'https://m.example/x', sha256: 'abc'});
    xhr1.onload?.();

    const result = await promise;
    expect(result.url).toBe('https://p.example/x');
    expect(result.mirrors).toEqual(['https://p.example/x', 'https://m.example/x']);
    expect(progress).toEqual([50, 100]);
    // Stops once minMirrors (=2) are filled — no third PUT.
    expect(MockXHR.instances.length).toBe(2);
  });

  it('succeeds with one mirror when later servers fail', async() => {
    const blob = new Blob([new Uint8Array([1])]);
    const promise = uploadToBlossomWithProgress(blob, PRIVKEY_HEX, {});

    await waitForXhr();
    MockXHR.instances[0].status = 200;
    MockXHR.instances[0].responseText = JSON.stringify({url: 'https://only.example/y', sha256: 'def'});
    MockXHR.instances[0].onload?.();

    // Pursuit of a second mirror — second host 503s, third also fails.
    for(let i = 1; i < BLOSSOM_SERVERS.length; i++) {
      await waitForXhr();
      MockXHR.instances[i].status = 503;
      MockXHR.instances[i].onload?.();
    }

    const result = await promise;
    expect(result.url).toBe('https://only.example/y');
    expect(result.mirrors).toEqual(['https://only.example/y']);
  });

  it('throws when all servers fail', async() => {
    const blob = new Blob([new Uint8Array([1])]);
    const promise = uploadToBlossomWithProgress(blob, PRIVKEY_HEX, {});

    for(let i = 0; i < BLOSSOM_SERVERS.length; i++) {
      await waitForXhr();
      MockXHR.instances[i].status = 500;
      MockXHR.instances[i].onload?.();
    }

    await expect(promise).rejects.toThrow(/all blossom servers failed/);
  });

  it('aborts the current XHR when signal fires', async() => {
    const ctrl = new AbortController();
    const blob = new Blob([new Uint8Array([1])]);
    const promise = uploadToBlossomWithProgress(blob, PRIVKEY_HEX, {signal: ctrl.signal});

    await waitForXhr();
    ctrl.abort();
    expect(MockXHR.instances[0].aborted).toBe(true);
    await expect(promise).rejects.toThrow(/aborted/);
  });
});
