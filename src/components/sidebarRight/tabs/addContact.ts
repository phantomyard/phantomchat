/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import type {AppManagers} from '@lib/managers';
import type {ContactKind} from '@lib/phantomchat/contact-prefs';
import type {LocalPersonaListing} from '@lib/phantomchat/desktop-api';
import type {ProviderCheckResult, ProviderOption} from '@lib/phantomchat/provider-contacts';
import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import InputField from '@components/inputField';
import Row from '@components/row';
import CheckboxField from '@components/checkboxField';
import ButtonCorner from '@components/buttonCorner';
import {replaceButtonIcon} from '@components/button';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import toggleDisability from '@helpers/dom/toggleDisability';
import Icon from '@components/icon';
import {createListPicker} from '@components/listPicker';

/**
 * New Contact pane (contacts redesign). It slides in from the right like the
 * contact and group Edit panes and is built from the same parts: close
 * button + title header, SettingSection, InputField, checkbox Rows and the
 * round check button in the corner. The user first picks what the contact
 * IS, and each type shows only its own fields:
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

/**
 * My own npub, for Scan's and a Provider's allowlist. Read from
 * window.__phantomchatOwnPubkey, the runtime source set at onboarding:
 * loadIdentity() reads a store production never writes and returns null in
 * a real session.
 */
