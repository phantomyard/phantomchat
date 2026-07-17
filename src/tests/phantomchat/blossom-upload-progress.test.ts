import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {
  uploadToBlossomWithProgress,
  BLOSSOM_SERVERS,
  BLOSSOM_MIRROR_MIN
} from '@lib/phantomchat/blossom-upload-progress';
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

  it('fans out in parallel to minMirrors hosts, returns primary + every success', async() => {
    // List has 3 hosts; default minMirrors=2 → only open 2 XHRs (cap egress).
    expect(BLOSSOM_SERVERS.length).toBeGreaterThanOrEqual(BLOSSOM_MIRROR_MIN);
    expect(BLOSSOM_MIRROR_MIN).toBe(2);

    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const progress: number[] = [];

    const promise = uploadToBlossomWithProgress(blob, PRIVKEY_HEX, {
      onProgress: (p) => progress.push(p)
    });

    await waitForXhrCount(BLOSSOM_MIRROR_MIN);
    // Give a couple more ticks so a full-list fan-out would have appeared.
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(MockXHR.instances.length).toBe(BLOSSOM_MIRROR_MIN);

    const xhr0 = MockXHR.instances[0];
    expect(xhr0.method).toBe('PUT');
    expect(xhr0.url).toBe(BLOSSOM_SERVERS[0] + '/upload');
    expect(xhr0.headers['Authorization']).toMatch(/^Nostr /);
    // Shared Authorization across every leg (one auth event for the hash).
    for(const xhr of MockXHR.instances) {
      expect(xhr.headers['Authorization']).toBe(xhr0.headers['Authorization']);
      expect(xhr.url).toMatch(/\/upload$/);
    }

    // Max-across-legs progress: both legs report; reported value is monotonic max.
    MockXHR.instances[0].upload.onprogress?.({loaded: 40, total: 100, lengthComputable: true});
    MockXHR.instances[1].upload.onprogress?.({loaded: 70, total: 100, lengthComputable: true});
    MockXHR.instances[0].upload.onprogress?.({loaded: 55, total: 100, lengthComputable: true});
    MockXHR.instances[1].upload.onprogress?.({loaded: 100, total: 100, lengthComputable: true});

    // Both capped targets succeed.
    MockXHR.instances[0].status = 200;
    MockXHR.instances[0].responseText = JSON.stringify({url: 'https://p.example/x', sha256: 'abc'});
    MockXHR.instances[0].onload?.();
    MockXHR.instances[1].status = 200;
    MockXHR.instances[1].responseText = JSON.stringify({url: 'https://m.example/x', sha256: 'abc'});
    MockXHR.instances[1].onload?.();

    const result = await promise;
    expect(result.url).toBe('https://p.example/x');
    expect(result.mirrors).toEqual(['https://p.example/x', 'https://m.example/x']);
    // Local integrity hash; never trust the server-echoed 'abc'.
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sha256).not.toBe('abc');
    // Max progression: 40 → 70 → 70 (55 ignored, host0 lagging) → 100
    expect(progress).toEqual([40, 70, 70, 100]);
  });

  it('succeeds with one mirror when the second target fails', async() => {
    const blob = new Blob([new Uint8Array([1])]);
    const promise = uploadToBlossomWithProgress(blob, PRIVKEY_HEX, {});

    await waitForXhrCount(BLOSSOM_MIRROR_MIN);
    MockXHR.instances[0].status = 200;
    MockXHR.instances[0].responseText = JSON.stringify({url: 'https://only.example/y', sha256: 'def'});
    MockXHR.instances[0].onload?.();
    MockXHR.instances[1].status = 503;
    MockXHR.instances[1].onload?.();

    const result = await promise;
    expect(result.url).toBe('https://only.example/y');
    expect(result.mirrors).toEqual(['https://only.example/y']);
  });

  it('throws when all targets fail', async() => {
    const blob = new Blob([new Uint8Array([1])]);
    const promise = uploadToBlossomWithProgress(blob, PRIVKEY_HEX, {});

    await waitForXhrCount(BLOSSOM_MIRROR_MIN);
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

    await waitForXhrCount(BLOSSOM_MIRROR_MIN);
    ctrl.abort();
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

  it('respects an explicit minMirrors cap', async() => {
    const blob = new Blob([new Uint8Array([9])]);
    // Cap at 1 → single PUT, not the full list.
    const promise = uploadToBlossomWithProgress(blob, PRIVKEY_HEX, {minMirrors: 1});

    await waitForXhrCount(1);
    await new Promise(r => setTimeout(r, 0));
    expect(MockXHR.instances.length).toBe(1);
    expect(MockXHR.instances[0].url).toBe(BLOSSOM_SERVERS[0] + '/upload');

    MockXHR.instances[0].status = 200;
    MockXHR.instances[0].responseText = JSON.stringify({url: 'https://solo.example/z', sha256: 'ghi'});
    MockXHR.instances[0].onload?.();

    const result = await promise;
    expect(result.mirrors).toEqual(['https://solo.example/z']);
  });
});
