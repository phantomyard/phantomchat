/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import type {AppManagers} from '@lib/managers';
import {toast} from '@components/toast';

export interface ShowEditContactOptions {
  peerId: PeerId;
  rawId: number;
  currentName?: string;
  managers: AppManagers;
  onSave?: (displayName: string) => void;
}

/**
 * Show the Edit Contact modal popup for renaming P2P or MTProto contacts.
 */
export async function showEditContactPopup(opts: ShowEditContactOptions): Promise<void> {
  const {peerId, rawId, currentName = '', managers, onSave} = opts;

  // Attempt to resolve name if not provided
  let initialName = currentName;
  if(!initialName) {
    try {
      const user = await managers.appUsersManager.getUser(peerId.toUserId());
      initialName = [user?.first_name, user?.last_name].filter(Boolean).join(' ');
    } catch{
      // ignore
    }
  }

  const overlay = document.createElement('div');
  overlay.classList.add('popup-edit-contact-overlay');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);z-index:1000;display:flex;align-items:center;justify-content:center;';

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:var(--surface-color);border-radius:12px;padding:24px;width:340px;max-width:90vw;box-shadow:0 12px 32px rgba(0,0,0,.25);';

  const title = document.createElement('h3');
  title.textContent = 'Edit Contact';
  title.style.cssText = 'margin:0 0 12px;font-size:18px;font-weight:600;color:var(--primary-text-color);';

  const desc = document.createElement('p');
  desc.textContent = 'Update the contact name';
  desc.style.cssText = 'margin:0 0 16px;font-size:14px;color:var(--secondary-text-color);';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = initialName;
  nameInput.placeholder = 'Contact name';
  nameInput.classList.add('input-clear');
  nameInput.style.cssText = 'width:100%;padding:12px;border:1px solid var(--border-color);border-radius:8px;font-size:14px;box-sizing:border-box;background:var(--surface-color);color:var(--primary-text-color);';

  const errorEl = document.createElement('div');
  errorEl.style.cssText = 'color:var(--danger-color);font-size:12px;margin-top:8px;min-height:18px;';

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:16px;justify-content:flex-end;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.classList.add('btn-primary', 'btn-transparent');
  cancelBtn.style.cssText = 'padding:8px 16px;border:none;border-radius:8px;cursor:pointer;font-size:14px;';
  cancelBtn.addEventListener('click', () => overlay.remove());

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  saveBtn.classList.add('btn-primary', 'btn-color-primary');
  saveBtn.style.cssText = 'padding:8px 16px;border:none;border-radius:8px;cursor:pointer;font-size:14px;color:#fff;';

  const doSave = async() => {
    const trimmed = nameInput.value.trim();
    if(!trimmed) {
      errorEl.textContent = 'Name cannot be empty';
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      const isP2P = rawId >= 1e15;
      if(isP2P) {
        const {renameP2PContact} = await import('@lib/phantomchat/rename-p2p-contact');
        await renameP2PContact(Number(peerId), trimmed);
      } else {
        await managers.appUsersManager.addContact(peerId.toUserId(), trimmed, '', '', false);
      }

      onSave?.(trimmed);
      toast('Contact updated');
      overlay.remove();
    } catch(err) {
      console.error('[showEditContactPopup] Save failed:', err);
      errorEl.textContent = 'Failed to update contact';
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  };

  saveBtn.addEventListener('click', doSave);
  nameInput.addEventListener('keydown', (e) => {
    if(e.key === 'Enter') {
      e.preventDefault();
      doSave();
    } else if(e.key === 'Escape') {
      overlay.remove();
    }
  });

  overlay.addEventListener('click', (e) => {
    if(e.target === overlay) {
      overlay.remove();
    }
  });

  btnRow.append(cancelBtn, saveBtn);
  dialog.append(title, desc, nameInput, errorEl, btnRow);
  overlay.append(dialog);
  document.body.append(overlay);

  setTimeout(() => {
    nameInput.focus();
    nameInput.select();
  }, 50);
}
