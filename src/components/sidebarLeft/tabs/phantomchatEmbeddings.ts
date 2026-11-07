import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import {
  activeCheck,
  appliedLine,
  createModelChooser,
  el,
  formColumn,
  labelledPicker,
  NOTE_CSS,
  noteLine,
  saveButton,
  showStoredKey,
  textField,
  toggleRow
} from '@components/sidebarLeft/tabs/phantomchatModelKit';
import {
  getDesktopEmbeddings,
  type DesktopEmbeddingsApi,
  type EmbeddingsProvider,
  type EmbeddingsProviderInfo,
  type EmbeddingsState
} from '@lib/phantomchat/desktop-api';

/*
 * Desktop only (Settings > Specialized Models > Embeddings): one embeddings
 * provider for every persona of the bundled engine, so memory search finds
 * notes by meaning, not just by keyword, the way `phantombot embedding` sets
 * up a CLI persona. Main owns the setting and the key (electron/embeddings.ts)
 * and embeds the notes in the background after a save.
 *
 * Built from the Specialized Models kit, like Decision Model and Voice
 * Models; see AGENTS.md ("Settings screens: one design").
 */

export const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';

/** What an older app (no provider list from the engine) offers. */
const BUILTIN_PROVIDERS: EmbeddingsProviderInfo[] = [
  {id: 'gemini', label: 'Google Gemini', needsBaseUrl: false, keyOptional: false},
  {id: 'openai-compatible', label: 'OpenAI Compatible', needsBaseUrl: true, keyOptional: true}
];

export const REEMBED_TITLE = 'Re-embed memory?';
export const REEMBED_TEXT = 'Saving re-embeds every note with this model. Until that finishes, memory search by meaning is unavailable and only keyword search works.';

/** Confirm/Cancel before a save that re-embeds every note. True = go ahead. */
export type ReembedConfirm = () => Promise<boolean>;

async function confirmReembed(): Promise<boolean> {
  const {default: confirmationPopup} = await import('@components/confirmationPopup');
  try {
    await confirmationPopup({
      title: REEMBED_TITLE,
      descriptionRaw: REEMBED_TEXT,
      button: {text: document.createTextNode('Confirm')}
    });
    return true;
  } catch{
    return false;
  }
}

export interface EmbeddingsForm {
  section: HTMLElement;
  ready: Promise<void>;
  save(): Promise<void>;
  /** Check the typed (or stored) key / endpoint and fill the model list. */
  loadModels(): Promise<void>;
  destroy(): void;
}

const sameUrl = (a: string, b: string) => a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '');

