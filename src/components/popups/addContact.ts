/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import type {AppManagers} from '@lib/managers';
import type {ContactKind} from '@lib/phantomchat/contact-prefs';
import type {LocalPersonaListing} from '@lib/phantomchat/desktop-api';
import type {ProviderCheckResult, ProviderOption} from '@lib/phantomchat/provider-contacts';
import Icon from '@components/icon';

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
  /** Provider contacts: the bundled-engine persona behind the npub. */
  persona?: string;
}

export interface ShowAddContactOptions {
  managers: AppManagers;
  /** Prefill the npub field (e.g. an npub pasted into a search box). */
  npub?: string;
  /** Called with the new contact's peer id once it has been added. */
  onContactAdded?: (peerId: PeerId, displayName: string) => void;
}

type DesktopApi = {
  phantombot?: {call(method: string, params?: Record<string, unknown>): Promise<any>};
  localPersonas?: {
    list(ownNpub: string): Promise<any>;
    allow(persona: string, ownNpub: string): Promise<any>;
  };
};

/** My own npub, for Scan's and a Provider's allowlist. */
async function getOwnNpub(): Promise<string> {
  const {loadIdentity} = await import('@lib/phantomchat/identity');
  const {npubEncode} = await import('@lib/phantomchat/nostr-identity');
  const identity = await loadIdentity();
  if(!identity?.publicKey) throw new Error('no identity');
  return npubEncode(identity.publicKey);
}

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

/* Compact controls for the dialog's own rows. The app's `.btn-primary` is a
 * block button (width:100%, height:54px, overflow:hidden), so putting it on a
 * control that shares a row with a field blows the row past the dialog width:
 * the field collapses to a few pixels and the dialog grows a horizontal
 * scrollbar. These styles size to content instead. */
const SEGMENT_CSS = 'flex:1;min-width:0;padding:8px 6px;border:none;border-radius:8px;background:transparent;color:var(--primary-text-color);font-size:14px;font-weight:500;cursor:pointer;white-space:nowrap;';
const ACTION_CSS = 'flex:none;height:40px;padding:0 14px;border:none;border-radius:8px;background:transparent;color:var(--primary-color);font-size:14px;font-weight:500;cursor:pointer;white-space:nowrap;';
const OUTLINE_CSS = 'flex:none;height:44px;padding:0 14px;border:1px solid var(--border-color);border-radius:8px;background:transparent;color:var(--primary-color);font-size:14px;font-weight:500;cursor:pointer;white-space:nowrap;';
const PRIMARY_CSS = 'flex:none;height:40px;padding:0 24px;border:none;border-radius:10px;background:var(--primary-color);color:#fff;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap;';
const ICON_BTN_CSS = 'position:absolute;top:50%;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:none;border-radius:8px;background:transparent;color:var(--secondary-text-color);font-size:20px;line-height:1;cursor:pointer;';

/** Icon-only button for the npub field's trailing edge. */
function makeIconButton(icon: Icon, title: string, testId: string) {
  const btn = el('button', ICON_BTN_CSS);
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.setAttribute('data-testid', testId);
  btn.append(Icon(icon));
  return btn;
}

