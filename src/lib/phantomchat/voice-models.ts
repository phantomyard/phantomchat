import {getDesktopVoiceModels} from './desktop-api';
import {createModelChooser, formColumn, labelledPicker, noteLine, showStoredKey, textField, toggleRow, type ModelChooser} from '@components/sidebarLeft/tabs/phantomchatModelKit';
export type VoiceModality = 'tts' | 'stt';
export type VoiceModelsCall = (method: string, params?: unknown) => Promise<{ok: boolean; value?: any; error?: {message: string}}>;
export async function voiceValue(call: VoiceModelsCall, method: string, params?: unknown) {
  const r = await call(method, params);
  if(!r.ok) throw new Error(r.error?.message || 'Voice settings unavailable');
  return r.value;
}

const sameUrl = (a = '', b = '') => a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '');

export interface VoiceForm {
  section: HTMLElement;
  /** Both directions for save(): the one Enabled switch sets both, off is `{enabled: false}`. */
  value(): Record<VoiceModality, Record<string, unknown>>;
  /** Check the key (typed or stored) and load both model lists. */
  discover(): Promise<void>;
  /** After a save: the stored state the form now shows. */
  saved(next: Record<VoiceModality, any>): void;
  dispose(): void;
}

const DIRECTIONS: VoiceModality[] = ['tts', 'stt'];

/**
 * The Voice Models form, built from the Specialized Models kit like Decision
 * Model and Embeddings: ONE Enabled switch for both directions, ONE provider
 * and ONE key, then a text-to-speech model and a speech-to-text model. No
 * voice here: each Provider contact picks its own Voice ID in its Edit pane.
 * Models load when the key or base URL field is left. The request generation
 * owns catalogue AND status writes, including failures.
 */
