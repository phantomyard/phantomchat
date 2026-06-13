import rootScope from '@lib/rootScope';
import {toast} from '@components/toast';

// `confirmationPopup` is imported lazily inside `showResetLocalDataPopup`:
// its transitive graph (PopupElement → PopupPeer) creates a circular-init
// chain that would TDZ-throw when this file is pulled in at boot (for
// `maybeShowResetToast` below).

const RESET_FLAG_KEY = 'nostra-just-reset';

function createOverlay(text: string): HTMLDivElement {
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:9999',
    'display:flex', 'align-items:center', 'justify-content:center',
    'background:rgba(0,0,0,0.7)', 'color:#fff', 'font-size:1.25rem',
    'font-family:inherit', 'backdrop-filter:blur(8px)'
  ].join(';');
  overlay.textContent = text;
  document.body.appendChild(overlay);
  return overlay;
}

export default async function showResetLocalDataPopup() {
  const {default: confirmationPopup} = await import('@components/confirmationPopup');
  confirmationPopup({
    title: 'Reset Local Data',
    descriptionRaw: 'This will delete all messages, contacts, relays, and settings. Your seed will be kept — if you set a passphrase, you\'ll be asked for it on restart. Continue?',
    button: {
      text: document.createTextNode('Reset'),
      isDanger: true
    }
  }).then(async() => {
    const overlay = createOverlay('Resetting…');

    // 1. Wipe Nostra data (keeping the seed)
    let failed: string[] = [];
    try {
      const {clearAllExceptSeed} = await import('@lib/nostra/nostra-cleanup');
      failed = await clearAllExceptSeed();
    } catch(err) {
      console.warn('[Nostra.chat] reset error:', err);
      failed = ['unknown'];
    }

    if(failed.length > 0) {
      console.warn('[Nostra.chat] failed to delete:', failed.join(', '));
      overlay.textContent = 'Reset incomplete — reloading…';
    } else {
      overlay.textContent = 'Local data reset — reloading…';
    }

    // 2. Set marker so boot shows a confirmation toast
    try {
      sessionStorage.setItem(RESET_FLAG_KEY, '1');
    } catch{}

    // 3. Standard tweb logout path, but keep the Nostra seed
    rootScope.managers.apiManager.logOut(undefined, {keepNostraIdentity: true});

    // 4. Safety reload if the normal flow doesn't fire
    setTimeout(() => {
      location.href = location.origin;
    }, 4000);
  }).catch(() => {
    // User canceled — no-op
  });
}

/**
 * Called once at boot. If the previous page triggered a Reset Local Data,
 * shows a confirmation toast and clears the marker.
 */
export function maybeShowResetToast(): void {
  try {
    if(sessionStorage.getItem(RESET_FLAG_KEY) === '1') {
      sessionStorage.removeItem(RESET_FLAG_KEY);
      toast('Local data reset');
    }
  } catch{}
}
