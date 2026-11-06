import {requestRemoteVoiceModels} from './voice-models-remote';
import {getDesktopVoiceModels} from './desktop-api';
export type VoiceModality = 'tts' | 'stt';
export type VoiceModelsCall = (method: string, params?: unknown) => Promise<{ok: boolean; value?: any; error?: {message: string}}>;
export async function voiceValue(call: VoiceModelsCall, method: string, params?: unknown) {
  const r = await call(method, params);
  if(!r.ok) throw new Error(r.error?.message || 'Voice settings unavailable');
  return r.value;
}

function field(parent: HTMLElement, title: string, type = 'text') {
  const label = document.createElement('label');
  label.textContent = title;
  label.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin:16px 0';
  const input = document.createElement('input');
  input.type = type;
  input.className = 'input-field-input';
  label.append(input); parent.append(label);
  return input;
}
function select(parent: HTMLElement, title: string) {
  const label = document.createElement('label');
  label.textContent = title;
  label.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin:16px 0';
  const input = document.createElement('select');
  input.className = 'input-field-input';
  input.style.cssText = 'width:100%;min-width:0;color:inherit;background:var(--surface-color);padding:12px';
  label.append(input); parent.append(label);
  return input;
}
function options(input: HTMLSelectElement, ids: string[], current = '') {
  input.replaceChildren(...ids.map(id => new Option(id, id)));
  input.value = ids.includes(current) ? current : ids[0] || '';
}

/** The request generation owns catalogue AND status writes, including failures. */
export function createVoiceDirectionForm(parent: HTMLElement, modality: VoiceModality, saved: any, providers: any[], call: VoiceModelsCall) {
  const section = document.createElement('fieldset');
  section.style.cssText = 'min-width:0;border:0;padding:16px';
  const legend = document.createElement('legend'); legend.textContent = modality === 'tts' ? 'Text-to-speech (TTS)' : 'Speech-to-text (STT)';
  section.append(legend); parent.append(section);
  const enabled = field(section, 'Enabled', 'checkbox'); enabled.checked = saved.enabled;
  const controls = document.createElement('div'); section.append(controls);
  const provider = select(controls, 'Provider');
  const available = providers.filter(p => p.modalities.includes(modality));
  provider.replaceChildren(...available.map(p => new Option(p.label, p.id))); provider.value = saved.provider;
  const endpoint = field(controls, 'Base URL (including /v1)'); endpoint.value = saved.baseUrl;
  const key = field(controls, 'API key (leave blank to keep saved key)', 'password'); key.autocomplete = 'off'; key.placeholder = saved.hasKey ? 'Key saved' : '';
  const load = document.createElement('button'); load.type = 'button'; load.className = 'btn-primary'; load.textContent = 'Load models'; controls.append(load);
  const model = select(controls, 'Model'); options(model, (saved.models || []).map((m: {id: string}) => m.id), saved.model);
  if(saved.model && !model.value) options(model, [saved.model], saved.model);
  const typed = field(controls, 'Model ID (when the provider has no catalogue)'); typed.value = saved.model;
  typed.parentElement.hidden = saved.models?.length > 0;
  const voice = modality === 'tts' ? select(controls, 'Voice') : undefined;
  if(voice) options(voice, saved.voices || [], saved.voice);
  const status = document.createElement('p'); status.setAttribute('role', 'status'); section.append(status);
  let generation = 0;
  let disposed = false;
  const value = () => ({enabled: enabled.checked, provider: provider.value, baseUrl: endpoint.value.trim(), apiKey: key.value,
    model: model.value || typed.value.trim(), voice: voice?.value || ''});
  const updateEnabled = () => {
    controls.hidden = !enabled.checked;
    endpoint.parentElement.hidden = provider.value !== 'openai-compatible';
  };
  enabled.addEventListener('change', () => {generation++; updateEnabled();});
  const invalidate = () => {generation++; options(model, []); typed.value = ''; if(voice) options(voice, []); status.textContent = '';};
  provider.addEventListener('change', () => {key.value = ''; invalidate(); endpoint.value = provider.value === saved.provider ? saved.baseUrl : ''; updateEnabled();});
  endpoint.addEventListener('input', () => {key.value = ''; invalidate();}); key.addEventListener('input', invalidate);
  async function discover(keepModel: boolean) {
    const request = ++generation;
    status.textContent = 'Loading…';
    try {
      const check = await voiceValue(call, 'check', {modality, settings: value()});
      if(disposed || request !== generation) return;
      if(!check.ok) {status.textContent = check.error || 'Provider unavailable'; if(voice) options(voice, []); return;}
      const current = model.value || typed.value;
      if(!keepModel) options(model, check.models.map((m: {id: string}) => m.id), current);
      typed.parentElement.hidden = check.models.length > 0;
      if(model.value) typed.value = model.value;
      if(voice) options(voice, check.voices, voice.value || saved.voice);
      status.textContent = check.models.length ? '' : 'No catalogue returned. Enter a model ID, then load its voices.';
      if(!keepModel && voice && !check.voices.length && model.value) void discover(true);
    } catch(err) {
      if(!disposed && request === generation) status.textContent = err instanceof Error ? err.message : 'Provider unavailable';
    }
  }
  load.addEventListener('click', () => void discover(false));
  model.addEventListener('change', () => {typed.value = model.value; if(voice) {options(voice, []); void discover(true);}});
  typed.addEventListener('input', () => {generation++; if(voice) options(voice, []); status.textContent = '';});
  updateEnabled();
  return {value: () => enabled.checked ? value() : {enabled: false}, dispose: () => {disposed = true; generation++; key.value = '';}};
}

