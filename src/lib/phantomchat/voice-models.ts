import {requestRemoteVoiceModels} from './voice-models-remote';
import {getDesktopVoiceModels} from './desktop-api';
import type {ListPicker} from '@components/listPicker';
import {createModelChooser, formColumn, labelledPicker, noteLine, saveButton, textField, toggleRow} from '@components/sidebarLeft/tabs/phantomchatModelKit';
export type VoiceModality = 'tts' | 'stt';
export type VoiceModelsCall = (method: string, params?: unknown) => Promise<{ok: boolean; value?: any; error?: {message: string}}>;
export async function voiceValue(call: VoiceModelsCall, method: string, params?: unknown) {
  const r = await call(method, params);
  if(!r.ok) throw new Error(r.error?.message || 'Voice settings unavailable');
  return r.value;
}

const sameUrl = (a = '', b = '') => a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '');

export interface VoiceDirectionForm {
  section: HTMLElement;
  /** The direction's settings for save(); `{enabled: false}` when off. */
  value(): Record<string, unknown>;
  dispose(): void;
}

/**
 * One direction (TTS or STT), built from the Specialized Models kit like the
 * Decision Model form: Enabled Row, Provider, Base URL, API key + note, Model
 * (typed id when the provider has no catalogue), Voice (TTS), status. Models
 * load when the key or base URL field is left, not from a button. The request
 * generation owns catalogue AND status writes, including failures.
 */
