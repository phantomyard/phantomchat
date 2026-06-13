import rootScope from '@lib/rootScope';
import confirmationPopup from '@components/confirmationPopup';

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

    // 1. Close connections + delete Nostra databases (main thread)
    let failed: string[] = [];
    try {
      const {clearAllNostraData} = await import('@lib/nostra/nostra-cleanup');
      failed = await clearAllNostraData();
    } catch(err) {
      console.warn('[Nostra.chat] cleanup error:', err);
      failed = ['unknown'];
    }

    if(failed.length > 0) {
      console.warn('[Nostra.chat] failed to delete:', failed.join(', '));
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
