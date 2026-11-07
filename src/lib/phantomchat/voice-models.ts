import {requestRemoteVoiceModels} from './voice-models-remote';
import {getDesktopVoiceModels} from './desktop-api';
import type {ListPicker} from '@components/listPicker';
import {activeCheck, createModelChooser, el, formColumn, labelledPicker, noteLine, saveButton, showStoredKey, textField, toggleRow, type ModelChooser} from '@components/sidebarLeft/tabs/phantomchatModelKit';
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
  /** Both directions for save(); a direction the provider lacks, or Enabled off, is `{enabled: false}`. */
  value(): Record<VoiceModality, Record<string, unknown>>;
  /** Check the key (typed or stored) and load both model lists. */
  discover(): Promise<void>;
  dispose(): void;
}

const DIRECTIONS: VoiceModality[] = ['tts', 'stt'];

/**
 * The Voice Models form, built from the Specialized Models kit like Decision
 * Model and Embeddings: Enabled, ONE provider and ONE key for both
 * directions (+ Active check), then a TTS model + Voice and an STT model.
 * A provider that serves only one direction shows only that one. Models load
 * when the key or base URL field is left, not from a button. The request
 * generation owns catalogue AND status writes, including failures.
 */
export function createVoiceForm(saved: Record<VoiceModality, any>, providers: any[], call: VoiceModelsCall): VoiceForm {
  const section = formColumn('voice-form');
  const {container: enabledRow, field: enabled} = toggleRow('voice-enabled', 'Enabled',
    'Your assistants answer with voice notes and read the ones you send');
  enabled.setValueSilently(!!(saved.tts?.enabled || saved.stt?.enabled));

  const {container: providerBox, picker: provider} = labelledPicker({
    testId: 'voice-provider', label: 'Provider', placeholder: 'Choose a provider', onChange: () => onProviderChanged()
  });
  // The saved provider: the enabled direction's, TTS first.
  const savedProvider = DIRECTIONS.map(d => saved[d]).find(v => v?.enabled)?.provider ?? saved.tts?.provider;
  const list = [...providers];
  if(savedProvider && !list.some(p => p.id === savedProvider)) list.push({id: savedProvider, label: savedProvider, modalities: DIRECTIONS, needsBaseUrl: savedProvider === 'openai-compatible'});
  provider.setOptions(list.map(p => ({value: p.id, label: p.label})), list.some(p => p.id === savedProvider) ? savedProvider : list[0]?.id);

  const {container: urlBox, input: endpoint} = textField('voice-base-url', 'Base URL (including /v1)', {placeholder: 'https://api.openai.com/v1'});
  const savedUrlFor = (id: string) => DIRECTIONS.map(d => saved[d]).find(v => v?.provider === id && v.baseUrl)?.baseUrl || '';
  endpoint.value = savedUrlFor(provider.getValue() || '');
  const {container: keyBox, input: key} = textField('voice-key', 'API key', {secret: true, maxLength: 65536});
  const active = activeCheck('voice-active');
  const keyNote = noteLine('voice-key-note');

  const tts = createModelChooser({
    testId: 'voice-tts-model', label: 'Text-to-speech model', placeholder: 'Enter your key to load models', allowTyped: true,
    onChange: () => onTtsModelChanged(), onTyped: () => onTtsModelChanged()
  });
  const {container: voiceBox, picker: voice} = labelledPicker({testId: 'voice-tts-voice', label: 'Voice', placeholder: 'Choose a model first'});
  const ttsBox = el('div', 'display:flex;flex-direction:column;gap:.75rem;');
  ttsBox.setAttribute('data-testid', 'voice-tts');
  ttsBox.append(tts.container, voiceBox);
  const stt = createModelChooser({
    testId: 'voice-stt-model', label: 'Speech-to-text model', placeholder: 'Enter your key to load models', allowTyped: true
  });
  const sttBox = el('div', 'display:flex;flex-direction:column;gap:.75rem;');
  sttBox.setAttribute('data-testid', 'voice-stt');
  sttBox.append(stt.container);
  const status = noteLine('voice-status', true);
  section.append(enabledRow, providerBox, urlBox, keyBox, active.container, keyNote, ttsBox, sttBox, status);

  const models: Record<VoiceModality, ModelChooser> = {tts, stt};
  let generation = 0;
  let disposed = false;
  let checked: string | undefined;
  const currentProvider = () => provider.getValue() || '';
  const info = () => list.find(p => p.id === currentProvider());
  const ownEndpoint = () => !!info()?.needsBaseUrl;
  const serves = (d: VoiceModality) => !!info()?.modalities?.includes(d);
  const savedFits = (d: VoiceModality) => currentProvider() === saved[d]?.provider && (!ownEndpoint() || sameUrl(saved[d]?.baseUrl, endpoint.value));
  const storedKeyFits = (d: VoiceModality) => !!saved[d]?.hasKey && savedFits(d);
  const anyStoredKey = () => DIRECTIONS.some(d => serves(d) && storedKeyFits(d));
  const setVoices = (ids: string[], preferred?: string) => {
    voice.setOptions(ids.map(v => ({value: v, label: v})), ids.includes(preferred) ? preferred : ids[0]);
    voice.setDisabled(!ids.length);
    if(!ids.length) voice.setPlaceholder('Choose a model first');
  };
  const showFields = () => {
    urlBox.style.display = ownEndpoint() ? '' : 'none';
    ttsBox.style.display = serves('tts') ? '' : 'none';
    sttBox.style.display = serves('stt') ? '' : 'none';
    showStoredKey(key, anyStoredKey());
    keyNote.textContent = anyStoredKey() ? 'Key saved. Leave empty to keep it. One key for both directions.' : 'One key for both directions.';
  };
  const settingsFor = (d: VoiceModality) => ({enabled: enabled.checked && serves(d), provider: currentProvider(),
    baseUrl: ownEndpoint() ? endpoint.value.trim() : '', apiKey: key.value, model: models[d].value(), voice: d === 'tts' ? voice.getValue() || '' : ''});

  function onProviderChanged() {
    generation++;
    checked = undefined;
    key.value = '';
    endpoint.value = savedUrlFor(currentProvider());
    tts.clear('Enter your key to load models');
    stt.clear('Enter your key to load models');
    setVoices([]);
    status.textContent = '';
    active.set('idle');
    showFields();
    if(anyStoredKey()) void discover();
  }
  function onTtsModelChanged() {
    setVoices([]);
    if(tts.value()) void loadVoices();
  }

  async function check(d: VoiceModality) {
    return voiceValue(call, 'check', {modality: d, settings: settingsFor(d)});
  }

  async function loadVoices() {
    const request = ++generation;
    status.textContent = 'Loading voices...';
    try {
      const r = await check('tts');
      if(disposed || request !== generation) return;
      status.textContent = r.ok ? '' : r.error || 'Provider unavailable';
      setVoices(r.ok ? r.voices : [], voice.getValue() || saved.tts?.voice);
    } catch(err) {
      if(!disposed && request === generation) status.textContent = err instanceof Error ? err.message : 'Provider unavailable';
    }
  }

  async function discover() {
    const ask = `${currentProvider()}|${endpoint.value.trim()}|${key.value.trim()}`;
    if(checked === ask) return;
    const directions = DIRECTIONS.filter(d => serves(d) && (key.value.trim() || storedKeyFits(d)));
    if(!directions.length) return;
    if(ownEndpoint() && !endpoint.value.trim()) return;
    const request = ++generation;
    active.set('checking');
    status.textContent = '';
    try {
      const results = await Promise.all(directions.map(d => check(d).then(r => [d, r] as const)));
      if(disposed || request !== generation) return;
      checked = ask;
      const ok = results.filter(([, r]) => r.ok);
      if(!ok.length) {
        const error = results[0][1].error || 'Provider unavailable';
        active.set(/401|403|wrong key|unauthori[sz]ed|invalid/i.test(error) ? 'invalid' : 'unverified', error);
        setVoices([]);
        return;
      }
      active.set('active');
      for(const [d, r] of results) {
        if(!r.ok) continue;
        const current = models[d].value() || (savedFits(d) ? saved[d].model : undefined);
        models[d].setModels(r.models.map((m: {id: string}) => m.id), current);
      }
      const failed = results.filter(([, r]) => !r.ok).map(([d, r]) => `${d.toUpperCase()}: ${r.error || 'unavailable'}`);
      status.textContent = failed.join('; ');
      if(serves('tts') && tts.value()) await loadVoices();
    } catch(err) {
      if(!disposed && request === generation) active.set('unverified', err instanceof Error ? err.message : 'Provider unavailable');
    }
  }

  for(const input of [key, endpoint]) {
    input.addEventListener('input', () => {checked = undefined;});
    input.addEventListener('blur', () => void discover());
  }
  enabled.input.addEventListener('change', () => {generation++;});

  // The saved choice shows without a network call; main cached its lists.
  showFields();
  for(const d of DIRECTIONS) {
    if(!savedFits(d)) continue;
    const savedModels: string[] = (saved[d].models || []).map((m: {id: string}) => m.id);
    if(saved[d].model || savedModels.length) models[d].setModels(savedModels, saved[d].model || undefined);
  }
  if(savedFits('tts')) setVoices(saved.tts.voices || [], saved.tts.voice);
  // A stored key is checked straight away: the Active check is live, not remembered.
  if(anyStoredKey()) void discover();

  return {
    section,
    value: () => Object.fromEntries(DIRECTIONS.map(d => [d, enabled.checked && serves(d) ? settingsFor(d) : {enabled: false}])) as unknown as Record<VoiceModality, Record<string, unknown>>,
    discover,
    dispose: () => {
      disposed = true;
      generation++;
      key.value = '';
      provider.destroy();
      tts.destroy();
      stt.destroy();
      voice.destroy();
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
  let voicePicker: ListPicker | undefined;
  const disabled: VoiceModality[] = [];
  const box = formColumn('contact-voice-models');
  for(const d of ['tts', 'stt'] as const) {
    const settings = state.settings[d];
    if(!settings.enabled) continue;
    let onModelChange = () => {};
    const {container, picker} = labelledPicker({testId: `contact-${d}-model`, label: `${d.toUpperCase()} model`, placeholder: 'Use default', limit: 20,
      onChange: () => onModelChange()});
    picker.setOptions([
      {value: '', label: 'Use default', hint: settings.model},
      ...settings.models.map((m: {id: string}) => ({value: m.id, label: m.id}))
    ], state.overrides[d]?.model || '');
    const target = remote?.[d];
    // A remote engine stores a Pi preset as the transport it runs on.
    const transport = settings.transport ?? {provider: settings.provider, baseUrl: settings.baseUrl};
    const remoteCompatible = target?.available && target.provider === transport.provider && sameUrl(target.baseUrl, transport.baseUrl);
    if(!state.persona && !remoteCompatible) {
      picker.setDisabled(true);
      disabled.push(d);
    }
    pickers[d] = picker;
    box.append(container);
    if(d === 'tts' && state.persona) {
      // Gated: only a contact on this app's engine, with TTS on, and only once
      // the chosen model lists voices.
      const voiceBox = labelledPicker({testId: 'contact-tts-voice', label: 'Voice ID', placeholder: 'Use default', limit: 20});
      voiceBox.container.style.display = 'none';
      voicePicker = voiceBox.picker;
      box.append(voiceBox.container);
      let request = 0;
      const loadVoices = async(preferred: string) => {
        const mine = ++request;
        const model = picker.getValue() || settings.model;
        let voices: string[] = [];
        try {
          const r = await voiceValue(call, 'check', {modality: 'tts', settings: {...settings, enabled: false, model, voice: ''}});
          voices = r.ok && Array.isArray(r.voices) ? r.voices : [];
        } catch{/* No list: the picker stays hidden. */}
        if(mine !== request) return;
        voiceBox.picker.setOptions([{value: '', label: 'Use default', hint: picker.getValue() ? undefined : settings.voice}, ...voices.map(v => ({value: v, label: v}))],
          voices.includes(preferred) ? preferred : '');
        voiceBox.container.style.display = voices.length ? '' : 'none';
      };
      onModelChange = () => void loadVoices('');
      void loadVoices(state.overrides.tts?.voice || '');
    }
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
      if(state.persona) await voiceValue(call, 'setContact', {pubkey, models, voices: {tts: voicePicker?.getValue() || ''}});
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