export async function getOwnNpub(): Promise<string> {
  const ownPubkey = typeof window !== 'undefined' ?
    (window as {__phantomchatOwnPubkey?: string}).__phantomchatOwnPubkey :
    undefined;
  if(!ownPubkey) throw new Error('Your identity is not loaded yet');
  const {npubEncode} = await import('@lib/phantomchat/nostr-identity');
  return npubEncode(ownPubkey);
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

/* Only the controls the app has no component for get inline styles: the
 * type selector, the icon buttons inside the npub field, the provider and
 * model pickers and the scan results. Fields, toggles and the save button are
 * the same components the Edit panes use. None of them carries the app-wide
 * `.btn-primary` block button (width:100%, height:54px), which would blow a
 * shared row past the pane width. */
const SIDE_CSS = 'margin:0 .5rem;';
const SEGMENT_CSS = 'flex:1;min-width:0;padding:8px 6px;border:none;border-radius:8px;background:transparent;color:var(--primary-text-color);font-size:14px;font-weight:500;cursor:pointer;white-space:nowrap;';
const LIST_BTN_CSS = 'padding:10px 14px;border:1px solid var(--border-color);border-radius:var(--border-radius-medium, .75rem);background:transparent;color:var(--primary-text-color);font-size:14px;text-align:left;cursor:pointer;';
const NOTE_CSS = 'font-size:.875rem;color:var(--secondary-text-color);';
const ICON_BTN_CSS = 'position:absolute;top:50%;transform:translateY(-50%);z-index:2;display:flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:none;border-radius:8px;background:transparent;color:var(--secondary-text-color);font-size:20px;line-height:1;cursor:pointer;';

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

/** A plain-text InputField (an <input>, like the Edit pane's fields) with a test id on the input. */
function makeField(label: string, testId: string, maxLength?: number) {
  const field = new InputField({labelText: label, plainText: true, maxLength});
  field.input.setAttribute('data-testid', testId);
  return field;
}

export interface AddContactFormOptions extends ShowAddContactOptions {
  /** Close the pane after a successful add. */
  onDone: () => void;
  /** False once the pane is gone, so a late provider list never touches it. */
  isAlive: () => boolean;
}

export interface AddContactForm {
  /** Everything above the save button, for the pane's scrollable. */
  section: HTMLElement;
  /** The round check button in the pane's corner, as in the Edit panes. */
  submitBtn: HTMLButtonElement;
  focus(): void;
  submit(): Promise<void>;
}

/**
 * Build the New Contact form. Kept apart from the pane so it can be tested
 * without the right sidebar; the pane only mounts it.
 */
export function createAddContactForm(opts: AddContactFormOptions): AddContactForm {
  const {managers, onContactAdded} = opts;

  const settingSection = new SettingSection({noDelimiter: true});
  const section = settingSection.container;
  section.setAttribute('data-testid', 'add-contact-dialog');
  const content = settingSection.content;

  // --- Type selector ---------------------------------------------------
  const segment = el('div', SIDE_CSS + 'display:flex;gap:4px;padding:4px;border-radius:10px;background:var(--light-secondary-text-color, rgba(127,127,127,.12));margin-top:.5rem;margin-bottom:1.25rem;');
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

  // --- Avatar: centred, 120px, like the Edit pane. Display-only: the
  // contact's face comes from their kind-0 picture or the human bust sigil
  // (or the phantom sigil), never from an upload here. -------------------
  const avatarWrap = el('div', 'width:120px;height:120px;margin:0 auto;cursor:default;');
  const avatar = el('img', 'width:100%;height:100%;display:block;border-radius:50%;background:var(--light-secondary-text-color, rgba(127,127,127,.12));');
  avatar.alt = '';
  avatar.setAttribute('data-testid', 'add-contact-avatar');
  avatarWrap.append(avatar);

  // --- Fields ----------------------------------------------------------
  const inputWrapper = el('div');
  inputWrapper.classList.add('input-wrapper');

  const nameField = makeField('Contact Name', 'add-contact-name', 70);

  // npub (Phantom + Human). QR and Scan are icon buttons inside the field's
  // trailing edge, so the field keeps the full pane width.
  const npubField = makeField('npub Key (npub1...)', 'add-contact-npub');
  const npubInput = npubField.input as HTMLInputElement;
  npubField.container.style.position = 'relative';
  if(opts.npub) npubField.value = opts.npub.trim();

  // Scan: find phantombot personas installed on this PC (desktop only).
  const scanAvailable = canScanLocalPersonas();
  const localToolsAvailable = typeof (desktopApi() as any)?.localTools?.message === 'function';
  const scanBtn = makeIconButton('search', 'Find phantombot personas on this PC', 'add-contact-scan-local');
  scanBtn.style.insetInlineEnd = '46px';

  // QR: scan a printed / on-screen npub with the camera. On a phone it is
  // how most contacts get added.
  const qrBtn = makeIconButton('camera', 'Scan QR code', 'add-contact-scan-qr');
  qrBtn.style.insetInlineEnd = '10px';
  npubField.container.append(qrBtn, scanBtn);

  // Scan results: one button per persona of the phantombot on this PC.
  const scanList = el('div', 'display:none;flex-direction:column;gap:4px;margin:-.5rem 0 1rem;');
  scanList.setAttribute('data-testid', 'add-contact-scan-list');

  // --- Provider (desktop only) -----------------------------------------
  const providerBox = el('div', 'display:none;flex-direction:column;gap:.75rem;margin-bottom:1.5rem;');
  providerBox.setAttribute('data-testid', 'add-contact-provider');
  const providerPicker = createListPicker({
    testId: 'add-contact-provider-select',
    label: 'Provider',
    placeholder: 'Choose a provider',
    onChange: () => onProviderChanged()
  });
  const tokenField = makeField('Token', 'add-contact-provider-token');
  tokenField.container.style.margin = '0';
  const tokenInput = tokenField.input as HTMLInputElement;
  tokenInput.type = 'password';
  tokenInput.autocomplete = 'off';
  const providerStatus = el('div', NOTE_CSS + 'min-height:16px;');
  providerStatus.setAttribute('data-testid', 'add-contact-provider-status');
  // A provider that needs a model shows this picker the moment it is picked,
  // before the token: the engine learns the model list from the provider's own
  // API, so the models arrive with a verified key and the picker says what it
  // is waiting for instead of appearing out of nowhere after a save.
  const modelField = el('div', 'display:none;flex-direction:column;gap:.375rem;');
  modelField.setAttribute('data-testid', 'add-contact-provider-model-field');
  modelField.append(el('div', NOTE_CSS, 'Model'));
  const modelPicker = createListPicker({
    testId: 'add-contact-provider-model',
    label: 'Model',
    placeholder: 'Enter your token to load models',
    limit: 20,
    onChange: () => {
      errorEl.textContent = '';
    }
  });
  modelField.append(modelPicker.trigger);
  providerBox.append(providerPicker.trigger, tokenField.container, providerStatus, modelField);
  inputWrapper.append(nameField.container, npubField.container, scanList, providerBox);

  // --- Toggles: the Edit pane's checkbox Rows ----------------------------
  const makeToggleRow = (text: 'ContactLocalTools' | 'Notifications', checked: boolean, testId: string) => {
    const field = new CheckboxField({text});
    field.input.setAttribute('data-testid', testId);
    const row = new Row({checkboxField: field, withCheckboxSubtitle: true});
    row.container.setAttribute('data-testid', testId + '-row');
    // Set after the Row exists: the setter fires change, which writes the
    // Enabled / Disabled subtitle the Edit pane shows.
    field.checked = checked;
    return {row: row.container, input: field.input};
  };
  const localTools = makeToggleRow('ContactLocalTools', false, 'add-contact-local-tools');
  const notifications = makeToggleRow('Notifications', true, 'add-contact-notifications');

  const errorEl = el('div', SIDE_CSS + 'color:var(--danger-color);font-size:.875rem;min-height:18px;margin-top:.5rem;');
  errorEl.setAttribute('data-testid', 'add-contact-error');

  content.append(segment, avatarWrap, inputWrapper, localTools.row, notifications.row, errorEl);

  // Same save control as the contact and group Edit panes. `.btn-corner`
  // rests below the pane until `.is-visible`, so it is set once: the button
  // validates on press instead of hiding until the form looks complete.
  const submitBtn = ButtonCorner({icon: 'check'}) as HTMLButtonElement;
  submitBtn.classList.add('is-visible');
  submitBtn.setAttribute('data-testid', 'add-contact-submit');
  submitBtn.setAttribute('aria-label', 'Add contact');
  submitBtn.title = 'Add contact';

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
    // Local tools: Phantom on a desktop build with the Local tools gate. A
    // Provider runs on this PC's engine with its tools, and the engine has no
    // per-channel switch yet, so it shows none rather than one that does
    // nothing. Never Human.
    localTools.row.style.display = k === 'phantom' && localToolsAvailable ? '' : 'none';
    const showScan = k === 'phantom' && scanAvailable;
    scanBtn.style.display = showScan ? 'flex' : 'none';
    // Keep the typed text clear of the icon buttons inside the field.
    npubInput.style.paddingInlineEnd = showScan ? '86px' : '48px';
    npubField.container.style.display = k === 'provider' ? 'none' : '';
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
          npubField.value = npub;
          errorEl.textContent = '';
          void renderAvatar();
          nameField.input.focus();
        }
      });
    } catch(err) {
      console.error('[AddContactPane] QRScanner load failed', err);
      errorEl.textContent = 'Scanner unavailable';
    }
  });

  scanBtn.addEventListener('click', async() => {
    const api = desktopApi()?.localPersonas;
    if(!api) return;
    errorEl.textContent = '';
    scanBtn.disabled = true;
    scanList.replaceChildren(el('div', NOTE_CSS, 'Looking for phantombot on this PC...'));
    scanList.style.display = 'flex';
    try {
      const ownNpub = await getOwnNpub();
      const res = await api.list(ownNpub);
      if(!res?.ok) {
        scanList.replaceChildren(el('div', 'font-size:.875rem;color:var(--danger-color);', res?.error?.message || 'Scan failed'));
        return;
      }
      const personas = (res.value as LocalPersonaListing[]) || [];
      if(!personas.length) {
        scanList.replaceChildren(el('div', NOTE_CSS, 'No personas found on this PC'));
        return;
      }
      scanList.replaceChildren(...personas.map((p) => {
        const b = el('button', LIST_BTN_CSS, p.persona + (p.allowed ? ' (already allows you)' : ''));
        b.type = 'button';
        b.setAttribute('data-testid', `add-contact-scan-persona-${p.persona}`);
        b.addEventListener('click', () => void pickLocalPersona(p.persona, ownNpub));
        return b;
      }));
    } catch(err) {
      console.error('[AddContactPane] scan failed', err);
      scanList.replaceChildren(el('div', 'font-size:.875rem;color:var(--danger-color);', 'Scan failed'));
    } finally {
      scanBtn.disabled = false;
    }
  });

  const pickLocalPersona = async(persona: string, ownNpub: string) => {
    const api = desktopApi()?.localPersonas;
    if(!api) return;
    scanList.replaceChildren(el('div', NOTE_CSS, `Adding you to ${persona} and restarting phantombot...`));
    const res = await api.allow(persona, ownNpub).catch((err: unknown) => ({ok: false, error: {message: String(err)}}));
    if(!res?.ok) {
      scanList.replaceChildren(el('div', 'font-size:.875rem;color:var(--danger-color);', res?.error?.message || 'Could not add you'));
      return;
    }
    npubField.value = res.value.npub;
    if(!nameField.value.trim()) nameField.value = persona.charAt(0).toUpperCase() + persona.slice(1);
    const note = res.value.restarted || !res.value.added ?
      `${persona} is ready` :
      `Restart phantombot to finish (${res.value.restartError || 'restart failed'})`;
    scanList.replaceChildren(el('div', NOTE_CSS, note));
    scanList.firstElementChild?.setAttribute('data-testid', 'add-contact-scan-done');
    void renderAvatar();
  };

  // --- Provider behaviour ------------------------------------------------
  let providers: ProviderOption[] | undefined;
  let checked: {provider: string; token: string; result: ProviderCheckResult} | undefined;
  /**
   * Bumped whenever the provider or the token changes, so a check that is
   * still in flight for the old pair never writes into the new one.
   */
  let checkGeneration = 0;
  const call = (method: string, params?: Record<string, unknown>) => desktopApi()!.phantombot!.call(method, params);
  const currentProvider = () => providers?.find((p) => p.id === providerPicker.getValue());

  /** Show the model picker as soon as a provider that needs one is picked. */
  const syncModelRow = () => {
    const p = currentProvider();
    const needsModel = !!p && !p.autoModel;
    modelField.style.display = needsModel ? 'flex' : 'none';
    if(!needsModel) return;
    modelPicker.setDisabled(!modelPicker.getOptions().length);
    modelPicker.setPlaceholder(p.defaultModel ?
      `Enter your token to load models (default: ${p.defaultModel})` :
      'Enter your token to load models');
  };

  const resetCheck = () => {
    checked = undefined;
    checkGeneration++;
    modelPicker.setOptions([]);
    const p = currentProvider();
    tokenField.label.textContent = p?.keyLabel || 'Token';
    syncModelRow();
    providerStatus.textContent = p && !p.checkable ? 'This provider cannot be verified; its key is used as given' : '';
  };

  const loadProviders = async() => {
    if(providers) return;
    try {
      const {listProviderOptions} = await import('@lib/phantomchat/provider-contacts');
      providers = await listProviderOptions(call);
      providerPicker.setOptions(providers.map((p) => ({value: p.id, label: p.label})), providers[0]?.id);
      resetCheck();
    } catch(err) {
      console.error('[AddContactPane] providers failed', err);
      providerStatus.textContent = 'Could not list providers';
    }
  };

  function onProviderChanged() {
    errorEl.textContent = '';
    resetCheck();
    // A token typed before the provider was picked is checked right away.
    if(tokenInput.value.trim()) void verifyToken();
  }

  /** Check the token with the provider; the models come back with a verified key. */
  const checkToken = async(p: ProviderOption, token: string): Promise<ProviderCheckResult> => {
    providerStatus.textContent = 'Checking token...';
    const {checkProviderKey} = await import('@lib/phantomchat/provider-contacts');
    const result = await checkProviderKey(call, p.id, token);
    providerStatus.textContent = result.status === 'verified' ? 'Token verified' :
      result.status === 'invalid' ? `Token rejected (${result.detail})` :
      `Could not verify (${result.detail || 'no check for this provider'})`;
    return result;
  };

  /** Put a check's models in the picker, default model first and preselected. */
  const fillModels = (p: ProviderOption, result: ProviderCheckResult) => {
    if(p.autoModel || result.status === 'invalid') return;
    const ids = result.models.map((m) => m.id);
    if(p.defaultModel && !ids.includes(p.defaultModel)) ids.unshift(p.defaultModel);
    if(!ids.length) {
      providerStatus.textContent += '; no models listed';
      modelPicker.setDisabled(true);
      return;
    }
    const previous = modelPicker.getValue();
    modelPicker.setOptions(ids.map((id) => ({
      value: id,
      label: id,
      ...(id === p.defaultModel ? {hint: 'Provider default'} : {})
    })), previous && ids.includes(previous) ? previous : (p.defaultModel || ids[0]));
    modelPicker.setDisabled(false);
  };

  /**
   * Verify the typed token when the field loses focus (tap on the model
   * picker, the save button or anywhere else), so the model list is already
   * there when the user reaches for it, not after a save attempt.
   */
  const verifyToken = async() => {
    const p = currentProvider();
    const token = tokenInput.value.trim();
    if(!p || !token) return;
    if(checked && checked.provider === p.id && checked.token === token) return;
    const generation = ++checkGeneration;
    try {
      const result = await checkToken(p, token);
      if(generation !== checkGeneration) return;
      checked = {provider: p.id, token, result};
      fillModels(p, result);
    } catch(err) {
      if(generation !== checkGeneration) return;
      providerStatus.textContent = err instanceof Error && err.message ? err.message : 'Could not check the token';
    }
  };

  tokenInput.addEventListener('input', () => {
    // A different token means a different model list.
    if(checked || modelPicker.getOptions().length) resetCheck();
  });
  tokenInput.addEventListener('blur', () => void verifyToken());

  // One add at a time: the corner button and Enter both land here.
  let busy = false;
  const runBusy = async(fn: () => Promise<void>) => {
    if(busy) return;
    busy = true;
    const restore = toggleDisability([submitBtn], true);
    try {
      await fn();
    } finally {
      busy = false;
      restore();
    }
  };

  const addProvider = async() => {
    const p = currentProvider();
    if(!p) {
      errorEl.textContent = 'Choose a provider';
      return;
    }
    const token = tokenInput.value.trim();
    if(!token) {
      errorEl.textContent = 'Enter the token';
      return;
    }
    // A check for this exact provider and token is reused, so a save after a
    // token blur (or after picking a model) never asks the provider twice.
    let result = checked && checked.provider === p.id && checked.token === token ? checked.result : undefined;
    if(!result) {
      const generation = ++checkGeneration;
      try {
        result = await checkToken(p, token);
      } catch(err) {
        errorEl.textContent = err instanceof Error && err.message ? err.message : 'Could not check the token';
        return;
      }
      if(generation !== checkGeneration) return;
      checked = {provider: p.id, token, result};
      fillModels(p, result);
    }
    if(result.status === 'invalid') {
      errorEl.textContent = 'The provider rejected this token';
      return;
    }
    // The model picker is filled and preselected by now, so a save takes the
    // model the user can see. Nothing is chosen behind their back.
    const model = p.autoModel ? p.defaultModel : (modelPicker.getValue() || p.defaultModel);
    if(!model) {
      errorEl.textContent = 'Choose a model';
      return;
    }
    const {createProviderContact, deleteProviderPersona} = await import('@lib/phantomchat/provider-contacts');
    let created: Awaited<ReturnType<typeof createProviderContact>> | undefined;
    try {
      created = await createProviderContact(call, {
        displayName: nameField.value.trim() || p.label,
        provider: p,
        model,
        apiKey: token,
        ownNpub: await getOwnNpub()
      });
      if(created.channelError) console.warn('[AddContactPane] provider channel not running yet:', created.channelError);
      const result = await addTypedContact(managers, {
        npub: created.npub,
        nickname: nameField.value.trim() || p.label,
        kind: 'provider',
        notifications: notifications.input.checked,
        localTools: false,
        persona: created.persona
      });
      opts.onDone();
      onContactAdded?.(result.peerIdTweb, result.displayName);
    } catch(err) {
      console.error('[AddContactPane] provider add failed', err);
      // The contact did not land: take its persona (and key) away again.
      if(created) await deleteProviderPersona(call, created.persona).catch(() => {});
      errorEl.textContent = err instanceof Error && err.message ? err.message : 'Failed to add contact';
    }
  };

  const addPeer = async() => {
    const submit: AddContactSubmit = {
      npub: npubInput.value.trim(),
      nickname: nameField.value.trim(),
      kind,
      notifications: notifications.input.checked,
      localTools: kind !== 'human' && localTools.input.checked
    };
    if(!isValidNpub(submit.npub)) {
      errorEl.textContent = 'Invalid npub format';
      return;
    }
    try {
      const result = await addTypedContact(managers, submit);
      opts.onDone();
      onContactAdded?.(result.peerIdTweb, result.displayName);
    } catch(err) {
      console.error('[AddContactPane]', err);
      errorEl.textContent = 'Failed to add contact';
    }
  };

  const submit = () => runBusy(() => kind === 'provider' ? addProvider() : addPeer());
  submitBtn.addEventListener('click', () => void submit());

  // Enter in a text field adds, like Enter in the group editor's name field.
  [nameField.input, npubInput].forEach((input) => {
    input.addEventListener('keydown', (event: KeyboardEvent) => {
      if(event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      if(!event.repeat) void submit();
    });
  });

  setKind('phantom');

  // Provider is desktop-only and needs the bundled engine's provider list.
  void canAddProviders().then((ok) => {
    if(ok && opts.isAlive() && !segButtons.has('provider')) {
      addSegButton('provider');
      setKind(kind);
    }
  });

  return {
    section,
    submitBtn,
    submit,
    focus: () => (opts.npub ? nameField.input : npubInput).focus()
  };
}

