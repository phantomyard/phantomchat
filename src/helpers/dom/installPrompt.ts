let callback: () => Promise<void>;
let availabilityListeners: Array<() => void> = [];

function notifyAvailable() {
  const listeners = availabilityListeners;
  availabilityListeners = [];
  listeners.forEach((listener) => {
    try {
      listener();
    } catch(err) {
      console.warn('[InstallPrompt] availability listener failed', err);
    }
  });
}

export default function cacheInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (deferredPrompt: any) => {
    // Suppress the browser's default mini-infobar so we can surface our own
    // tasteful install modal / button instead.
    deferredPrompt.preventDefault?.();

    callback = async() => {
      deferredPrompt.prompt();
      const {outcome} = await deferredPrompt.userChoice;
      const installed = outcome === 'accepted';
      if(installed) {
        callback = undefined;
      }
    };

    notifyAvailable();
  });

  // Once the PWA is installed the prompt is no longer valid.
  window.addEventListener('appinstalled', () => {
    callback = undefined;
  });
}

export function getInstallPrompt() {
  return callback;
}

/**
 * A real one-tap install is only possible once Chromium has fired
 * `beforeinstallprompt` (valid manifest + service worker + eligibility).
 * That can arrive after boot, so callers register here to be told the moment
 * a genuine install becomes available. If it's already available the listener
 * fires immediately.
 */
export function onInstallPromptAvailable(listener: () => void) {
  if(callback) {
    listener();
    return;
  }

  availabilityListeners.push(listener);
}
