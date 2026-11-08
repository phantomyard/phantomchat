/*
 * Provider contacts: change the main provider and model after the contact
 * was created (contact Edit pane, desktop only). Same parts as the
 * Specialized Models screens: Provider -> Token (dots when one is stored) ->
 * Model -> Voice ID (only when Voice Models is on) -> status -> ONE Save.
 * Save tests a new token before it is written.
 *
 * The stored token never reaches the page: `persona.brain` says what is
 * configured and whether a token is stored, `persona.brainCheck` checks that
 * stored token inside the engine (only with its own provider). A typed token
 * is checked with `providers.check`, as on the add-contact pane.
 */
import {
  createModelChooser,
  formColumn,
  labelledPicker,
  noteLine,
  saveButton,
  showStoredKey,
  textField
} from '@components/sidebarLeft/tabs/phantomchatModelKit';
import type {ContactVoicePicker} from '@lib/phantomchat/voice-models';
import {
  checkProviderKey,
  listProviderOptions,
  type BridgeCall,
  type ProviderCheckResult,
  type ProviderOption
} from '@lib/phantomchat/provider-contacts';

interface BrainInfo {provider?: string; model?: string; hasKey: boolean}

async function value<T>(call: BridgeCall, method: string, params?: Record<string, unknown>): Promise<T> {
  const res = await call(method, params);
  if(!res?.ok) throw new Error((res as any)?.error?.message ?? `${method} failed`);
  return res.value as T;
}

export interface ProviderModelEditor {
  section: HTMLElement;
  save(): Promise<void>;
  destroy(): void;
}

/**
 * Mount the editor for `persona` into `parent`. Resolves to undefined (and
 * mounts nothing) when this app's engine cannot read a persona's brain yet.
 */