/** The form, apart from the tab so tests drive it without the slider. */
export function createEmbeddingsForm(api: DesktopEmbeddingsApi, opts: {confirm?: ReembedConfirm} = {}): EmbeddingsForm {
  const confirm = opts.confirm ?? confirmReembed;
  const section = formColumn('embeddings-form');

  const {container: enabledRow, field: enabled} = toggleRow(
    'embeddings-enabled', 'Enabled', 'Search memory by meaning, not just keywords');

  const {container: providerBox, picker: providerPicker} = labelledPicker({
    testId: 'embeddings-provider',
    label: 'Provider',
    placeholder: 'Choose a provider',
    onChange: () => onProviderChanged()
  });

  const {container: urlBox, input: urlInput} = textField('embeddings-base-url', 'Base URL (including /v1)', {
    placeholder: 'http://localhost:11434/v1'
  });

  const {container: keyBox, input: keyInput} = textField('embeddings-key', 'API key', {secret: true, maxLength: 4096});
  const active = activeCheck('embeddings-active');
  const keyNote = noteLine('embeddings-key-note');

  const models = createModelChooser({
    testId: 'embeddings-model',
    placeholder: 'Enter your key to load models',
    allowTyped: true,
    onChange: () => void proveModel(),
    onTyped: () => void proveModel()
  });

  const status = noteLine('embeddings-status', true);
  const saveBtn = saveButton('embeddings-save');

  section.append(enabledRow, providerBox, urlBox, keyBox, active.container, keyNote, models.container, status, saveBtn);

  let providers: EmbeddingsProviderInfo[] = BUILTIN_PROVIDERS;
  let state: EmbeddingsState | null = null;
  let generation = 0;
  let checked: string | undefined;
  let busy = false;

  const provider = (): EmbeddingsProvider => providerPicker.getValue() || providers[0]?.id || 'gemini';
  const info = () => providers.find((p) => p.id === provider());
  const ownEndpoint = () => !!info()?.needsBaseUrl;
  const keyOptional = () => !!info()?.keyOptional;
  const baseUrl = () => ownEndpoint() ? urlInput.value.trim() : '';
  /** The saved setting is for the provider and endpoint on screen. */
  const savedFits = () => !!state?.configured && state.provider === provider() &&
    (!ownEndpoint() || sameUrl(state.baseUrl, baseUrl()));
  const storedKeyFits = () => !!state?.hasKey && state.provider === provider() &&
    (!ownEndpoint() || sameUrl(state.baseUrl, baseUrl()));
  const storedModel = () => savedFits() ? state!.model : undefined;
  /** Something to ask: a key (typed or stored), or a base URL for a bring-your-own endpoint. */
  const askable = () => ownEndpoint() ? !!baseUrl() : !!keyInput.value.trim() || storedKeyFits();

  const showFields = () => {
    urlBox.style.display = ownEndpoint() ? '' : 'none';
    showStoredKey(keyInput, storedKeyFits());
    keyNote.textContent = state && !state.canStoreKey ?
      'This PC has no keyring, so the key is not kept. Personas added later need it entered again.' :
      storedKeyFits() ? 'Key saved. Leave empty to keep it.' :
        keyOptional() ? 'Optional for a local server (llama-server, Ollama).' : '';
    models.clear(ownEndpoint() ? 'Enter the base URL to load models' : 'Enter your key to load models');
  };

  function onProviderChanged() {
    ++generation;
    checked = undefined;
    keyInput.value = '';
    urlInput.value = state?.provider === provider() && ownEndpoint() ? state.baseUrl : '';
    status.textContent = '';
    active.set('idle');
    showFields();
    if(askable()) void loadModels();
  }

  async function loadModels(): Promise<void> {
    if(!askable()) return;
    const ask = `${provider()}|${baseUrl()}|${keyInput.value.trim()}`;
    if(checked === ask) return;
    const g = ++generation;
    status.textContent = '';
    active.set('checking');
    // With a model the check is a live embed: the only proof the key works.
    const model = models.value() || storedModel() || (provider() === 'gemini' ? GEMINI_EMBEDDING_MODEL : undefined);
    const res = await api.check({provider: provider(), baseUrl: baseUrl() || undefined, apiKey: keyInput.value.trim(), ...(model ? {model} : {})});
    if(g !== generation) return;
    if(res.ok === false) {
      active.set('unverified', res.error || 'could not reach the provider');
      return;
    }
    checked = ask;
    const r = res.value;
    if(r.status === 'failed') {
      active.set('invalid', r.detail);
      models.clear();
      return;
    }
    active.set(r.status === 'verified' ? 'active' : 'idle');
    status.textContent = r.status === 'verified' ? `Model works (${r.dims} dims)` :
      r.models.length ? 'Choose a model' : 'No model list from this provider: type a model ID';
    models.setModels(r.models, model);
  }

  /** Prove the picked model with a live embed, as Save will. */
  async function proveModel(): Promise<void> {
    const model = models.value();
    if(!model || !askable()) return;
    const g = ++generation;
    active.set('checking');
    status.textContent = '';
    const res = await api.check({provider: provider(), baseUrl: baseUrl() || undefined, apiKey: keyInput.value.trim(), model});
    if(g !== generation) return;
    if(res.ok === false) {
      active.set('unverified', res.error || 'could not reach the provider');
      return;
    }
    if(res.value.status === 'verified') {
      active.set('active');
      status.textContent = `Model works (${res.value.dims} dims)`;
    } else {
      active.set(res.value.status === 'failed' ? 'invalid' : 'idle', res.value.detail);
      status.textContent = `The model did not embed (${res.value.detail})`;
    }
  }

  for(const input of [keyInput, urlInput]) {
    input.addEventListener('input', () => {
      checked = undefined;
    });
    input.addEventListener('blur', () => void loadModels());
  }

  async function save(): Promise<void> {
    if(busy) return;
    busy = true;
    saveBtn.disabled = true;
    ++generation;
    try {
      const p = provider();
      const model = models.value() || storedModel() || (p === 'gemini' ? GEMINI_EMBEDDING_MODEL : '');
      if(!model) {
        status.textContent = 'Choose a model';
        return;
      }
      // Turning it on, or a new provider / endpoint / model, embeds every note again.
      const reembeds = enabled.checked && !(savedFits() && state!.enabled && state!.model === model);
      if(reembeds && !(await confirm())) {
        status.textContent = 'Not saved';
        return;
      }
      status.textContent = enabled.checked ? 'Checking and saving...' : 'Saving...';
      const key = keyInput.value.trim();
      const res = await api.save({
        enabled: enabled.checked,
        provider: p,
        model,
        ...(ownEndpoint() ? {baseUrl: baseUrl()} : {}),
        ...(key ? {apiKey: key} : {})
      });
      if(res.ok === false) {
        status.textContent = res.error;
        return;
      }
      state = res.state;
      keyInput.value = '';
      checked = undefined;
      showStoredKey(keyInput, storedKeyFits());
      if(enabled.checked) active.set('active');
      const line = appliedLine(enabled.checked, res.applied, res.failed.map((f) => `${f.persona} (${f.error})`));
      status.textContent = enabled.checked && !res.failed.length ?
        `${line}. ${reembeds ? 'Re-embedding notes in the background; search by meaning is back when it finishes.' : 'Indexing notes in the background.'}` :
        line;
    } finally {
      busy = false;
      saveBtn.disabled = false;
    }
  }
  attachClickEvent(saveBtn, () => void save());

  const ready = (async() => {
    providerPicker.setOptions(providers.map((p) => ({value: p.id, label: p.label})), providers[0].id);
    const [listed, loaded] = await Promise.all([
      api.providers ? api.providers().catch((): EmbeddingsProviderInfo[] => []) : Promise.resolve([] as EmbeddingsProviderInfo[]),
      api.get()
    ]);
    if(Array.isArray(listed) && listed.length) providers = listed;
    state = loaded;
    // A saved provider the list no longer has stays selectable, so it is never silently swapped.
    if(state?.configured && !providers.some((p) => p.id === state.provider)) {
      providers = [...providers, {id: state.provider, label: state.provider, needsBaseUrl: !!state.baseUrl, keyOptional: false}];
    }
    providerPicker.setOptions(providers.map((p) => ({value: p.id, label: p.label})), state?.configured ? state.provider : providers[0]?.id);
    if(!state) {
      showFields();
      return;
    }
    enabled.setValueSilently(state.configured && state.enabled);
    urlInput.value = ownEndpoint() ? state.baseUrl : '';
    showFields();
    if(state.configured) models.setModels([state.model], state.model);
    if(storedKeyFits() || (state.configured && ownEndpoint())) await loadModels();
  })();

  return {
    section,
    ready,
    save,
    loadModels,
    destroy: () => {
      ++generation;
      keyInput.value = '';
      providerPicker.destroy();
      models.destroy();
    }
  };
}

export default class AppPhantomChatEmbeddingsTab extends SliderSuperTab {
  private form: EmbeddingsForm | undefined;

  public init() {
    this.container.classList.add('phantomchat-embeddings');
    this.setTitle('Embeddings');
    const api = getDesktopEmbeddings();
    const settingSection = new SettingSection({caption: true});
    settingSection.caption.textContent = 'One embeddings model for every assistant in this app. It lets memory search find notes by meaning, not just by matching words. Assistants you add later get it too.';
    if(!api) {
      settingSection.content.append(el('div', NOTE_CSS, 'Not available in this version of the app.'));
      this.scrollable.append(settingSection.container);
      return;
    }
    this.form = createEmbeddingsForm(api);
    settingSection.content.append(this.form.section);
    this.scrollable.append(settingSection.container);
  }

  public onCloseAfterTimeout() {
    this.form?.destroy();
    return super.onCloseAfterTimeout();
  }
}
