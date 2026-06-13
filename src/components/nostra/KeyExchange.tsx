import {createEffect, createSignal, onCleanup, Show} from 'solid-js';
import type QRCodeStylingType from 'qr-code-styling';
import classNames from '@helpers/string/classNames';
import useNostraIdentity from '@stores/nostraIdentity';
import {getAvatarForQR} from '@lib/nostra/avatar-for-qr';
import styles from './key-exchange.module.scss';

export interface KeyExchangeProps {
  class?: string;
  onScanClick?: () => void;
}

const QR_SIZE = 280;

export default function KeyExchange(props: KeyExchangeProps) {
  const {npub, displayName, nip05, picture} = useNostraIdentity();
  const [copied, setCopied] = createSignal(false);
  let qrContainer: HTMLDivElement | undefined;
  let qrInstance: QRCodeStylingType | null = null;
  let copiedTimeout: ReturnType<typeof setTimeout> | undefined;

  createEffect(() => {
    const currentNpub = npub();
    const currentPicture = picture();
    if(!currentNpub || !qrContainer) return;
    const container = qrContainer;

    (async() => {
      const avatarURL = await getAvatarForQR(currentNpub, currentPicture);
      if(qrContainer !== container) return; // unmounted while awaiting

      const {default: QRCodeStyling} = await import('qr-code-styling' as any);
      if(qrContainer !== container) return;

      container.replaceChildren();
      qrInstance = new QRCodeStyling({
        width: QR_SIZE,
        height: QR_SIZE,
        data: 'nostr:' + currentNpub,
        image: avatarURL,
        imageOptions: {
          crossOrigin: 'anonymous',
          margin: 6,
          imageSize: 0.25,
          hideBackgroundDots: true
        },
        qrOptions: {
          errorCorrectionLevel: 'H'
        },
        dotsOptions: {
          color: '#1a1a2e',
          type: 'rounded'
        },
        cornersSquareOptions: {
          type: 'extra-rounded'
        },
        backgroundOptions: {
          color: '#ffffff'
        }
      });

      qrInstance.append(container);
    })();
  });

  onCleanup(() => {
    if(copiedTimeout) clearTimeout(copiedTimeout);
    qrInstance = null;
    if(qrContainer) qrContainer.replaceChildren();
    qrContainer = undefined;
  });

  const handleCopy = async() => {
    const currentNpub = npub();
    if(!currentNpub) return;
    try {
      await navigator.clipboard.writeText(currentNpub);
      setCopied(true);
      copiedTimeout = setTimeout(() => setCopied(false), 2000);
    } catch(err) {
      console.warn('[KeyExchange] copy failed', err);
    }
  };

  const handleShare = async() => {
    const instance = qrInstance;
    if(!instance) return;
    try {
      if(typeof navigator.share === 'function') {
        const blob = await instance.getRawData('png');
        if(blob) {
          const file = new File([blob as BlobPart], 'nostra-qr.png', {type: 'image/png'});
          await navigator.share({
            title: 'My Nostra.chat QR',
            text: npub() || '',
            files: [file]
          });
          return;
        }
      }
      instance.download({name: 'nostra-qr', extension: 'png'});
    } catch(err) {
      // User cancelled the native share sheet — do nothing
      if((err as {name?: string})?.name === 'AbortError') return;
      try {
        instance.download({name: 'nostra-qr', extension: 'png'});
      } catch(fallbackErr) {
        console.warn('[KeyExchange] share/download failed', err, fallbackErr);
      }
    }
  };

  const handleScan = async() => {
    if(props.onScanClick) {
      props.onScanClick();
      return;
    }
    const {launchQRScanner} = await import('./QRScanner');
    launchQRScanner({
      onDetected: async(scannedNpub) => {
        try {
          const {addP2PContact} = await import('@lib/nostra/add-p2p-contact');
          await addP2PContact({
            pubkey: scannedNpub,
            openChat: true,
            source: 'key-exchange-scan'
          });
        } catch(err) {
          console.error('[KeyExchange] failed to open scanned peer', err);
        }
      }
    });
  };

  const truncateNpub = (value: string): string => {
    if(value.length <= 16) return value;
    return value.slice(0, 10) + '...' + value.slice(-6);
  };

  return (
    <div class={classNames(styles.wrap, props.class)}>
      <div class={styles.qr} ref={qrContainer} data-testid="qr-container" />

      <div class={styles.info}>
        <div class={styles.name}>
          {displayName() || truncateNpub(npub() || '')}
        </div>
        <Show when={nip05()}>
          <div class={styles.nip05}>
            <span>&#10003;</span>
            <span>{nip05()}</span>
          </div>
        </Show>
      </div>

      <div class={styles.actions}>
        <button onClick={handleCopy}>
          {copied() ? 'Copied!' : 'Copy npub'}
        </button>
        <button onClick={handleShare}>Share QR</button>
      </div>

      <div class={styles.divider}>or scan</div>

      <button
        class={styles.scanBtn}
        data-testid="scan-btn"
        onClick={handleScan}
      >
        Scan QR
      </button>
    </div>
  );
}
