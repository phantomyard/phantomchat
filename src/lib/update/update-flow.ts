import type {Manifest} from '@lib/update/types';
import {UpdateFlowError} from '@lib/update/types';
import {updateTransport} from '@lib/update/update-transport';
import {PromisePool} from '@lib/update/promise-pool';
import {setFlowState} from '@lib/update/update-state-machine';

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return 'sha256-' + Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function downloadAndVerify(
  manifest: Manifest,
  opts: {signal?: AbortSignal; onProgress?: (done: number, total: number) => void} = {}
): Promise<Map<string, ArrayBuffer>> {
  const files = new Map<string, ArrayBuffer>();
  const entries = Object.entries(manifest.bundleHashes);
  const pool = new PromisePool(6);
  let completed = 0;

  await Promise.all(entries.map(([path, expectedHash]) => pool.run(async() => {
    const url = new URL(path, location.origin).href;
    const res = await updateTransport.fetch(url, {cache: 'no-store', signal: opts.signal});
    if(!res.ok) {
      throw new UpdateFlowError({type: 'network-error', err: `HTTP ${res.status} for ${path}`});
    }
    const buf = await res.arrayBuffer();
    const actualHash = await sha256Hex(buf);
    if(actualHash !== expectedHash) {
      throw new UpdateFlowError({type: 'hash-mismatch', path, expected: expectedHash, actual: actualHash});
    }
    files.set(path, buf);
    completed++;
    opts.onProgress?.(completed, entries.length);
  })));

  return files;
}

async function registerNewSw(manifest: Manifest): Promise<ServiceWorkerRegistration> {
  localStorage.setItem('nostra.update.pendingFinalization', '1');
  localStorage.setItem('nostra.update.pendingManifest', JSON.stringify(manifest));

  const swUrl = new URL(manifest.swUrl, location.origin).href;
  setFlowState({kind: 'registering', target: manifest});

  let reg: ServiceWorkerRegistration;
  try {
    reg = await navigator.serviceWorker.register(swUrl, {
      type: 'module',
      scope: './',
      updateViaCache: 'all'
    });
  } catch(err) {
    localStorage.removeItem('nostra.update.pendingFinalization');
    localStorage.removeItem('nostra.update.pendingManifest');
    throw new UpdateFlowError({type: 'register-failed', err: String(err)});
  }

  const newSw = reg.installing || reg.waiting || reg.active;
  if(!newSw) throw new UpdateFlowError({type: 'register-failed', err: 'no worker after register'});

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new UpdateFlowError({type: 'install-timeout'})), 60000);
    const check = () => {
      if(newSw.state === 'installed') { clearTimeout(timer); resolve(); return; }
      if(newSw.state === 'redundant') { clearTimeout(timer); reject(new UpdateFlowError({type: 'install-redundant'})); return; }
    };
    check();
    newSw.addEventListener('statechange', check);
  });

  return reg;
}

async function activateAndReload(manifest: Manifest): Promise<void> {
  setFlowState({kind: 'finalizing', target: manifest});

  const reg = await navigator.serviceWorker.getRegistration();
  const waiting = reg?.waiting;
  if(!waiting) {
    window.location.reload();
    return;
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  }, {once: true});

  waiting.postMessage({type: 'SKIP_WAITING'});

  setTimeout(() => window.location.reload(), 10000);
}

export async function startUpdate(manifest: Manifest, abortController?: AbortController): Promise<void> {
  try {
    setFlowState({
      kind: 'downloading',
      target: manifest,
      completed: 0,
      total: Object.keys(manifest.bundleHashes).length
    });

    await downloadAndVerify(manifest, {
      signal: abortController?.signal,
      onProgress: (done, total) => {
        setFlowState({kind: 'downloading', target: manifest, completed: done, total});
      }
    });

    setFlowState({kind: 'verifying', target: manifest});

    await registerNewSw(manifest);
    await activateAndReload(manifest);
  } catch(err) {
    if(err instanceof UpdateFlowError) {
      setFlowState({kind: 'failed', reason: err.reason, target: manifest});
    } else {
      setFlowState({kind: 'failed', reason: {type: 'network-error', err: String(err)}, target: manifest});
    }
    throw err;
  }
}

export interface SignedUpdateResult {
  ok: boolean;
  outcome?: string;
  reason?: string;
  chunk?: string;
  expected?: string;
  actual?: string;
}

export interface SignedUpdateOptions {
  onProgress?: (done: number, total: number) => void;
}

export async function startUpdateSigned(
  manifest: any,
  signature: string,
  manifestText?: string,
  opts: SignedUpdateOptions = {}
): Promise<SignedUpdateResult> {
  const reg = await navigator.serviceWorker.getRegistration();
  if(!reg || !reg.active) return {ok: false, outcome: 'no-active-sw', reason: 'no-active-sw'};

  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (ev) => {
      if(ev.data?.type === 'UPDATE_PROGRESS') {
        opts.onProgress?.(ev.data.done, ev.data.total);
        return;
      }
      if(ev.data?.type === 'UPDATE_RESULT') {
        const d = ev.data;
        resolve({
          ok: d.outcome === 'applied',
          outcome: d.outcome,
          reason: d.reason,
          chunk: d.chunk,
          expected: d.expected,
          actual: d.actual
        });
      }
    };
    reg.active!.postMessage({type: 'UPDATE_APPROVED', manifest, signature, manifestText}, [channel.port2]);
  });
}
