/*
 * Nostra.chat — Profile "NIP-05 Identity" section
 *
 * Extracted from AppEditProfileTab. Owns the alias input, dynamic setup
 * instructions, verify button, and status indicator. Dispatches
 * nostra_identity_updated on successful verification.
 */

import InputField from '@components/inputField';
import SettingSection from '@components/settingSection';
import Button from '@components/button';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import type ListenerSetter from '@helpers/listenerSetter';
import rootScope from '@lib/rootScope';
import {toast} from '@components/toast';
import {decodePubkey} from '@lib/nostra/nostr-identity';
import {verifyNip05, buildNip05Instructions} from '@lib/nostra/nip05';
import type {Nip05Status} from '@lib/nostra/nip05';

export interface Nip05Section {
  /** The SettingSection container to append to the tab's scrollable. */
  container: HTMLElement;
  /** The alias input field — exposed for focus() routing. */
  inputField: InputField;
}

export function createNip05Section(opts: {
  npub: string;
  initialAlias: string;
  listenerSetter: ListenerSetter;
}): Nip05Section {
  const {npub, initialAlias, listenerSetter} = opts;

  const section = new SettingSection({
    name: 'NIP-05 Identity' as any,
    caption: 'Set a human-readable identifier (e.g. alice@example.com)' as any
  });
  section.container.dataset.section = 'nip05';

  const inputField = new InputField({
    label: 'NIP-05 Alias' as any,
    name: 'nip05-alias',
    maxLength: 100,
    plainText: true
  });
  inputField.setOriginalValue(initialAlias, true);

  const instructionsEl = document.createElement('div');
  instructionsEl.classList.add('nip05-instructions');
  updateInstructions(instructionsEl, inputField.value, npub);
  inputField.input.addEventListener('input', () => {
    updateInstructions(instructionsEl, inputField.value, npub);
  });

  const statusEl = document.createElement('div');
  statusEl.classList.add('nip05-status');

  let status: Nip05Status = initialAlias ? 'verified' : 'unverified';
  updateStatusDisplay(statusEl, status);

  const verifyBtn = Button('btn-primary btn-color-primary');
  verifyBtn.textContent = 'Verify';
  attachClickEvent(verifyBtn, async() => {
    const alias = inputField.value.trim();
    if(!alias) { toast('Enter a NIP-05 alias first'); return; }
    const hexPub = npub ? decodePubkey(npub) : null;
    if(!hexPub) { toast('No identity loaded'); return; }

    status = 'verifying';
    updateStatusDisplay(statusEl, status);

    const result = await verifyNip05(alias, hexPub);
    if(result.ok) {
      status = 'verified';
      updateStatusDisplay(statusEl, status);
      rootScope.dispatchEvent('nostra_identity_updated', {nip05: alias});
      toast('NIP-05 verified');
    } else {
      status = 'failed';
      updateStatusDisplay(statusEl, status, result.error);
    }
  }, {listenerSetter});

  section.content.append(inputField.container, instructionsEl, statusEl, verifyBtn);

  return {
    container: section.container,
    inputField
  };
}

function updateInstructions(el: HTMLElement, alias: string, npub: string): void {
  el.textContent = '';
  const atIndex = alias.indexOf('@');
  if(atIndex < 1 || !npub) {
    const hint = document.createElement('p');
    hint.classList.add('nip05-hint');
    hint.textContent = 'Enter a NIP-05 alias above to see setup instructions.';
    el.append(hint);
    return;
  }
  const name = alias.slice(0, atIndex);
  const domain = alias.slice(atIndex + 1);
  const hexPub = decodePubkey(npub);
  const snippet = buildNip05Instructions(name, hexPub);
  const hint = document.createElement('p');
  hint.classList.add('nip05-hint');
  hint.textContent = `Add this to https://${domain}/.well-known/nostr.json:`;
  const pre = document.createElement('pre');
  pre.classList.add('nip05-snippet');
  pre.textContent = snippet;
  el.append(hint, pre);
}

function updateStatusDisplay(el: HTMLElement, status: Nip05Status, errorMsg?: string): void {
  el.className = 'nip05-status';
  switch(status) {
    case 'unverified': el.textContent = ''; break;
    case 'verifying':
      el.classList.add('nip05-status--verifying');
      el.textContent = 'Verifying...';
      break;
    case 'verified':
      el.classList.add('nip05-status--verified');
      el.textContent = 'Verified';
      break;
    case 'failed':
      el.classList.add('nip05-status--failed');
      el.textContent = errorMsg || 'Verification failed';
      break;
  }
}
