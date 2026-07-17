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
// to resolve (Blob.arrayBuffer polyfill → crypto.subtle.digest). Parallel
// fan-out opens every XHR in one map, so wait until all expected ones land.
async function waitForXhrCount(n: number) {
  for(let i = 0; i < 40; i++) {
    if(MockXHR.instances.length >= n) return;
    await new Promise(r => setTimeout(r, 0));
  }
  throw new Error(`expected ${n} XHRs, got ${MockXHR.instances.length}`);
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

  it('fans out in parallel, returns primary + every successful mirror', async() => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const progress: number[] = [];

    const promise = uploadToBlossomWithProgress(blob, PRIVKEY_HEX, {
      onProgress: (p) => progress.push(p)
    });

    // All hosts open at once (parallel fan-out, not sequential t1→t2).
    await waitForXhrCount(BLOSSOM_SERVERS.length);
    expect(MockXHR.instances.length).toBe(BLOSSOM_SERVERS.length);

    const xhr0 = MockXHR.instances[0];
    expect(xhr0.method).toBe('PUT');
    expect(xhr0.url).toBe(BLOSSOM_SERVERS[0] + '/upload');
    expect(xhr0.headers['Authorization']).toMatch(/^Nostr /);
    // Shared Authorization across every leg (one auth event for the hash).
    for(const xhr of MockXHR.instances) {
      expect(xhr.headers['Authorization']).toBe(xhr0.headers['Authorization']);
      expect(xhr.url).toMatch(/\/upload$/);
    }

    // Progress pinned to host 0 only.
    xhr0.upload.onprogress?.({loaded: 50, total: 100, lengthComputable: true});
    xhr0.upload.onprogress?.({loaded: 100, total: 100, lengthComputable: true});
    // Host 1 progress must not fire through even if its XHR reports.
    MockXHR.instances[1].upload.onprogress?.({loaded: 99, total: 100, lengthComputable: true});

    // First two succeed; last fails — still multi-mirror.
    xhr0.status = 200;
    xhr0.responseText = JSON.stringify({url: 'https://p.example/x', sha256: 'abc'});
    xhr0.onload?.();
    MockXHR.instances[1].status = 200;
    MockXHR.instances[1].responseText = JSON.stringify({url: 'https://m.example/x', sha256: 'abc'});
    MockXHR.instances[1].onload?.();
    for(let i = 2; i < MockXHR.instances.length; i++) {
      MockXHR.instances[i].status = 503;
      MockXHR.instances[i].onload?.();
    }

    const result = await promise;
    expect(result.url).toBe('https://p.example/x');
    expect(result.mirrors).toEqual(['https://p.example/x', 'https://m.example/x']);
    // Local integrity hash; never trust the server-echoed 'abc'.
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sha256).not.toBe('abc');
    // Host-0 progress only — host 1's 99 was ignored.
    expect(progress).toEqual([50, 100]);
  });

  it('succeeds with one mirror when later servers fail', async() => {
    const blob = new Blob([new Uint8Array([1])]);
    const promise = uploadToBlossomWithProgress(blob, PRIVKEY_HEX, {});

    await waitForXhrCount(BLOSSOM_SERVERS.length);
    MockXHR.instances[0].status = 200;
    MockXHR.instances[0].responseText = JSON.stringify({url: 'https://only.example/y', sha256: 'def'});
    MockXHR.instances[0].onload?.();
    for(let i = 1; i < MockXHR.instances.length; i++) {
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

    await waitForXhrCount(BLOSSOM_SERVERS.length);
    for(const xhr of MockXHR.instances) {
      xhr.status = 500;
      xhr.onload?.();
    }

    await expect(promise).rejects.toThrow(/all blossom servers failed/);
  });

  it('aborts every leg and rejects when signal fires mid-fan-out', async() => {
    const ctrl = new AbortController();
    const blob = new Blob([new Uint8Array([1])]);
    const promise = uploadToBlossomWithProgress(blob, PRIVKEY_HEX, {signal: ctrl.signal});

    await waitForXhrCount(BLOSSOM_SERVERS.length);
    ctrl.abort();
    // Shared signal aborts every in-flight XHR.
    for(const xhr of MockXHR.instances) {
      expect(xhr.aborted).toBe(true);
    }
    await expect(promise).rejects.toThrow(/aborted/);
  });

  it('rejects immediately when signal is already aborted', async() => {
    const ctrl = new AbortController();
    ctrl.abort();
    const blob = new Blob([new Uint8Array([1])]);
    await expect(
      uploadToBlossomWithProgress(blob, PRIVKEY_HEX, {signal: ctrl.signal})
    ).rejects.toThrow(/aborted/);
    expect(MockXHR.instances.length).toBe(0);
  });
});
