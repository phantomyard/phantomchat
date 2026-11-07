/*
 * Provider contacts: change the main provider and model after the contact
 * was created (contact info, desktop only). Same parts as the Specialized
 * Models screens: Provider -> Token (dots when one is stored) + Active check
 * -> Model -> status -> Save.
 *
 * The stored token never reaches the page: `persona.brain` says what is
 * configured and whether a token is stored, `persona.brainCheck` checks that
 * stored token inside the engine (only with its own provider). A typed token
 * is checked with `providers.check`, as on the add-contact pane.
 */
import {
  activeCheck,
  createModelChooser,
  formColumn,
  labelledPicker,
  noteLine,
  saveButton,
  showStoredKey,
  textField
} from '@components/sidebarLeft/tabs/phantomchatModelKit';
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
export async function mountProviderModelEditor(parent: HTMLElement, persona: string, call: BridgeCall): Promise<ProviderModelEditor | undefined> {
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
  const active = activeCheck('provider-contact-active');
  const keyNote = noteLine('provider-contact-token-note');
  const models = createModelChooser({testId: 'provider-contact-model-picker', placeholder: 'Enter the token to load models', allowTyped: true});
  const status = noteLine('provider-contact-status', true);
  const saveBtn = saveButton('provider-contact-save', 'Save provider and model');
  section.append(providerBox, keyBox, active.container, keyNote, models.container, status, saveBtn);

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

  const showResult = (p: ProviderOption, r: ProviderCheckResult) => {
    if(r.status === 'invalid') {
      active.set('invalid', r.detail);
      models.clear('Enter the token to load models');
      return;
    }
    active.set(r.status === 'verified' ? 'active' : 'unverified', r.detail);
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
    active.set('checking');
    try {
      const r = token || !storedFits() ?
        await checkProviderKey(call, p.id, token) :
        await value<ProviderCheckResult>(call, 'persona.brainCheck', {persona});
      if(mine !== generation) return;
      checked = ask;
      showResult(p, {status: r.status, detail: r.detail ?? '', models: Array.isArray(r.models) ? r.models : []});
    } catch(err) {
      if(mine === generation) active.set('unverified', err instanceof Error ? err.message : 'could not check the token');
    }
  }

  function onProviderChanged() {
    ++generation;
    checked = undefined;
    keyInput.value = '';
    status.textContent = '';
    active.set('idle');
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
      if(active.state() === 'invalid') {
        status.textContent = 'The provider rejected this token';
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
      status.textContent = `Now on ${p.label} (${model})`;
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
  // A stored token is checked straight away: the Active check is live.
  void check();

  return {
    section,
    save,
    destroy: () => {
      ++generation;
      keyInput.value = '';
      providerPicker.destroy();
      models.destroy();
    }
  };
}