export function createVoiceDirectionForm(modality: VoiceModality, saved: any, providers: any[], call: VoiceModelsCall): VoiceDirectionForm {
  const id = `voice-${modality}`;
  const section = formColumn(`${id}-form`);
  const {container: enabledRow, field: enabled} = toggleRow(`${id}-enabled`, 'Enabled',
    modality === 'tts' ? 'Your assistants can answer with a voice note' : 'Your assistants can read your voice notes');
  enabled.setValueSilently(!!saved.enabled);

  const available = providers.filter(p => p.modalities.includes(modality));
  const {container: providerBox, picker: provider} = labelledPicker({
    testId: `${id}-provider`, label: 'Provider', placeholder: 'Choose a provider', onChange: () => onProviderChanged()
  });
  provider.setOptions(available.map(p => ({value: p.id, label: p.label})),
    available.some(p => p.id === saved.provider) ? saved.provider : available[0]?.id);

  const {container: urlBox, input: endpoint} = textField(`${id}-base-url`, 'Base URL (including /v1)', {placeholder: 'https://api.openai.com/v1'});
  endpoint.value = saved.baseUrl || '';
  const {container: keyBox, input: key} = textField(`${id}-key`, 'API key', {secret: true, maxLength: 65536});
  const keyNote = noteLine(`${id}-key-note`);

  const model = createModelChooser({
    testId: `${id}-model`, placeholder: 'Enter your key to load models', allowTyped: true,
    onChange: () => onModelChanged(), onTyped: () => onModelChanged()
  });
  const voiceBox = modality === 'tts' ? labelledPicker({testId: `${id}-voice`, label: 'Voice', placeholder: 'Choose a model first'}) : undefined;
  const voice = voiceBox?.picker;
  const status = noteLine(`${id}-status`, true);
  section.append(enabledRow, providerBox, urlBox, keyBox, keyNote, model.container, ...(voiceBox ? [voiceBox.container] : []), status);

  let generation = 0;
  let disposed = false;
  let checked: string | undefined;
  const currentProvider = () => provider.getValue() || '';
  const compatible = () => currentProvider() === 'openai-compatible';
  const savedFits = () => currentProvider() === saved.provider && (!compatible() || sameUrl(saved.baseUrl, endpoint.value));
  const storedKeyFits = () => !!saved.hasKey && savedFits();
  const setVoices = (ids: string[], preferred?: string) => {
    if(!voice) return;
    voice.setOptions(ids.map(v => ({value: v, label: v})), ids.includes(preferred) ? preferred : ids[0]);
    voice.setDisabled(!ids.length);
    if(!ids.length) voice.setPlaceholder('Choose a model first');
  };
  const showFields = () => {
    urlBox.style.display = compatible() ? '' : 'none';
    keyNote.textContent = storedKeyFits() ? 'Key saved. Leave empty to keep it.' : '';
  };
  const value = () => ({enabled: enabled.checked, provider: currentProvider(), baseUrl: compatible() ? endpoint.value.trim() : '',
    apiKey: key.value, model: model.value(), voice: voice?.getValue() || ''});

  function onProviderChanged() {
    generation++;
    checked = undefined;
    key.value = '';
    endpoint.value = currentProvider() === saved.provider ? saved.baseUrl || '' : '';
    model.clear('Enter your key to load models');
    setVoices([]);
    status.textContent = '';
    showFields();
    if(storedKeyFits()) void discover(false);
  }
  function onModelChanged() {
    if(!voice) return;
    setVoices([]);
    if(model.value()) void discover(true);
  }

  async function discover(keepModel: boolean) {
    const ask = `${currentProvider()}|${endpoint.value.trim()}|${key.value.trim()}`;
    if(!keepModel && checked === ask) return;
    if(!key.value.trim() && !storedKeyFits()) return;
    if(compatible() && !endpoint.value.trim()) return;
    const request = ++generation;
    status.textContent = keepModel ? 'Loading voices...' : 'Loading models...';
    try {
      const check = await voiceValue(call, 'check', {modality, settings: value()});
      if(disposed || request !== generation) return;
      if(!check.ok) {
        status.textContent = check.error || 'Provider unavailable';
        setVoices([]);
        return;
      }
      checked = ask;
      if(!keepModel) {
        const current = model.value() || (savedFits() ? saved.model : undefined);
        model.setModels(check.models.map((m: {id: string}) => m.id), current);
      }
      setVoices(check.voices, voice?.getValue() || saved.voice);
      status.textContent = check.models.length ? 'Key verified' : 'No model list from this provider: type a model ID';
      if(!keepModel && voice && !check.voices.length && model.value()) void discover(true);
    } catch(err) {
      if(!disposed && request === generation) status.textContent = err instanceof Error ? err.message : 'Provider unavailable';
    }
  }

  for(const input of [key, endpoint]) {
    input.addEventListener('input', () => {checked = undefined;});
    input.addEventListener('blur', () => void discover(false));
  }
  enabled.input.addEventListener('change', () => {generation++;});

  // The saved choice shows without a network call; main cached its lists.
  showFields();
  const savedModels: string[] = (saved.models || []).map((m: {id: string}) => m.id);
  if(saved.model || savedModels.length) model.setModels(savedModels, saved.model || undefined);
  setVoices(saved.voices || [], saved.voice);

  return {
    section,
    value: () => enabled.checked ? value() : {enabled: false},
    dispose: () => {
      disposed = true;
      generation++;
      key.value = '';
      provider.destroy();
      model.destroy();
      voice?.destroy();
    }
  };
}

