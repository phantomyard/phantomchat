import {IS_APPLE_MOBILE, IS_FIREFOX} from '@environment/userAgent';
import {getInstallPrompt} from '@helpers/dom/installPrompt';

const BRAND_PRIMARY = 'var(--primary-color, #1f9bdf)';
const OVERLAY_CLASS = 'popup-install-app-overlay';

function makePrimaryButton(label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.classList.add('btn-primary');
  btn.style.cssText = 'width:100%;padding:13px 16px;border:none;border-radius:10px;cursor:pointer;' +
    'font-size:15px;font-weight:600;font-family:inherit;color:#fff;background:' + BRAND_PRIMARY + ';';
  return btn;
}

function makeSecondaryButton(label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.classList.add('btn-primary', 'btn-transparent');
  btn.style.cssText = 'width:100%;padding:13px 16px;border:none;border-radius:10px;cursor:pointer;' +
    'font-size:14px;font-weight:500;font-family:inherit;background:transparent;color:rgba(255,255,255,.6);';
  return btn;
}

function buildInstructions(desc: HTMLElement) {
  desc.style.textAlign = 'left';
  desc.style.margin = '0 0 22px';

  const intro = document.createElement('p');
  intro.style.cssText = 'margin:0 0 12px;font-size:14px;line-height:1.5;color:rgba(255,255,255,.6);text-align:center;';

  if(IS_APPLE_MOBILE) {
    intro.textContent = 'To add PhantomChat to your home screen:';
    const ol = document.createElement('ol');
    ol.style.cssText = 'margin:0;padding-left:20px;font-size:14px;line-height:1.7;color:rgba(255,255,255,.75);';

    const step1 = document.createElement('li');
    const share = document.createElement('strong');
    share.textContent = 'Share';
    step1.append('Tap the ', share, ' icon in Safari.');

    const step2 = document.createElement('li');
    const add = document.createElement('strong');
    add.textContent = '“Add to Home Screen.”';
    step2.append('Choose ', add);

    ol.append(step1, step2);
    desc.append(intro, ol);
    return;
  }

  if(IS_FIREFOX) {
    intro.textContent = 'Firefox doesn’t support one-tap install here. Open the page menu (⋮) and choose “Install” or “Add to Home screen,” if your version offers it.';
  } else {
    intro.textContent = 'Your browser doesn’t offer one-tap install on this page. Look for an “Install” or “Add to Home screen” option in your browser menu.';
  }

  desc.append(intro);
}

/**
 * Tasteful, true-black "Install PhantomChat" modal.
 *
 * Mode is decided by whether a real one-tap install is available:
 *  - install mode (Chromium, eligible) → a primary button that fires the
 *    native install prompt. This is the only path that's auto-shown on landing.
 *  - instructions mode (iOS / Firefox / ineligible) → manual steps. Only
 *    reachable on demand via the "Install app" menu button.
 */
export function showInstallAppPopup(): void {
  // Never stack duplicates.
  if(document.querySelector('.' + OVERLAY_CLASS)) {
    return;
  }

  const installPrompt = getInstallPrompt();

  const overlay = document.createElement('div');
  overlay.classList.add(OVERLAY_CLASS);
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:1000;' +
    'display:flex;align-items:center;justify-content:center;padding:16px;';

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:#000;border:1px solid rgba(255,255,255,.12);border-radius:16px;' +
    'padding:28px 24px;width:380px;max-width:92vw;max-height:90vh;overflow-y:auto;' +
    'box-shadow:0 20px 60px rgba(0,0,0,.6);text-align:center;';
  dialog.addEventListener('click', (e) => e.stopPropagation());

  const icon = document.createElement('div');
  icon.textContent = '📲';
  icon.style.cssText = 'font-size:44px;line-height:1;margin-bottom:14px;';

  const title = document.createElement('h3');
  title.textContent = 'Install PhantomChat';
  title.style.cssText = 'margin:0 0 8px;font-size:20px;font-weight:600;color:#fff;';

  const desc = document.createElement('p');
  desc.style.cssText = 'margin:0 0 22px;font-size:14px;line-height:1.5;color:rgba(255,255,255,.6);';

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
  };

  function onKeydown(e: KeyboardEvent) {
    if(e.key === 'Escape') {
      close();
    }
  }

  if(installPrompt) {
    desc.textContent = 'Add PhantomChat to your home screen for a faster, full-screen, app-like experience.';

    const installBtn = makePrimaryButton('Install app');
    installBtn.addEventListener('click', async() => {
      installBtn.disabled = true;
      installBtn.style.opacity = '.7';
      try {
        await installPrompt();
      } catch(err) {
        console.warn('[InstallApp] install prompt failed', err);
      }
      close();
    });

    const notNow = makeSecondaryButton('Not now');
    notNow.addEventListener('click', close);

    btnRow.append(installBtn, notNow);
  } else {
    buildInstructions(desc);

    const gotIt = makePrimaryButton('Got it');
    gotIt.addEventListener('click', close);
    btnRow.append(gotIt);
  }

  dialog.append(icon, title, desc, btnRow);
  overlay.append(dialog);
  overlay.addEventListener('click', close); // click backdrop to dismiss
  document.addEventListener('keydown', onKeydown);
  document.body.append(overlay);
}

export default showInstallAppPopup;
