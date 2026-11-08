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
 * (nothing shown) unless Voice Models is on in Settings and the contact runs
 * on this app's engine. The voices are the ones Test and Save stored for the
 * TTS model, so the list needs no network call.
 */
export async function createContactVoicePicker(pubkey: string, call: VoiceModelsCall | undefined = getDesktopVoiceModels()?.call): Promise<ContactVoicePicker | undefined> {
  if(!call) return undefined;
  const state = await voiceValue(call, 'contact', {pubkey});
  if(!state.persona || !state.enabled) return undefined;
  const voices: string[] = Array.isArray(state.voices) ? state.voices : [];
  let current: string = state.voice || '';
  const {container, picker} = labelledPicker({testId: 'contact-voice-id', label: 'Voice ID', placeholder: 'No voice', limit: 20});
  const options = [{value: '', label: 'No voice'}, ...voices.map(v => ({value: v, label: v}))];
  if(current && !voices.includes(current)) options.push({value: current, label: current});
  picker.setOptions(options, current);
  return {
    container,
    value: () => picker.getValue() || '',
    changed: () => (picker.getValue() || '') !== current,
    save: async() => {
      const voice = picker.getValue() || '';
      await voiceValue(call, 'setContact', {pubkey, voice});
      current = voice;
    },
    destroy: () => picker.destroy()
  };
}
