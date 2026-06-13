import {createSignal, Show} from 'solid-js';
import classNames from '@helpers/string/classNames';
import {decodePubkey} from '@lib/nostra/nostr-identity';
import {NostraBridge} from '@lib/nostra/nostra-bridge';
import QRScanner from './QRScanner';

export default function AddContact(props: {
  onClose: () => void;
  class?: string;
}) {
  const [view, setView] = createSignal<'menu' | 'scan' | 'paste'>('menu');
  const [pasteValue, setPasteValue] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [nickname, setNickname] = createSignal('');

  const addContact = async(npubOrHex: string) => {
    setLoading(true);
    setError(null);

    let pubkeyHex: string;
    try {
      pubkeyHex = decodePubkey(npubOrHex);
    } catch(err) {
      setError('Invalid npub format');
      setLoading(false);
      return;
    }

    // Validate hex pubkey format (64 hex chars)
    if(!/^[0-9a-f]{64}$/i.test(pubkeyHex)) {
      setError('Invalid npub format');
      setLoading(false);
      return;
    }

    try {
      const bridge = NostraBridge.getInstance();

      // Create synthetic user and store mapping
      const peerId = await bridge.mapPubkeyToPeerId(pubkeyHex);
      const userNickname = nickname().trim() || undefined;
      const user = bridge.createSyntheticUser(pubkeyHex, peerId, userNickname);
      await bridge.storePeerMapping(pubkeyHex, peerId, userNickname);

      // Close dialog
      props.onClose();

      // Navigate to chat with this peer
      try {
        const appImManager = (await import('@lib/appImManager')).default;
        appImManager.setPeer({peerId: peerId as any});
      } catch(navErr) {
        console.warn('Navigation to chat failed:', navErr);
      }
    } catch(err) {
      setError('Failed to add contact');
      setLoading(false);
    }
  };

  const handleScan = (data: string) => {
    setError(null);
    // Validate scanned data as npub
    try {
      decodePubkey(data);
      addContact(data);
    } catch(err) {
      setError('Invalid QR code \u2014 expected a Nostr npub');
      setView('menu');
    }
  };

  const handlePasteSubmit = () => {
    const value = pasteValue().trim();
    if(!value) {
      setError('Please enter an npub or hex pubkey');
      return;
    }
    addContact(value);
  };

  return (
    <div class={classNames('nostra-add-contact', props.class)}>
      <div class="nostra-add-contact-header">
        <button
          class="nostra-add-contact-close"
          onClick={() => {
            if(view() !== 'menu') {
              setView('menu');
              setError(null);
            } else {
              props.onClose();
            }
          }}
        >
          {view() === 'menu' ? 'X' : '<'}
        </button>
        <h3 class="nostra-add-contact-title">Add Contact</h3>
      </div>

      <Show when={error()}>
        <div class="nostra-add-contact-error">
          {error()}
        </div>
      </Show>

      <Show when={view() === 'menu'}>
        <div class="nostra-add-contact-menu">
          <button
            class="nostra-add-contact-option"
            onClick={() => {
              setError(null);
              setView('scan');
            }}
          >
            Scan QR Code
          </button>
          <button
            class="nostra-add-contact-option"
            onClick={() => {
              setError(null);
              setView('paste');
            }}
          >
            Paste npub
          </button>
        </div>
      </Show>

      <Show when={view() === 'scan'}>
        <QRScanner
          onDetected={handleScan}
          onClose={() => setView('menu')}
        />
      </Show>

      <Show when={view() === 'paste'}>
        <div class="nostra-add-contact-paste">
          <input
            type="text"
            class="nostra-add-contact-input"
            placeholder="Nickname (optional)"
            value={nickname()}
            onInput={(e) => {
              setNickname(e.currentTarget.value);
            }}
          />
          <input
            type="text"
            class="nostra-add-contact-input"
            placeholder="npub1... or hex pubkey"
            value={pasteValue()}
            onInput={(e) => {
              setPasteValue(e.currentTarget.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if(e.key === 'Enter') handlePasteSubmit();
            }}
          />
          <button
            class="nostra-add-contact-submit"
            onClick={handlePasteSubmit}
            disabled={loading()}
          >
            {loading() ? 'Adding...' : 'Add'}
          </button>
        </div>
      </Show>
    </div>
  );
}