function makeToggle(label: string, checked: boolean, testId: string) {
  const row = el('div', 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 2px;font-size:14px;color:var(--primary-text-color);cursor:pointer;');
  row.setAttribute('data-testid', testId + '-row');
  const caption = el('span', 'min-width:0;', label);
  // The app's switch markup (see checkboxField.ts). A bare <input type="checkbox">
  // is invisible here: _checkbox.scss hides it and draws .checkbox-toggle instead.
  const field = el('label', 'margin:0;');
  field.classList.add('checkbox-field', 'checkbox-field-toggle', 'checkbox-without-caption');
  const input = el('input');
  input.classList.add('checkbox-field-input');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute('data-testid', testId);
  const toggle = el('div', '');
  toggle.classList.add('checkbox-toggle');
  const circle = el('div', '');
  circle.classList.add('checkbox-toggle-circle');
  toggle.append(circle);
  field.append(input, toggle);
  caption.addEventListener('click', () => {
    input.checked = !input.checked;
  });
  row.append(caption, field);
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
    const b = el('button', SEGMENT_CSS, KIND_LABELS[k]);
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
  // The field keeps the full row width; QR and Scan are icon buttons that sit
  // inside its trailing edge, so the modal never needs horizontal scrolling.
  const npubField = el('div', 'position:relative;display:flex;align-items:center;flex:1;min-width:0;');
  const npubInput = el('input', INPUT_CSS + 'min-width:0;');
  npubInput.type = 'text';
  npubInput.placeholder = 'npub Key (npub1...)';
  npubInput.classList.add('input-clear');
  npubInput.setAttribute('data-testid', 'add-contact-npub');
  if(opts.npub) npubInput.value = opts.npub.trim();

  // Scan: find phantombot personas installed on this PC (desktop only).
  const scanAvailable = canScanLocalPersonas();
  const localToolsAvailable = typeof (desktopApi() as any)?.localTools?.message === 'function';
  const scanBtn = makeIconButton('search', 'Find phantombot personas on this PC', 'add-contact-scan-local');
  scanBtn.style.insetInlineEnd = '42px';

  // QR: scan a printed / on-screen npub with the camera. Kept from the old
  // modal — on a phone it is how most contacts get added.
  const qrBtn = makeIconButton('camera', 'Scan QR code', 'add-contact-scan-qr');
  qrBtn.style.insetInlineEnd = '6px';

  npubField.append(npubInput, qrBtn, scanBtn);
  npubRow.append(npubField);

  // Scan results: one button per persona of the phantombot on this PC.
  const scanList = el('div', 'display:none;flex-direction:column;gap:4px;margin-top:8px;');
  scanList.setAttribute('data-testid', 'add-contact-scan-list');

  // --- Provider (desktop only) -----------------------------------------
  const providerBox = el('div', 'display:none;flex-direction:column;gap:8px;');
  providerBox.setAttribute('data-testid', 'add-contact-provider');
  const providerSelect = el('select', INPUT_CSS);
  providerSelect.setAttribute('data-testid', 'add-contact-provider-select');
  const tokenRow = el('div', 'display:flex;gap:8px;align-items:center;');
  const tokenInput = el('input', INPUT_CSS + 'flex:1;min-width:0;');
  tokenInput.type = 'password';
  tokenInput.placeholder = 'Token';
  tokenInput.autocomplete = 'off';
  tokenInput.setAttribute('data-testid', 'add-contact-provider-token');
  const validateBtn = el('button', OUTLINE_CSS, 'Validate');
  validateBtn.type = 'button';
  validateBtn.setAttribute('data-testid', 'add-contact-provider-validate');
  tokenRow.append(tokenInput, validateBtn);
  const providerStatus = el('div', 'font-size:12px;color:var(--secondary-text-color);min-height:16px;');
  providerStatus.setAttribute('data-testid', 'add-contact-provider-status');
  const modelSelect = el('select', INPUT_CSS);
  modelSelect.setAttribute('data-testid', 'add-contact-provider-model');
  modelSelect.style.display = 'none';
  providerBox.append(providerSelect, tokenRow, providerStatus, modelSelect);

  // --- Toggles ---------------------------------------------------------
  const localTools = makeToggle('Local tools', false, 'add-contact-local-tools');
  const notifications = makeToggle('Notifications', true, 'add-contact-notifications');
  const toggles = el('div', 'margin-top:8px;');
  toggles.append(localTools.row, notifications.row);

  const errorEl = el('div', 'color:var(--danger-color);font-size:12px;margin-top:8px;min-height:18px;');
  errorEl.setAttribute('data-testid', 'add-contact-error');

  const btnRow = el('div', 'display:flex;gap:8px;margin-top:16px;justify-content:flex-end;');
  const cancelBtn = el('button', ACTION_CSS, 'Cancel');
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('click', () => overlay.remove());
  const addBtn = el('button', PRIMARY_CSS, 'Add');
  addBtn.type = 'button';
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
    // Local tools: Phantom on a desktop build with the Local tools gate. A
    // Provider runs on this PC's engine with its tools, and the engine has no
    // per-channel switch yet, so it shows none rather than one that does
    // nothing. Never Human.
    // Explicit values: clearing the inline display falls back to block, which
    // stacks the switch under its caption.
    localTools.row.style.display = k === 'phantom' && localToolsAvailable ? 'flex' : 'none';
    const showScan = k === 'phantom' && scanAvailable;
    scanBtn.style.display = showScan ? 'flex' : 'none';
    // Keep the typed text clear of the icon buttons inside the field.
    npubInput.style.paddingInlineEnd = showScan ? '82px' : '44px';
    npubRow.style.display = k === 'provider' ? 'none' : 'flex';
    providerBox.style.display = k === 'provider' ? 'flex' : 'none';
    if(k !== 'phantom') scanList.style.display = 'none';
    if(k === 'provider') void loadProviders();
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

  scanBtn.addEventListener('click', async() => {
    const api = desktopApi()?.localPersonas;
    if(!api) return;
    errorEl.textContent = '';
    scanBtn.disabled = true;
    scanList.replaceChildren(el('div', 'font-size:12px;color:var(--secondary-text-color);', 'Looking for phantombot on this PC...'));
    scanList.style.display = 'flex';
    try {
      const ownNpub = await getOwnNpub();
      const res = await api.list(ownNpub);
      if(!res?.ok) {
        scanList.replaceChildren(el('div', 'font-size:12px;color:var(--danger-color);', res?.error?.message || 'Scan failed'));
        return;
      }
      const personas = (res.value as LocalPersonaListing[]) || [];
      if(!personas.length) {
        scanList.replaceChildren(el('div', 'font-size:12px;color:var(--secondary-text-color);', 'No personas found on this PC'));
        return;
      }
      scanList.replaceChildren(...personas.map((p) => {
        const b = el('button', BTN_CSS + 'text-align:left;background:transparent;color:var(--primary-text-color);border:1px solid var(--border-color);',
          p.persona + (p.allowed ? ' (already allows you)' : ''));
        b.type = 'button';
        b.setAttribute('data-testid', `add-contact-scan-persona-${p.persona}`);
        b.addEventListener('click', () => void pickLocalPersona(p.persona, ownNpub));
        return b;
      }));
    } catch(err) {
      console.error('[AddContactPopup] scan failed', err);
      scanList.replaceChildren(el('div', 'font-size:12px;color:var(--danger-color);', 'Scan failed'));
    } finally {
      scanBtn.disabled = false;
    }
  });

  const pickLocalPersona = async(persona: string, ownNpub: string) => {
    const api = desktopApi()?.localPersonas;
    if(!api) return;
    scanList.replaceChildren(el('div', 'font-size:12px;color:var(--secondary-text-color);', `Adding you to ${persona} and restarting phantombot...`));
    const res = await api.allow(persona, ownNpub).catch((err: unknown) => ({ok: false, error: {message: String(err)}}));
    if(!res?.ok) {
      scanList.replaceChildren(el('div', 'font-size:12px;color:var(--danger-color);', res?.error?.message || 'Could not add you'));
      return;
    }
    npubInput.value = res.value.npub;
    if(!nameInput.value.trim()) nameInput.value = persona.charAt(0).toUpperCase() + persona.slice(1);
    const note = res.value.restarted || !res.value.added ?
      `${persona} is ready` :
      `Restart phantombot to finish (${res.value.restartError || 'restart failed'})`;
    scanList.replaceChildren(el('div', 'font-size:12px;color:var(--secondary-text-color);', note));
    scanList.firstElementChild?.setAttribute('data-testid', 'add-contact-scan-done');
    void renderAvatar();
  };

  // --- Provider behaviour ------------------------------------------------
  let providers: ProviderOption[] | undefined;
  let checked: {provider: string; token: string; result: ProviderCheckResult} | undefined;
  const call = (method: string, params?: Record<string, unknown>) => desktopApi()!.phantombot!.call(method, params);
  const currentProvider = () => providers?.find((p) => p.id === providerSelect.value);

  const resetCheck = () => {
    checked = undefined;
    modelSelect.style.display = 'none';
    modelSelect.replaceChildren();
    const p = currentProvider();
    tokenInput.placeholder = p?.keyLabel || 'Token';
    providerStatus.textContent = p && !p.checkable ? 'This provider cannot be verified; its key is used as given' : '';
  };

  const loadProviders = async() => {
    if(providers) return;
    try {
      const {listProviderOptions} = await import('@lib/phantomchat/provider-contacts');
      providers = await listProviderOptions(call);
      providerSelect.replaceChildren(...providers.map((p) => {
        const o = el('option', undefined, p.label);
        o.value = p.id;
        return o;
      }));
      resetCheck();
    } catch(err) {
      console.error('[AddContactPopup] providers failed', err);
      providerStatus.textContent = 'Could not list providers';
    }
  };

  providerSelect.addEventListener('change', resetCheck);
  tokenInput.addEventListener('input', () => {
    if(checked) resetCheck();
  });

  validateBtn.addEventListener('click', async() => {
    const p = currentProvider();
    if(!p) return;
    validateBtn.disabled = true;
    providerStatus.textContent = 'Checking...';
    try {
      const {checkProviderKey} = await import('@lib/phantomchat/provider-contacts');
      const token = tokenInput.value.trim();
      const result = await checkProviderKey(call, p.id, token);
      checked = {provider: p.id, token, result};
      providerStatus.textContent = result.status === 'verified' ? 'Token verified' :
        result.status === 'invalid' ? `Token rejected (${result.detail})` :
        `Could not verify (${result.detail || 'no check for this provider'})`;
      if(p.autoModel || result.status === 'invalid') return;
      const ids = result.models.map((m) => m.id);
      if(p.defaultModel && !ids.includes(p.defaultModel)) ids.unshift(p.defaultModel);
      modelSelect.replaceChildren(...ids.map((id) => {
        const o = el('option', undefined, id);
        o.value = id;
        return o;
      }));
      if(p.defaultModel) modelSelect.value = p.defaultModel;
      modelSelect.style.display = ids.length ? '' : 'none';
      if(!ids.length) providerStatus.textContent += '; no models listed';
    } catch(err) {
      providerStatus.textContent = err instanceof Error ? err.message : 'Check failed';
    } finally {
      validateBtn.disabled = false;
    }
  });

  const addProvider = async() => {
    const p = currentProvider();
    if(!p) {
      errorEl.textContent = 'Choose a provider';
      return;
    }
    const token = tokenInput.value.trim();
    if(!checked || checked.provider !== p.id || checked.token !== token) {
      errorEl.textContent = 'Validate the token first';
      return;
    }
    if(checked.result.status === 'invalid') {
      errorEl.textContent = 'The provider rejected this token';
      return;
    }
    const model = p.autoModel ? p.defaultModel : modelSelect.value;
    if(!model) {
      errorEl.textContent = 'Choose a model';
      return;
    }
    addBtn.disabled = true;
    addBtn.textContent = 'Adding...';
    const {createProviderContact, deleteProviderPersona} = await import('@lib/phantomchat/provider-contacts');
    let created: Awaited<ReturnType<typeof createProviderContact>> | undefined;
    try {
      created = await createProviderContact(call, {
        displayName: nameInput.value.trim() || p.label,
        provider: p,
        model,
        apiKey: token,
        ownNpub: await getOwnNpub()
      });
      if(created.channelError) console.warn('[AddContactPopup] provider channel not running yet:', created.channelError);
      const result = await addTypedContact(managers, {
        npub: created.npub,
        nickname: nameInput.value.trim() || p.label,
        kind: 'provider',
        notifications: notifications.input.checked,
        localTools: false,
        persona: created.persona
      });
      overlay.remove();
      onContactAdded?.(result.peerIdTweb, result.displayName);
    } catch(err) {
      console.error('[AddContactPopup] provider add failed', err);
      // The contact did not land: take its persona (and key) away again.
      if(created) await deleteProviderPersona(call, created.persona).catch(() => {});
      errorEl.textContent = err instanceof Error && err.message ? err.message : 'Failed to add contact';
      addBtn.disabled = false;
      addBtn.textContent = 'Add';
    }
  };

  addBtn.addEventListener('click', async() => {
    if(kind === 'provider') return addProvider();
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

  dialog.append(title, segment, avatarRow, npubRow, scanList, providerBox, toggles, errorEl, btnRow);
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
    await setContactPrefs(hex, {
      kind: submit.kind,
      localTools: submit.localTools,
      ...(submit.persona ? {persona: submit.persona} : {})
    });
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

  // Phantom + Local tools: main's gate decides (native Allow dialog). A
  // Cancel turns the saved switch back off; the contact is added either way.
  if(submit.kind === 'phantom' && submit.localTools) {
    try {
      const {getLocalToolsApi, setPhantomLocalTools} = await import('@lib/phantomchat/local-tools');
      const on = getLocalToolsApi() ? await setPhantomLocalTools(hex, true, submit.nickname || 'This contact') : false;
      if(!on && wrote) await setContactPrefs(hex, {localTools: false});
    } catch(err) {
      console.warn('[AddContactPopup] could not turn on Local tools', err);
    }
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