/** Shared by both Phantom and Provider editors. No keys enter contact prefs. */
export async function mountContactVoiceModels(parent: HTMLElement, pubkey: string, call: VoiceModelsCall = getDesktopVoiceModels()?.call) {
  if(!call) return;
  const state = await voiceValue(call, 'contact', {pubkey});
  let remote: any;
  if(!state.persona && Object.values(state.settings).some((v: any) => v.enabled)) {
    try {remote = await requestRemoteVoiceModels(pubkey, 'get');} catch{/* Shown as unavailable below. */}
  }
  const controls: Partial<Record<VoiceModality, HTMLSelectElement>> = {};
  const box = document.createElement('div'); box.style.padding = '16px';
  for(const d of ['tts', 'stt'] as const) {
    const settings = state.settings[d];
    if(!settings.enabled) continue;
    const input = select(box, `${d.toUpperCase()} Model`);
    input.dataset.testid = `contact-${d}-model`;
    input.append(new Option(`Use default (${settings.model})`, ''));
    input.append(...settings.models.map((m: {id: string}) => new Option(m.id, m.id)));
    input.value = state.overrides[d]?.model || '';
    const target = remote?.[d];
    const remoteCompatible = target?.available && target.provider === settings.provider && target.baseUrl.replace(/\/+$/, '') === settings.baseUrl.replace(/\/+$/, '');
    input.disabled = !state.persona && !remoteCompatible;
    controls[d] = input;
  }
  if(!Object.keys(controls).length) return;
  const status = document.createElement('p'); status.setAttribute('role', 'status'); box.append(status);
  if(!state.persona && Object.values(controls).some(input => input.disabled)) status.textContent = 'Remote voice configuration unavailable. Its engine must support Voice Models and have the Settings provider endpoint/key configured in its TUI.';
  const save = document.createElement('button'); save.type = 'button'; save.className = 'btn-primary'; save.textContent = 'Save voice models'; save.disabled = Object.values(controls).some(input => input.disabled); box.append(save);
  save.addEventListener('click', async() => {
    save.disabled = true;
    try {
      const models = Object.fromEntries(Object.entries(controls).map(([d, input]) => [d, input.value]));
      if(state.persona) await voiceValue(call, 'setContact', {pubkey, models});
      else {
        const plan = await voiceValue(call, 'remotePlan', {pubkey, models});
        await requestRemoteVoiceModels(pubkey, 'set', plan);
        await voiceValue(call, 'saveRemote', {pubkey, models});
      }
      status.textContent = 'Voice models saved';
    } catch(err) {status.textContent = err instanceof Error ? err.message : 'Could not save voice models';}
    finally {save.disabled = Object.values(controls).some(input => input.disabled);}
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