/**
 * The New Contact pane: a right-sidebar tab like AppEditContactTab and
 * AppPhantomChatGroupEditTab, with the same close button, title and corner
 * check button.
 */
export default class AppAddContactTab extends SliderSuperTab {
  public options: ShowAddContactOptions;
  public form: AddContactForm;
  /** Opened over the chat list (phone): closing must go back to it. */
  public fromChatList = false;
  private added = false;
  private backToChatList: () => void;

  public async init() {
    // Closing the right sidebar always selects the CHAT tab. On a phone the
    // pane opens over the chat list with no chat behind it, so without this a
    // close (X, back, Escape) lands on an empty chat screen. A successful add
    // opens the new chat, which is the right place to land.
    const {default: appImManager, APP_TABS} = await import('@lib/appImManager');
    this.backToChatList = () => appImManager.selectTab(APP_TABS.CHATLIST);

    this.container.classList.add('edit-peer-container', 'edit-contact-container', 'add-contact-container');
    this.title.textContent = 'New Contact';

    const appSidebarRight = (await import('@components/sidebarRight')).default;
    const closePane = () => {
      this.close();
      appSidebarRight.toggleSidebar(false);
    };

    // Close, not back: the pane is a whole task, as in the Edit panes.
    const newCloseBtn = this.closeBtn.cloneNode(true) as HTMLElement;
    this.closeBtn.replaceWith(newCloseBtn);
    this.closeBtn = newCloseBtn;
    replaceButtonIcon(this.closeBtn, 'close');
    attachClickEvent(this.closeBtn, closePane, {listenerSetter: this.listenerSetter});

    let alive = true;
    this.middlewareHelper.get().onDestroy(() => {
      alive = false;
    });

    this.form = createAddContactForm({
      ...this.options,
      onDone: () => {
        this.added = true;
        closePane();
      },
      isAlive: () => alive && this.container.isConnected
    });
    this.scrollable.append(this.form.section);
    this.content.append(this.form.submitBtn);
  }

