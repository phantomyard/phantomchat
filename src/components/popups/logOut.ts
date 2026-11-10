import rootScope from '@lib/rootScope';
import confirmationPopup from '@components/confirmationPopup';

// Longer than the worst-case wipe (push unsubscribe 1.5s + store close 1.5s +
// per-DB delete 3s) plus the 4s the normal logOut reload gets.
const SAFETY_RELOAD_MS = 12000;

function armSafetyReload(ms: number): void {
  setTimeout(() => {
    location.href = location.origin;
  }, ms);
}

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

export default function showLogOutPopup() {
  confirmationPopup({
    titleLangKey: 'LogOut',
    descriptionLangKey: 'LogOut.Description',
    button: {
      langKey: 'LogOut',
      isDanger: true
    }
  }).then(async() => {
    const overlay = createOverlay('Clearing data…');

    // Arm the escape hatch BEFORE the wipe, not after it: if the cleanup ever
    // stalls, the user must not be stuck behind the overlay (#480/#481).
    armSafetyReload(SAFETY_RELOAD_MS);

    // 1. Close connections + delete PhantomChat databases (main thread)
    let failed: string[] = [];
    try {
      const {clearAllPhantomChatData} = await import('@lib/phantomchat/phantomchat-cleanup');
      failed = await clearAllPhantomChatData();
    } catch(err) {
      console.warn('[PhantomChat.chat] cleanup error:', err);
      failed = ['unknown'];
    }

    if(failed.length > 0) {
      console.warn('[PhantomChat.chat] failed to delete:', failed.join(', '));
      overlay.textContent = 'Logout incomplete — reloading…';
    } else {
      overlay.textContent = 'Logged out — reloading…';
    }

    // 2. Standard tweb logout (clears MTProto stores, session, cache → triggers reload)
    rootScope.managers.apiManager.logOut();

    // 3. Safety reload if the normal flow doesn't fire
    setTimeout(() => {
      location.href = location.origin;
    }, 4000);
  });
}
