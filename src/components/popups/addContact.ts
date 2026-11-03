/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import type {AppManagers} from '@lib/managers';
import type {ContactKind} from '@lib/phantomchat/contact-prefs';

/**
 * New-contact modal (contacts redesign). The user first picks what the
 * contact IS, and each type shows only its own fields:
 *
 *   Phantom  — npub (+ Scan, desktop only), Phantom avatar, Contact Name,
 *              Local tools, Notifications
 *   Human    — npub, Human avatar, Contact Name, Notifications
 *   Provider — desktop only: provider, token, model, Phantom avatar,
 *              Contact Name, Local tools, Notifications
 *
 * Scan and Provider need desktop capabilities that ship with the bundled
 * phantombot update; until the desktop app reports them they stay hidden
 * rather than offering a button that cannot work.
 */

export interface AddContactSubmit {
  npub: string;
  nickname: string;
  kind: ContactKind;
  notifications: boolean;
  localTools: boolean;
}

export interface ShowAddContactOptions {
  managers: AppManagers;
  /** Prefill the npub field (e.g. an npub pasted into a search box). */
  npub?: string;
  /** Called with the new contact's peer id once it has been added. */
  onContactAdded?: (peerId: PeerId, displayName: string) => void;
}

type DesktopApi = {
  phantombot?: {call(method: string, params?: Record<string, unknown>): Promise<{ok: boolean}>};
  localPersonas?: unknown;
};

function desktopApi(): DesktopApi | undefined {
  return typeof window !== 'undefined' ? (window as any).phantomchatDesktop : undefined;
}

/** Desktop app with the local-persona scan bridge (ships with the phantombot update). */
export function canScanLocalPersonas(api = desktopApi()): boolean {
  return !!api && typeof (api as any).localPersonas?.list === 'function';
}

/** Desktop app whose bundled engine can list providers (phantombot #753). */
export async function canAddProviders(api = desktopApi()): Promise<boolean> {
  if(!api?.phantombot?.call) return false;
  try {
    const res = await api.phantombot.call('providers.list');
    return !!res?.ok;
  } catch{
    return false;
  }
}

export function isValidNpub(value: string): boolean {
  const v = (value || '').trim();
  return v.startsWith('npub1') && v.length >= 60;
}

const KIND_LABELS: Record<ContactKind, string> = {
  phantom: 'Phantom',
  human: 'Human',
  provider: 'Provider'
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cssText?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if(cssText) node.style.cssText = cssText;
  if(text !== undefined) node.textContent = text;
  return node;
}

const INPUT_CSS = 'width:100%;padding:12px;border:1px solid var(--border-color);border-radius:8px;font-size:14px;box-sizing:border-box;background:var(--surface-color);color:var(--primary-text-color);';
const BTN_CSS = 'padding:8px 16px;border:none;border-radius:8px;cursor:pointer;font-size:14px;';