export function createVoiceForm(saved: Record<VoiceModality, any>, providers: any[], call: VoiceModelsCall): VoiceForm {
  const section = formColumn('voice-form');
  const {container: enabledRow, field: enabled} = toggleRow('voice-enabled', 'Enabled',
    'Voice notes both ways: a Voice ID picker appears on Provider contacts');
  enabled.setValueSilently(!!saved.tts?.enabled && !!saved.stt?.enabled);

  const {container: providerBox, picker: provider} = labelledPicker({
    testId: 'voice-provider', label: 'Provider', placeholder: 'Choose a provider', onChange: () => onProviderChanged()
  });
  const savedProvider = saved.tts?.provider;
  const list = [...providers];
  if(saved.tts?.enabled && savedProvider && !list.some(p => p.id === savedProvider)) list.push({id: savedProvider, label: savedProvider, modalities: DIRECTIONS, needsBaseUrl: savedProvider === 'openai-compatible'});
  provider.setOptions(list.map(p => ({value: p.id, label: p.label})), list.some(p => p.id === savedProvider) ? savedProvider : list[0]?.id);

  const {container: urlBox, input: endpoint} = textField('voice-base-url', 'Base URL (including /v1)', {placeholder: 'https://api.openai.com/v1'});
  const savedUrlFor = (id: string) => saved.tts?.provider === id ? saved.tts.baseUrl || '' : '';
  endpoint.value = savedUrlFor(provider.getValue() || '');
  const {container: keyBox, input: key} = textField('voice-key', 'API key', {secret: true, maxLength: 65536});
  const keyNote = noteLine('voice-key-note');

  const tts = createModelChooser({testId: 'voice-tts-model', label: 'Text-to-speech model', placeholder: 'Enter your key to load models', allowTyped: true});
  const stt = createModelChooser({testId: 'voice-stt-model', label: 'Speech-to-text model', placeholder: 'Enter your key to load models', allowTyped: true});
  const status = noteLine('voice-status', true);
  section.append(enabledRow, providerBox, urlBox, keyBox, keyNote, tts.container, stt.container, status);

  const models: Record<VoiceModality, ModelChooser> = {tts, stt};
  let generation = 0;
  let disposed = false;
  let checked: string | undefined;
  const currentProvider = () => provider.getValue() || '';
  const info = () => list.find(p => p.id === currentProvider());
  const ownEndpoint = () => !!info()?.needsBaseUrl;
  const savedFits = (d: VoiceModality) => currentProvider() === saved[d]?.provider && (!ownEndpoint() || sameUrl(saved[d]?.baseUrl, endpoint.value));
  const storedKey = () => DIRECTIONS.every(d => !!saved[d]?.hasKey && savedFits(d));
  const showFields = () => {
    urlBox.style.display = ownEndpoint() ? '' : 'none';
    showStoredKey(key, storedKey());
    keyNote.textContent = storedKey() ? 'Key saved. Leave empty to keep it. One key for both directions.' : 'One key for both directions.';
  };
  const settingsFor = (d: VoiceModality) => ({enabled: enabled.checked, provider: currentProvider(),
    baseUrl: ownEndpoint() ? endpoint.value.trim() : '', apiKey: key.value, model: models[d].value()});

  function onProviderChanged() {
    generation++;
    checked = undefined;
    key.value = '';
    endpoint.value = savedUrlFor(currentProvider());
    tts.clear('Enter your key to load models');
    stt.clear('Enter your key to load models');
    status.textContent = '';
    showFields();
    if(storedKey()) void discover();
  }

  async function check(d: VoiceModality) {
    return voiceValue(call, 'check', {modality: d, settings: settingsFor(d)});
  }

  async function discover() {
    const ask = `${currentProvider()}|${endpoint.value.trim()}|${key.value.trim()}`;
    if(checked === ask) return;
    if(!key.value.trim() && !storedKey()) return;
    if(ownEndpoint() && !endpoint.value.trim()) return;
    const request = ++generation;
    status.textContent = 'Loading models...';
    try {
      const results = await Promise.all(DIRECTIONS.map(d => check(d).then(r => [d, r] as const)));
      if(disposed || request !== generation) return;
      checked = ask;
      for(const [d, r] of results) {
        if(!r.ok) continue;
        const current = models[d].value() || (savedFits(d) ? saved[d].model : undefined);
        models[d].setModels(r.models.map((m: {id: string}) => m.id), current);
      }
      const failed = results.filter(([, r]) => !r.ok).map(([d, r]) => `${d.toUpperCase()}: ${r.error || 'unavailable'}`);
      status.textContent = failed.join('; ');
    } catch(err) {
      if(!disposed && request === generation) status.textContent = err instanceof Error ? err.message : 'Provider unavailable';
    }
  }

  for(const input of [key, endpoint]) {
    input.addEventListener('input', () => {checked = undefined;});
    input.addEventListener('blur', () => void discover());
  }

  // The saved choice shows without a network call; main cached its lists.
  showFields();
  for(const d of DIRECTIONS) {
    if(!savedFits(d)) continue;
    const savedModels: string[] = (saved[d].models || []).map((m: {id: string}) => m.id);
    if(saved[d].model || savedModels.length) models[d].setModels(savedModels, saved[d].model || undefined);
  }

  return {
    section,
    value: () => Object.fromEntries(DIRECTIONS.map(d => [d, enabled.checked ? settingsFor(d) : {enabled: false}])) as unknown as Record<VoiceModality, Record<string, unknown>>,
    discover,
    saved: (next) => {
      saved = next;
      key.value = '';
      checked = undefined;
      showFields();
    },
    dispose: () => {
      disposed = true;
      generation++;
      key.value = '';
      provider.destroy();
      tts.destroy();
      stt.destroy();
    }
  };
}

export interface ContactVoicePicker {
  container: HTMLElement;
  /** The Voice ID on screen ('' = no voice). */
  value(): string;
  changed(): boolean;
  save(): Promise<void>;
  destroy(): void;
}

/**
 * The gated Voice ID picker of a Provider contact's Edit pane. Undefined
 * (nothing shown) unless the contact runs on this app's engine and has voice
 * models: Voice Models on in Settings (the voices Test and Save stored for
 * the TTS model), or, for a PhantomOps contact, its server's voice models.
 *
 * A PhantomOps server that has not answered yet never hides the picker: it
 * shows disabled as "Loading voices..." and fills in when the server answers
 * (or says it could not, and why). Only a server that answered with no voice
 * models leaves it out.
 */