  protected onOpenAfterTimeout() {
    this.form?.focus();
  }

  protected onClose() {
    if(this.fromChatList && !this.added) this.backToChatList?.();
  }
}

/**
 * Open the New Contact pane. Every entry point (tools menu, Contacts tab +,
 * an npub pasted into a search box) opens this same pane.
 */
export async function openAddContactPane(opts: ShowAddContactOptions): Promise<void> {
  const appSidebarRight = (await import('@components/sidebarRight')).default;
  // One pane at a time: a search box fires on every keystroke past 60 chars.
  if(appSidebarRight.isTabExists(AppAddContactTab)) {
    appSidebarRight.toggleSidebar(true);
    return;
  }
  const tab = appSidebarRight.createTab(AppAddContactTab, true);
  tab.options = opts;
  // 'is-left-column-shown' (LEFT_COLUMN_ACTIVE_CLASSNAME in sidebarLeft) is
  // set while the chat list is the selected tab. Read as a string so this
  // module does not import the whole left sidebar.
  tab.fromChatList = document.body.classList.contains('is-left-column-shown');
  // Await open() BEFORE showing the sidebar: with an empty history,
  // toggleSidebar(true) falls back to the native peer-info tab (see
  // openPeerEditor in peerActionsMenu.ts).
  await tab.open();
  appSidebarRight.toggleSidebar(true);
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
    console.warn('[AddContactPane] could not save contact prefs', err);
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
        console.warn('[AddContactPane] could not undo contact prefs', restoreErr);
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
      console.warn('[AddContactPane] could not turn on Local tools', err);
    }
  }

  if(!submit.notifications) {
    try {
      await managers.appMessagesManager.togglePeerMute({peerId: result.peerIdTweb, mute: true});
    } catch(err) {
      console.warn('[AddContactPane] could not mute new contact', err);
    }
  }
  return result;
}
