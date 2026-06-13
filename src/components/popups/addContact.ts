/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import type {AppManagers} from '@lib/managers';

export interface ShowAddContactOptions {
  managers: AppManagers;
  /**
   * Optional handler invoked when the user submits a valid npub. Receives the
   * raw `npub1...` string and the (possibly empty) nickname. When provided,
   * the popup delegates all side-effects (peer mapping, Worker injection,
   * dialog dispatch, chat opening) to this callback — this is how the
   * Contacts tab preserves its existing `handleNpubInput` behavior.
   *
   * When omitted, a built-in default is used that mirrors the core steps
   * (decode, map, store nickname, open chat).
   */
  onSubmit?: (npub: string, nickname: string) => Promise<void>;
  onContactAdded?: (peerId: PeerId) => void;
}

/**
 * Show the Add Contact modal popup. Extracted from AppContactsTab so both
 * the Contacts tab and the FAB pencil menu can open it without coupling.
 */
export function showAddContactPopup(opts: ShowAddContactOptions): void {
  const {managers, onSubmit, onContactAdded} = opts;

  const overlay = document.createElement('div');
  overlay.classList.add('popup-add-contact-overlay');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);z-index:1000;display:flex;align-items:center;justify-content:center;';

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:var(--surface-color);border-radius:12px;padding:24px;width:340px;max-width:90vw;';

  const title = document.createElement('h3');
  title.textContent = 'Add Contact';
  title.style.cssText = 'margin:0 0 16px;font-size:18px;color:var(--primary-text-color);';

  const desc = document.createElement('p');
  desc.textContent = 'Enter an npub address to start a conversation';
  desc.style.cssText = 'margin:0 0 16px;font-size:14px;color:var(--secondary-text-color);';

  const nicknameInput = document.createElement('input');
  nicknameInput.type = 'text';
  nicknameInput.placeholder = 'Nickname (optional)';
  nicknameInput.classList.add('input-clear');
  nicknameInput.style.cssText = 'width:100%;padding:12px;border:1px solid var(--border-color);border-radius:8px;font-size:14px;box-sizing:border-box;background:var(--surface-color);color:var(--primary-text-color);margin-bottom:8px;';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'npub1...';
  input.classList.add('input-clear');
  input.style.cssText = 'width:100%;padding:12px;border:1px solid var(--border-color);border-radius:8px;font-size:14px;box-sizing:border-box;background:var(--surface-color);color:var(--primary-text-color);';

  const errorEl = document.createElement('div');
  errorEl.style.cssText = 'color:var(--danger-color);font-size:12px;margin-top:8px;min-height:18px;';

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:16px;justify-content:flex-end;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.classList.add('btn-primary', 'btn-transparent');
  cancelBtn.style.cssText = 'padding:8px 16px;border:none;border-radius:8px;cursor:pointer;font-size:14px;';
  cancelBtn.addEventListener('click', () => overlay.remove());

  const addBtn = document.createElement('button');
  addBtn.textContent = 'Add';
  addBtn.classList.add('btn-primary', 'btn-color-primary');
  addBtn.style.cssText = 'padding:8px 16px;border:none;border-radius:8px;cursor:pointer;font-size:14px;color:#fff;';
  addBtn.addEventListener('click', async() => {
    const val = input.value.trim();
    if(!val.startsWith('npub1') || val.length < 60) {
      errorEl.textContent = 'Invalid npub format';
      return;
    }
    addBtn.disabled = true;
    addBtn.textContent = 'Adding...';
    try {
      if(onSubmit) {
        await onSubmit(val, nicknameInput.value);
      } else {
        await addNpubContact(managers, val, nicknameInput.value, onContactAdded);
      }
      overlay.remove();
    } catch(err) {
      console.error('[AddContactPopup]', err);
      errorEl.textContent = 'Failed to add contact';
      addBtn.disabled = false;
      addBtn.textContent = 'Add';
    }
  });

  // Scan QR — launches fullscreen camera overlay, decodes via jsQR.
  const qrBtn = document.createElement('button');
  qrBtn.textContent = 'Scan QR';
  qrBtn.classList.add('btn-primary', 'btn-transparent');
  qrBtn.setAttribute('data-testid', 'add-contact-scan-qr');
  qrBtn.style.cssText = 'padding:8px 16px;border:none;border-radius:8px;cursor:pointer;font-size:14px;';
  qrBtn.addEventListener('click', async() => {
    try {
      const {launchQRScanner} = await import('@components/nostra/QRScanner');
      launchQRScanner({
        onDetected: (npub: string) => {
          input.value = npub;
          nicknameInput.focus();
          errorEl.textContent = '';
        }
      });
    } catch(err) {
      console.error('[AddContactPopup] QRScanner load failed', err);
      errorEl.textContent = 'Scanner unavailable';
    }
  });

  overlay.addEventListener('click', (e) => {
    if(e.target === overlay) overlay.remove();
  });

  btnRow.append(qrBtn, cancelBtn, addBtn);
  dialog.append(title, desc, nicknameInput, input, errorEl, btnRow);
  overlay.append(dialog);
  document.body.append(overlay);
  input.focus();
}

/**
 * Default npub → peer resolution used when the caller does not supply an
 * `onSubmit` override. Delegates to the canonical `addP2PContact` helper
 * which ensures mirrors, Worker state, message-store, dialog and ChatAPI
 * are all consistent before the chat is opened.
 */
async function addNpubContact(
  _managers: AppManagers,
  npub: string,
  nickname: string,
  onContactAdded?: (peerId: PeerId) => void
): Promise<void> {
  const {addP2PContact} = await import('@lib/nostra/add-p2p-contact');
  const result = await addP2PContact({
    pubkey: npub,
    nickname,
    openChat: true,
    source: 'add-contact-popup'
  });
  onContactAdded?.(result.peerIdTweb);
}