/** Shared by both Phantom and Provider editors. No keys enter contact prefs. */
export async function mountContactVoiceModels(parent: HTMLElement, pubkey: string, call: VoiceModelsCall = getDesktopVoiceModels()?.call) {
  if(!call) return;
  const state = await voiceValue(call, 'contact', {pubkey});
  let remote: any;
  if(!state.persona && Object.values(state.settings).some((v: any) => v.enabled)) {
    try {remote = await requestRemoteVoiceModels(pubkey, 'get');} catch{/* Shown as unavailable below. */}
  }
  const pickers: Partial<Record<VoiceModality, ListPicker>> = {};
  const disabled: VoiceModality[] = [];
  const box = formColumn('contact-voice-models');
  for(const d of ['tts', 'stt'] as const) {
    const settings = state.settings[d];
    if(!settings.enabled) continue;
    const {container, picker} = labelledPicker({testId: `contact-${d}-model`, label: `${d.toUpperCase()} model`, placeholder: 'Use default', limit: 20});
    picker.setOptions([
      {value: '', label: 'Use default', hint: settings.model},
      ...settings.models.map((m: {id: string}) => ({value: m.id, label: m.id}))
    ], state.overrides[d]?.model || '');
    const target = remote?.[d];
    const remoteCompatible = target?.available && target.provider === settings.provider && sameUrl(target.baseUrl, settings.baseUrl);
    if(!state.persona && !remoteCompatible) {
      picker.setDisabled(true);
      disabled.push(d);
    }
    pickers[d] = picker;
    box.append(container);
  }
  if(!Object.keys(pickers).length) return;
  const status = noteLine('contact-voice-status', true);
  if(disabled.length) status.textContent = 'Remote voice configuration unavailable. Its engine must support Voice Models and have the Settings provider endpoint/key configured in its TUI.';
  const save = saveButton('contact-voice-save', 'Save voice models');
  save.disabled = disabled.length > 0;
  box.append(status, save);
  save.addEventListener('click', async() => {
    save.disabled = true;
    try {
      const models = Object.fromEntries(Object.entries(pickers).map(([d, picker]) => [d, picker.getValue() || '']));
      if(state.persona) await voiceValue(call, 'setContact', {pubkey, models});
      else {
        const plan = await voiceValue(call, 'remotePlan', {pubkey, models});
        await requestRemoteVoiceModels(pubkey, 'set', plan);
        await voiceValue(call, 'saveRemote', {pubkey, models});
      }
      status.textContent = 'Voice models saved';
    } catch(err) {status.textContent = err instanceof Error ? err.message : 'Could not save voice models';}
    finally {save.disabled = disabled.length > 0;}
  });
  parent.append(box);
}

/** Existing Phantom contacts inherit defaults even before they have an override. */
export async function listPhantomVoiceTargets(): Promise<string[]> {
  const [{getAllMappings, listDeletedPeers}, {resolveContactKindForPeer}] = await Promise.all([
    import('./virtual-peers-db'), import('./contact-kind')
  ]);
  const [mappings, deleted] = await Promise.all([getAllMappings(), listDeletedPeers()]);
  const tombstones = new Map(deleted.map(row => [row.pubkey, row.deletedAt]));
  const own = (window as any).__phantomchatOwnPubkey;
  const targets = await Promise.all(mappings.map(async m => {
    if(m.pubkey === own || !/^[0-9a-f]{64}$/.test(m.pubkey) || (tombstones.get(m.pubkey) || 0) >= (m.deliberateAddAt || 0) && tombstones.has(m.pubkey)) return null;
    return (await resolveContactKindForPeer(m.pubkey, !!m.nostrProfile?.bot)).kind === 'phantom' ? m.pubkey : null;
  }));
  return [...new Set(targets.filter((pubkey): pubkey is string => !!pubkey))];
}

export async function applyRemoteVoiceDefaults(targets: string[], registered: string[], call: VoiceModelsCall, progress?: (done: number, total: number) => void) {
  const pending = [...new Set(targets)];
  const known = new Set(registered);
  const failures: string[] = [];
  let next = 0, done = 0, applied = 0;
  await Promise.all(Array.from({length: Math.min(3, pending.length)}, async() => {
    while(next < pending.length) {
      const pubkey = pending[next++];
      try {
        const contact = await voiceValue(call, 'contact', {pubkey});
        if(!contact.persona) {
          await requestRemoteVoiceModels(pubkey, 'set', await voiceValue(call, 'remotePlan', {pubkey}));
          if(!known.has(pubkey)) await voiceValue(call, 'saveRemote', {pubkey, models: {}});
          applied++;
        }
      } catch{failures.push(`Remote ${pubkey.slice(0, 8)}`);}
      progress?.(++done, pending.length);
    }
  }));
  return {applied, failures};
}