export async function createContactVoicePicker(pubkey: string, call: VoiceModelsCall | undefined = getDesktopVoiceModels()?.call): Promise<ContactVoicePicker | undefined> {
  if(!call) return undefined;
  const state = await voiceValue(call, 'contact', {pubkey});
  if(!state.persona) return undefined;
  const waiting = !!state.phantomops && !!state.pending;
  const unavailable = !!state.phantomops && typeof state.unavailable === 'string';
  if(!state.enabled && !waiting && !unavailable) return undefined;
  let current = '';
  let destroyed = false;
  const {container, picker} = labelledPicker({testId: 'contact-voice-id', label: 'Voice ID', placeholder: 'No voice', limit: 20});
  const fill = (s: any) => {
    const voices: string[] = Array.isArray(s.voices) ? s.voices : [];
    current = s.voice || '';
    const options = [{value: '', label: 'No voice'}, ...voices.map(v => ({value: v, label: v}))];
    if(current && !voices.includes(current)) options.push({value: current, label: current});
    picker.setPlaceholder('No voice');
    picker.setOptions(options, current);
    picker.setDisabled(false);
  };
  const cannot = (detail: string) => {
    picker.setOptions([]);
    picker.setPlaceholder(`Could not load voices (${detail})`);
    picker.setDisabled(true);
  };
  if(state.enabled) fill(state);
  else if(unavailable) cannot(state.unavailable);
  else {
    picker.setOptions([]);
    picker.setPlaceholder('Loading voices...');
    picker.setDisabled(true);
    void voiceValue(call, 'contact', {pubkey, wait: true}).then((s: any) => {
      if(destroyed) return;
      if(s?.enabled) fill(s);
      else if(typeof s?.unavailable === 'string') cannot(s.unavailable);
      else container.style.display = 'none';
    }, (err: unknown) => {
      if(!destroyed) cannot(err instanceof Error && err.message ? err.message : 'no answer');
    });
  }
  return {
    container,
    value: () => picker.getValue() || '',
    changed: () => (picker.getValue() || '') !== current,
    save: async() => {
      const voice = picker.getValue() || '';
      await voiceValue(call, 'setContact', {pubkey, voice});
      current = voice;
    },
    destroy: () => {
      destroyed = true;
      picker.destroy();
    }
  };
}

export interface NewContactVoicePicker {
  container: HTMLElement;
  /** Show these voices ('No voice' first), or hide the picker (undefined). */
  setVoices(voices: readonly string[] | undefined): void;
  /** The picked Voice ID ('' = no voice, or the picker is hidden). */
  value(): string;
  /** Whether the picker is on screen (it has voices). */
  visible(): boolean;
  destroy(): void;
}

/**
 * The Voice ID picker of the New Contact pane (Provider type): the same
 * picker as the Edit pane, so a voice can be chosen when the contact is
 * created. Hidden until `setVoices` gets a list.
 */
export function createNewContactVoicePicker(): NewContactVoicePicker {
  const {container, picker} = labelledPicker({testId: 'add-contact-voice-id', label: 'Voice ID', placeholder: 'No voice', limit: 20});
  container.style.display = 'none';
  let shown = false;
  return {
    container,
    setVoices: (voices) => {
      shown = !!voices?.length;
      container.style.display = shown ? '' : 'none';
      const previous = picker.getValue() || '';
      const list = voices ?? [];
      picker.setOptions([{value: '', label: 'No voice'}, ...list.map(v => ({value: v, label: v}))], list.includes(previous) ? previous : '');
    },
    value: () => shown ? picker.getValue() || '' : '',
    visible: () => shown,
    destroy: () => picker.destroy()
  };
}

export type PhantombotBridgeCall = (method: string, params?: Record<string, unknown>) => Promise<{ok: boolean; value?: any; error?: {message: string}}>;

/**
 * The voices a new contact on `provider` can pick from, or undefined when it
 * gets no voice picker. A PhantomOps contact uses its server's voice models
 * (asked with the typed token; no Voice Models setup needed); any other
 * Provider contact uses Settings > Voice Models, when that is on.
 */
export async function newContactVoices(provider: string, token: string, bridge: PhantombotBridgeCall,
  call: VoiceModelsCall | undefined = getDesktopVoiceModels()?.call): Promise<string[] | undefined> {
  if(provider === 'phantomops') {
    if(!token) return undefined;
    const r = await bridge('platformModels.check', {apiKey: token}).catch((): undefined => undefined);
    const m = r?.ok ? r.value : undefined;
    const voices: string[] = Array.isArray(m?.tts?.voices) ? m.tts.voices.filter((v: unknown) => typeof v === 'string' && v) : [];
    return m?.status === 'available' && m.stt && voices.length ? voices : undefined;
  }
  if(!call) return undefined;
  const settings = await voiceValue(call, 'get').catch((): undefined => undefined);
  if(!settings?.tts?.enabled || !settings?.stt?.enabled) return undefined;
  const voices: string[] = Array.isArray(settings.tts.voices) ? settings.tts.voices : [];
  return voices.length ? voices : undefined;
}

/** Give a just-created contact its Voice ID (the Edit pane's save, same rules). */
export async function applyNewContactVoice(pubkey: string, voice: string, call: VoiceModelsCall | undefined = getDesktopVoiceModels()?.call): Promise<void> {
  if(!voice) return;
  if(!call) throw new Error('Voice settings unavailable');
  await voiceValue(call, 'setContact', {pubkey, voice});
}