function makeToggle(label: string, checked: boolean, testId: string) {
  const row = el('label', 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 2px;font-size:14px;color:var(--primary-text-color);cursor:pointer;');
  row.append(el('span', undefined, label));
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute('data-testid', testId);
  row.append(input);
  return {row, input};
}

/**
 * Show the Add Contact modal. Both entry points (tools menu, Contacts tab +)
 * and an npub pasted into a search box open this same modal.
 */
export function showAddContactPopup(opts: ShowAddContactOptions): void {
  const {managers, onContactAdded} = opts;
  // One modal at a time: a search box fires on every keystroke past 60 chars.
  if(document.querySelector('.popup-add-contact-overlay')) return;

  const overlay = el('div', 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);z-index:1000;display:flex;align-items:center;justify-content:center;');
  overlay.classList.add('popup-add-contact-overlay');

  const dialog = el('div', 'background:var(--surface-color);border-radius:12px;padding:24px;width:360px;max-width:90vw;max-height:90vh;overflow:auto;box-sizing:border-box;');
  dialog.setAttribute('data-testid', 'add-contact-dialog');

  const title = el('h3', 'margin:0 0 16px;font-size:18px;color:var(--primary-text-color);', 'New Contact');

  // --- Type selector ---------------------------------------------------
  const segment = el('div', 'display:flex;gap:4px;padding:4px;border-radius:10px;background:var(--light-secondary-text-color, rgba(127,127,127,.12));margin-bottom:16px;');
  segment.setAttribute('role', 'tablist');
  const segButtons = new Map<ContactKind, HTMLButtonElement>();
  let kind: ContactKind = 'phantom';

  const addSegButton = (k: ContactKind) => {
    const b = el('button', BTN_CSS + 'flex:1;padding:8px 6px;background:transparent;color:var(--primary-text-color);', KIND_LABELS[k]);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('data-testid', `add-contact-kind-${k}`);
    b.addEventListener('click', () => setKind(k));
    segButtons.set(k, b);
    segment.append(b);
  };
  addSegButton('phantom');
  addSegButton('human');

  // --- Avatar + name ---------------------------------------------------
  const avatarRow = el('div', 'display:flex;align-items:center;gap:12px;margin-bottom:12px;');
  const avatar = el('img', 'width:64px;height:64px;border-radius:50%;flex:none;background:var(--light-secondary-text-color, rgba(127,127,127,.12));');
  avatar.alt = '';
  avatar.setAttribute('data-testid', 'add-contact-avatar');
  const nameInput = el('input', INPUT_CSS);
  nameInput.type = 'text';
  nameInput.placeholder = 'Contact Name';
  nameInput.maxLength = 70;
  nameInput.classList.add('input-clear');
  nameInput.setAttribute('data-testid', 'add-contact-name');
  avatarRow.append(avatar, nameInput);

  // --- npub row (Phantom + Human) --------------------------------------
  const npubRow = el('div', 'display:flex;gap:8px;align-items:center;');
  const npubInput = el('input', INPUT_CSS + 'flex:1;min-width:0;');
  npubInput.type = 'text';
  npubInput.placeholder = 'npub Key (npub1...)';
  npubInput.classList.add('input-clear');
  npubInput.setAttribute('data-testid', 'add-contact-npub');
  if(opts.npub) npubInput.value = opts.npub.trim();

  // Scan: find phantombot personas installed on this PC (desktop only).
  const scanBtn = el('button', BTN_CSS + 'flex:none;', 'Scan');
  scanBtn.type = 'button';
  scanBtn.classList.add('btn-primary', 'btn-transparent');
  scanBtn.setAttribute('data-testid', 'add-contact-scan-local');
  const scanAvailable = canScanLocalPersonas();

  // QR: scan a printed / on-screen npub with the camera. Kept from the old
  // modal — on a phone it is how most contacts get added.
  const qrBtn = el('button', BTN_CSS + 'flex:none;padding:8px 10px;', 'QR');
  qrBtn.type = 'button';
  qrBtn.title = 'Scan QR code';
  qrBtn.classList.add('btn-primary', 'btn-transparent');
  qrBtn.setAttribute('data-testid', 'add-contact-scan-qr');
  npubRow.append(npubInput, qrBtn, scanBtn);

  // --- Toggles ---------------------------------------------------------
  const localTools = makeToggle('Local tools', false, 'add-contact-local-tools');
  const notifications = makeToggle('Notifications', true, 'add-contact-notifications');
  const toggles = el('div', 'margin-top:8px;');
  toggles.append(localTools.row, notifications.row);

  const errorEl = el('div', 'color:var(--danger-color);font-size:12px;margin-top:8px;min-height:18px;');
  errorEl.setAttribute('data-testid', 'add-contact-error');

  const btnRow = el('div', 'display:flex;gap:8px;margin-top:16px;justify-content:flex-end;');
  const cancelBtn = el('button', BTN_CSS, 'Cancel');
  cancelBtn.type = 'button';
  cancelBtn.classList.add('btn-primary', 'btn-transparent');
  cancelBtn.addEventListener('click', () => overlay.remove());
  const addBtn = el('button', BTN_CSS + 'color:#fff;', 'Add');
  addBtn.type = 'button';
  addBtn.classList.add('btn-primary', 'btn-color-primary');
  addBtn.setAttribute('data-testid', 'add-contact-submit');
  btnRow.append(cancelBtn, addBtn);

  // --- Behaviour -------------------------------------------------------
  let avatarToken = 0;
  const renderAvatar = async() => {
    const token = ++avatarToken;
    const value = npubInput.value.trim();
    let seed = '';
    if(isValidNpub(value)) {
      try {
        const {decodePubkey} = await import('@lib/phantomchat/nostr-identity');
        seed = decodePubkey(value);
      } catch{}
    }
    const {generateDicebearAvatar} = await import('@helpers/generateDicebearAvatar');
    const url = await generateDicebearAvatar(seed || 'new-contact', false, kind === 'human');
    if(token === avatarToken) avatar.src = url;
  };

  const setKind = (k: ContactKind) => {
    kind = k;
    segButtons.forEach((b, key) => {
      const on = key === k;
      b.setAttribute('aria-selected', String(on));
      b.style.background = on ? 'var(--primary-color)' : 'transparent';
      b.style.color = on ? '#fff' : 'var(--primary-text-color)';
    });
    // Local tools: Phantom + Provider only. Scan: Phantom, desktop only.
    localTools.row.style.display = k === 'human' ? 'none' : '';
    scanBtn.style.display = k === 'phantom' && scanAvailable ? '' : 'none';
    errorEl.textContent = '';
    void renderAvatar();
  };

  npubInput.addEventListener('input', () => {
    errorEl.textContent = '';
    void renderAvatar();
  });

  qrBtn.addEventListener('click', async() => {
    try {
      const {launchQRScanner} = await import('@components/phantomchat/QRScanner');
      launchQRScanner({
        onDetected: (npub: string) => {
          npubInput.value = npub;
          errorEl.textContent = '';
          void renderAvatar();
          nameInput.focus();
        }
      });
    } catch(err) {
      console.error('[AddContactPopup] QRScanner load failed', err);
      errorEl.textContent = 'Scanner unavailable';
    }
  });

  scanBtn.addEventListener('click', () => {
    // Wired up with the desktop local-persona bridge (phantombot side).
    errorEl.textContent = 'Scan needs the latest Phantomyard Desktop';
  });

  addBtn.addEventListener('click', async() => {
    const submit: AddContactSubmit = {
      npub: npubInput.value.trim(),
      nickname: nameInput.value.trim(),
      kind,
      notifications: notifications.input.checked,
      localTools: kind !== 'human' && localTools.input.checked
    };
    if(!isValidNpub(submit.npub)) {
      errorEl.textContent = 'Invalid npub format';
      return;
    }
    addBtn.disabled = true;
    addBtn.textContent = 'Adding...';
    try {
      const result = await addTypedContact(managers, submit);
      overlay.remove();
      onContactAdded?.(result.peerIdTweb, result.displayName);
    } catch(err) {
      console.error('[AddContactPopup]', err);
      errorEl.textContent = 'Failed to add contact';
      addBtn.disabled = false;
      addBtn.textContent = 'Add';
    }
  });

  overlay.addEventListener('click', (e) => {
    if(e.target === overlay) overlay.remove();
  });

  dialog.append(title, segment, avatarRow, npubRow, toggles, errorEl, btnRow);
  overlay.append(dialog);
  document.body.append(overlay);
  setKind('phantom');
  (opts.npub ? nameInput : npubInput).focus();

  // Provider is desktop-only and needs the bundled engine's provider list.
  void canAddProviders().then((ok) => {
    if(ok && overlay.isConnected && !segButtons.has('provider')) {
      addSegButton('provider');
      setKind(kind);
    }
  });
}

/**
 * Save the contact's type + Local tools BEFORE the add, so the first render
 * of the new chat already uses the right avatar; then add through the
 * canonical helper and apply the Notifications choice.
 *
 * The prefs are cosmetic: a store that cannot write (private window, quota)
 * never blocks the add. If the add itself fails, the prefs go back to what
 * they were before (or the new row is removed), so a failed add changes
 * nothing.
 */
export async function addTypedContact(managers: AppManagers, submit: AddContactSubmit) {
  const {decodePubkey} = await import('@lib/phantomchat/nostr-identity');
  const hex = decodePubkey(submit.npub);
  const {getContactPrefs, setContactPrefs, restoreContactPrefs} = await import('@lib/phantomchat/contact-prefs');
  let previous: Awaited<ReturnType<typeof getContactPrefs>>;
  let wrote = false;
  try {
    previous = await getContactPrefs(hex);
    await setContactPrefs(hex, {kind: submit.kind, localTools: submit.localTools});
    wrote = true;
  } catch(err) {
    console.warn('[AddContactPopup] could not save contact prefs', err);
  }

  const {addP2PContact} = await import('@lib/phantomchat/add-p2p-contact');
  let result: Awaited<ReturnType<typeof addP2PContact>>;
  try {
    result = await addP2PContact({
      pubkey: submit.npub,
      nickname: submit.nickname,
      openChat: true,
      source: 'add-contact-popup',
      deliberate: true
    });
  } catch(err) {
    if(wrote) {
      await restoreContactPrefs(hex, previous).catch((restoreErr) => {
        console.warn('[AddContactPopup] could not undo contact prefs', restoreErr);
      });
    }
    throw err;
  }

  if(!submit.notifications) {
    try {
      await managers.appMessagesManager.togglePeerMute({peerId: result.peerIdTweb, mute: true});
    } catch(err) {
      console.warn('[AddContactPopup] could not mute new contact', err);
    }
  }
  return result;
}