export async function mountProviderModelEditor(parent: HTMLElement, persona: string, call: BridgeCall,
  opts: {voice?: ContactVoicePicker} = {}): Promise<ProviderModelEditor | undefined> {
  const voice = opts.voice;
  let brain: BrainInfo;
  let providers: ProviderOption[];
  try {
    [brain, providers] = await Promise.all([value<BrainInfo>(call, 'persona.brain', {persona}), listProviderOptions(call)]);
  } catch{
    return undefined;
  }
  if(brain.provider && !providers.some((p) => p.id === brain.provider)) {
    providers = [...providers, {id: brain.provider, label: brain.provider, keyOptional: false, checkable: false, autoModel: false}];
  }

  const section = formColumn('provider-contact-model');
  const {container: providerBox, picker: providerPicker} = labelledPicker({
    testId: 'provider-contact-provider', label: 'Provider', placeholder: 'Choose a provider', onChange: () => onProviderChanged()
  });
  providerPicker.setOptions(providers.map((p) => ({value: p.id, label: p.label})), brain.provider ?? providers[0]?.id);
  const {container: keyBox, input: keyInput} = textField('provider-contact-token', 'Token', {secret: true, maxLength: 4096});
  const keyNote = noteLine('provider-contact-token-note');
  const models = createModelChooser({testId: 'provider-contact-model-picker', placeholder: 'Enter the token to load models', allowTyped: true});
  const status = noteLine('provider-contact-status', true);
  const saveBtn = saveButton('provider-contact-save', 'Save');
  section.append(providerBox, keyBox, keyNote, models.container, ...(voice ? [voice.container] : []), status, saveBtn);

  let generation = 0;
  let checked: string | undefined;
  let busy = false;
  const current = () => providers.find((p) => p.id === providerPicker.getValue());
  const storedFits = () => brain.hasKey && current()?.id === brain.provider;
  const showFields = () => {
    const p = current();
    showStoredKey(keyInput, storedFits());
    keyNote.textContent = storedFits() ? 'Token saved. Leave empty to keep it.' :
      brain.hasKey ? `A new provider needs its own token; the saved one stays with ${brain.provider}.` : '';
    models.container.style.display = p?.autoModel ? 'none' : '';
  };

  let lastCheck: ProviderCheckResult | undefined;
  const showResult = (p: ProviderOption, r: ProviderCheckResult) => {
    lastCheck = r;
    if(r.status === 'invalid') {
      status.textContent = `Token rejected (${r.detail})`;
      models.clear('Enter the token to load models');
      return;
    }
    status.textContent = '';
    const preferred = models.value() || (p.id === brain.provider ? brain.model : p.defaultModel);
    models.setModels(r.models.map((m) => m.id), preferred);
  };

  async function check(): Promise<void> {
    const p = current();
    if(!p) return;
    const token = keyInput.value.trim();
    const ask = `${p.id}|${token}`;
    if(checked === ask) return;
    if(!token && !storedFits() && !p.keyOptional) return;
    const mine = ++generation;
    lastCheck = undefined;
    status.textContent = 'Loading models...';
    try {
      const r = token || !storedFits() ?
        await checkProviderKey(call, p.id, token) :
        await value<ProviderCheckResult>(call, 'persona.brainCheck', {persona});
      if(mine !== generation) return;
      checked = ask;
      showResult(p, {status: r.status, detail: r.detail ?? '', models: Array.isArray(r.models) ? r.models : []});
    } catch(err) {
      if(mine === generation) status.textContent = `Could not check the token (${err instanceof Error ? err.message : 'no answer'})`;
    }
  }

  function onProviderChanged() {
    ++generation;
    checked = undefined;
    keyInput.value = '';
    status.textContent = '';
    lastCheck = undefined;
    models.clear('Enter the token to load models');
    showFields();
    const p = current();
    if(p?.id === brain.provider && brain.model) models.setModels([brain.model], brain.model);
    void check();
  }

  keyInput.addEventListener('input', () => {
    checked = undefined;
  });
  keyInput.addEventListener('blur', () => void check());

  async function save(): Promise<void> {
    const p = current();
    if(busy || !p) return;
    busy = true;
    saveBtn.disabled = true;
    try {
      const token = keyInput.value.trim();
      const model = p.autoModel ? p.defaultModel : models.value();
      if(!model) {
        status.textContent = 'Choose a model';
        return;
      }
      if(!token && !storedFits() && !p.keyOptional) {
        status.textContent = `Enter the ${p.label} token`;
        return;
      }
      const brainChanged = p.id !== brain.provider || model !== brain.model || !!token;
      const voiceChanged = !!voice?.changed();
      if(!brainChanged && !voiceChanged) {
        status.textContent = 'Nothing to save';
        return;
      }
      const done: string[] = [];
      if(brainChanged) {
        // A new token is tested before it is written.
        if(token && (checked !== `${p.id}|${token}` || !lastCheck)) {
          checked = undefined;
          await check();
        }
        if(token && !lastCheck) {
          status.textContent = 'Not saved: the token could not be tested';
          return;
        }
        if(token && lastCheck?.status === 'invalid') {
          status.textContent = `Not saved: the provider rejected this token (${lastCheck.detail})`;
          return;
        }
        status.textContent = 'Saving...';
        await value(call, 'persona.configure', {
          persona,
          config: {brain: {chain: ['native'], native: {provider: p.id, model, ...(token ? {apiKey: token} : {})}}}
        });
        brain = {provider: p.id, model, hasKey: brain.hasKey && p.id === brain.provider || !!token};
        keyInput.value = '';
        checked = undefined;
        showFields();
        done.push(`now on ${p.label} (${model})`);
      }
      if(voiceChanged) {
        status.textContent = 'Saving voice...';
        await voice!.save();
        done.push(voice!.value() ? `voice ${voice!.value()}` : 'no voice');
      }
      status.textContent = `Saved: ${done.join(', ')}`;
    } catch(err) {
      status.textContent = err instanceof Error ? err.message : 'Could not save';
    } finally {
      busy = false;
      saveBtn.disabled = false;
    }
  }
  saveBtn.addEventListener('click', () => void save());

  showFields();
  if(brain.model && current()?.id === brain.provider) models.setModels([brain.model], brain.model);
  parent.append(section);
  // A stored token loads the model list straight away.
  void check();

  return {
    section,
    save,
    destroy: () => {
      ++generation;
      keyInput.value = '';
      providerPicker.destroy();
      models.destroy();
      voice?.destroy();
    }
  };
}
