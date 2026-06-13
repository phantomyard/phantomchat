import {createSignal, onCleanup, onMount, Show} from 'solid-js';
import {render} from 'solid-js/web';
import {parseQRPayload} from '@lib/nostra/qr-payload';
import {toast} from '@components/toast';
import styles from './key-exchange.module.scss';

export interface QRScannerProps {
  onDetected: (npub: string) => void;
  onClose?: () => void;
}

type ScannerState =
  | {kind: 'loading'}
  | {kind: 'scanning'}
  | {kind: 'denied'}
  | {kind: 'nocamera'};

const TOAST_DEBOUNCE_MS = 1500;

function QRScannerComponent(props: QRScannerProps) {
  const [state, setState] = createSignal<ScannerState>({kind: 'loading'});
  const [errorFlash, setErrorFlash] = createSignal(false);
  // videoEl and canvasEl are rendered unconditionally (hidden via CSS when
  // not scanning) so the refs are always available before getUserMedia
  // resolves — gating them behind <Show> defeats the ordering.
  let videoEl: HTMLVideoElement | undefined;
  let canvasEl: HTMLCanvasElement | undefined;
  let stream: MediaStream | null = null;
  let rafId: number | null = null;
  let detected = false;
  let flashTimeout: ReturnType<typeof setTimeout> | undefined;
  let unmounted = false;
  let lastToastTime = 0;
  let escapeHandler: ((e: KeyboardEvent) => void) | null = null;

  const stopTracks = () => {
    if(stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  };

  // cleanup is idempotent — called by onCleanup (Solid unmount), close(),
  // and on successful detection. The guards ensure repeated calls are safe.
  const cleanup = () => {
    unmounted = true;
    if(rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    stopTracks();
    if(flashTimeout) clearTimeout(flashTimeout);
    if(escapeHandler) {
      document.removeEventListener('keydown', escapeHandler);
      escapeHandler = null;
    }
  };

  const close = () => {
    cleanup();
    props.onClose?.();
  };

  const flashError = () => {
    setErrorFlash(true);
    if(flashTimeout) clearTimeout(flashTimeout);
    flashTimeout = setTimeout(() => setErrorFlash(false), 400);
  };

  const debouncedToast = (msg: string) => {
    const now = Date.now();
    if(now - lastToastTime < TOAST_DEBOUNCE_MS) return;
    lastToastTime = now;
    toast(msg);
  };

  onMount(async() => {
    escapeHandler = (e: KeyboardEvent) => {
      if(e.key === 'Escape') close();
    };
    document.addEventListener('keydown', escapeHandler);

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {facingMode: 'environment'}
      });
    } catch(err: any) {
      if(err?.name === 'NotAllowedError') {
        setState({kind: 'denied'});
        return;
      }
      if(err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') {
        try {
          stream = await navigator.mediaDevices.getUserMedia({video: true});
        } catch(_) {
          setState({kind: 'nocamera'});
          return;
        }
      } else {
        setState({kind: 'nocamera'});
        return;
      }
    }

    if(unmounted || !stream || !videoEl) {
      stopTracks();
      return;
    }
    videoEl.srcObject = stream;
    try {
      await videoEl.play();
    } catch(err) {
      console.warn('[QRScanner] video.play() failed', err);
    }
    if(unmounted) {
      stopTracks();
      return;
    }
    setState({kind: 'scanning'});

    let jsQR: typeof import('jsqr').default;
    try {
      jsQR = (await import('jsqr')).default;
    } catch(err) {
      console.error('[QRScanner] jsqr load failed', err);
      if(!unmounted) {
        toast('Failed to load QR decoder');
        close();
      }
      return;
    }
    if(unmounted) return;

    const tick = () => {
      if(detected || unmounted || !videoEl || !canvasEl) return;
      if(videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
        const ctx = canvasEl.getContext('2d', {willReadFrequently: true});
        if(!ctx) return;
        if(canvasEl.width !== videoEl.videoWidth) canvasEl.width = videoEl.videoWidth;
        if(canvasEl.height !== videoEl.videoHeight) canvasEl.height = videoEl.videoHeight;
        ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
        const imageData = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert'
        });
        if(code) {
          const result = parseQRPayload(code.data);
          if('npub' in result) {
            detected = true;
            cleanup();
            // Toast gives the user visible confirmation that the scan
            // succeeded — without it the overlay just disappears and the
            // detection can feel like nothing happened.
            toast('QR code detected');
            try {
              props.onDetected(result.npub);
            } finally {
              props.onClose?.();
            }
            return;
          }
          if(result.error === 'self') {
            debouncedToast('That\'s your own QR');
            flashError();
          } else if(result.error === 'unsupported') {
            debouncedToast('Hex pubkeys are not supported — scan an npub QR');
            flashError();
          } else {
            debouncedToast('Not a Nostr QR code');
            flashError();
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  });

  onCleanup(cleanup);

  const isScanning = () => state().kind === 'scanning';

  return (
    <div
      class={styles.scannerOverlay}
      data-testid="qr-scanner-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Scan QR code"
    >
      <button class={styles.scannerClose} onClick={close} aria-label="Close scanner">✕</button>

      <video
        ref={videoEl}
        class={styles.scannerVideo}
        autoplay
        playsinline
        muted
        style={{display: isScanning() ? 'block' : 'none'}}
      />
      <canvas ref={canvasEl} style="display:none" />

      <Show when={isScanning()}>
        <div
          class={styles.scannerViewfinder}
          classList={{[styles.scannerViewfinderError]: errorFlash()}}
        />
        <div class={styles.scannerHint}>Point camera at QR code</div>
      </Show>

      <Show when={state().kind === 'denied'}>
        <div class={styles.scannerError}>
          <div>Camera access denied</div>
          <div style="font-size:13px;opacity:0.7;margin-top:8px;">Enable camera permission in your browser settings and try again.</div>
          <button onClick={close}>Close</button>
        </div>
      </Show>

      <Show when={state().kind === 'nocamera'}>
        <div class={styles.scannerError}>
          <div>No camera found</div>
          <button onClick={close}>Close</button>
        </div>
      </Show>

      <Show when={state().kind === 'loading'}>
        <div class={styles.scannerError}>
          <div>Starting camera…</div>
        </div>
      </Show>
    </div>
  );
}

/**
 * Imperatively launch the QR scanner overlay. Returns a disposer that
 * unmounts it. The scanner also unmounts itself on detection or close.
 */
export function launchQRScanner(props: QRScannerProps): () => void {
  const host = document.createElement('div');
  document.body.append(host);

  let disposed = false;
  const dispose = render(
    () => (
      <QRScannerComponent
        onDetected={props.onDetected}
        onClose={() => {
          props.onClose?.();
          if(disposed) return;
          disposed = true;
          dispose();
          host.remove();
        }}
      />
    ),
    host
  );

  return () => {
    if(disposed) return;
    disposed = true;
    dispose();
    host.remove();
  };
}

export default QRScannerComponent;
