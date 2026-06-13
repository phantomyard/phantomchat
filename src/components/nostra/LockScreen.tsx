/*
 * Nostra.chat -- Lock Screen
 *
 * Full-screen overlay that blocks the app when PIN or passphrase
 * protection is active. Renders on top of everything when isLocked
 * is true in the identity store.
 */

import {JSX, Show, createSignal} from 'solid-js';
import useNostraIdentity from '@stores/nostraIdentity';
import rootScope from '@lib/rootScope';
import {
  deriveKeyFromPin,
  deriveKeyFromPassphrase,
  decryptKeys,
  loadEncryptedIdentity
} from '@lib/nostra/key-storage';
import {clearConversationKeyCache} from '@lib/nostra/nostr-crypto';

export default function LockScreen(): JSX.Element {
  const identity = useNostraIdentity();
  const [error, setError] = createSignal('');
  const [input, setInput] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [shaking, setShaking] = createSignal(false);

  const protType = () => identity.protectionType();
  const isPin = () => protType() === 'pin';

  async function handleSubmit() {
    const value = input().trim();
    if(!value) return;

    setLoading(true);
    setError('');

    try {
      const record = await loadEncryptedIdentity();
      if(!record || !record.salt) {
        setError('No encrypted identity found');
        setLoading(false);
        return;
      }

      const key = isPin() ?
        await deriveKeyFromPin(value, record.salt) :
        await deriveKeyFromPassphrase(value, record.salt);

      const decrypted = await decryptKeys(record.iv, record.encryptedKeys, key);

      // Success: dispatch unlock event
      rootScope.dispatchEvent('nostra_identity_unlocked', {
        npub: record.npub
      });

      setInput('');
    } catch{
      setError(isPin() ? 'Incorrect PIN' : 'Incorrect passphrase');
      setShaking(true);
      setInput('');
      setTimeout(() => setShaking(false), 500);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if(e.key === 'Enter') {
      handleSubmit();
    }
  }

  function handleForgotPin() {
    // Navigate to recovery — dispatches event that security settings can handle
    rootScope.dispatchEvent('nostra_recovery_requested', undefined);
  }

  // Clear conversation key cache when lock screen is shown
  clearConversationKeyCache();

  return (
    <Show when={identity.isLocked()}>
      <div class="lock-screen">
        <div class="lock-screen__content">
          <div class="lock-screen__logo">
            <h1 class="lock-screen__title">Nostra.chat</h1>
          </div>

          <div class={`lock-screen__input-area ${shaking() ? 'lock-screen__input-area--shake' : ''}`}>
            <Show when={isPin()} fallback={
              <input
                type="password"
                class="lock-screen__passphrase-input"
                placeholder="Enter passphrase"
                value={input()}
                onInput={(e) => setInput(e.currentTarget.value)}
                onKeyDown={handleKeyDown}
                disabled={loading()}
              />
            }>
              <input
                type="tel"
                inputMode="numeric"
                class="lock-screen__pin-input"
                placeholder="Enter PIN"
                pattern="[0-9]*"
                maxLength={6}
                value={input()}
                onInput={(e) => {
                  const val = e.currentTarget.value.replace(/\D/g, '');
                  setInput(val);
                  e.currentTarget.value = val;
                }}
                onKeyDown={handleKeyDown}
                disabled={loading()}
              />
            </Show>

            <Show when={error()}>
              <div class="lock-screen__error">{error()}</div>
            </Show>
          </div>

          <button
            class="lock-screen__submit btn-primary btn-color-primary"
            onClick={handleSubmit}
            disabled={loading() || !input().trim()}
          >
            {loading() ? 'Unlocking...' : 'Unlock'}
          </button>

          <button
            class="lock-screen__forgot btn-transparent"
            onClick={handleForgotPin}
          >
            Forgot PIN/Passphrase?
          </button>
        </div>
      </div>
    </Show>
  );
}
