import {createSignal} from 'solid-js';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'update-available'
  | 'accepted'
  | 'downloading'
  | 'verifying'
  | 'swapping'
  | 'done'
  | 'failed';

const VALID: Record<UpdateStatus, UpdateStatus[]> = {
  'idle': ['checking'],
  'checking': ['idle', 'update-available', 'failed'],
  'update-available': ['idle', 'accepted', 'failed'],
  'accepted': ['downloading', 'failed'],
  'downloading': ['verifying', 'failed'],
  'verifying': ['swapping', 'failed'],
  'swapping': ['done', 'failed'],
  'done': ['idle'],
  'failed': ['idle']
};

export function createUpdateState() {
  const [status, setStatus] = createSignal<UpdateStatus>('idle');
  const [pendingManifest, setPendingManifest] = createSignal<any>(null);
  const [pendingSignature, setPendingSignature] = createSignal<string>('');
  const [lastError, setLastError] = createSignal<string>('');
  const [progress, setProgressState] = createSignal<{done: number; total: number}>({done: 0, total: 0});

  function transition(next: UpdateStatus) {
    const cur = status();
    if(!VALID[cur].includes(next)) {
      throw new Error(`Invalid transition: ${cur} → ${next}`);
    }
    setStatus(next);
  }

  return {
    status,
    pendingManifest,
    pendingSignature,
    lastError,
    progress,
    beginCheck() { transition('checking'); },
    setUpdateAvailable(manifest: any, sig: string) {
      setPendingManifest(manifest);
      setPendingSignature(sig);
      transition('update-available');
    },
    accept() { transition('accepted'); },
    beginDownload() { transition('downloading'); },
    beginVerifying() { transition('verifying'); },
    beginSwap() { transition('swapping'); },
    setDone() { transition('done'); },
    setFailed(reason: string) { setLastError(reason); transition('failed'); },
    reset() {
      setPendingManifest(null);
      setPendingSignature('');
      setLastError('');
      setProgressState({done: 0, total: 0});
      transition('idle');
    },
    setProgress(done: number, total: number) { setProgressState({done, total}); }
  };
}

export type UpdateState = ReturnType<typeof createUpdateState>;
