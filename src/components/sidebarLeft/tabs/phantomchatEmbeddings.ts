import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import {
  appliedLine,
  createModelChooser,
  el,
  formColumn,
  labelledPicker,
  NOTE_CSS,
  noteLine,
  saveButton,
  textField,
  toggleRow
} from '@components/sidebarLeft/tabs/phantomchatModelKit';
import {
  getDesktopEmbeddings,
  type DesktopEmbeddingsApi,
  type EmbeddingsProvider,
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

const PROVIDERS: {value: EmbeddingsProvider; label: string}[] = [
  {value: 'gemini', label: 'Gemini'},
  {value: 'openai-compatible', label: 'OpenAI Compatible'}
];

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
export function createEmbeddingsForm(api: DesktopEmbeddingsApi): EmbeddingsForm {
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

  section.append(enabledRow, providerBox, urlBox, keyBox, keyNote, models.container, status, saveBtn);

  let state: EmbeddingsState | null = null;
  let generation = 0;
  let checked: string | undefined;
  let busy = false;

  const provider = (): EmbeddingsProvider => (providerPicker.getValue() as EmbeddingsProvider) || 'gemini';
  const baseUrl = () => provider() === 'openai-compatible' ? urlInput.value.trim() : '';
  /** The stored key belongs to the provider and endpoint on screen. */
  const storedKeyFits = () => !!state?.hasKey && state.provider === provider() &&
    (provider() === 'gemini' || sameUrl(state.baseUrl, baseUrl()));
  const storedModel = () => state?.configured && state.provider === provider() &&
    (provider() === 'gemini' || sameUrl(state.baseUrl, baseUrl())) ? state.model : undefined;
  /** Something to ask: Gemini needs a key, OpenAI Compatible a base URL. */
  const askable = () => provider() === 'gemini' ? !!keyInput.value.trim() || storedKeyFits() : !!baseUrl();

  const showFields = () => {
    const openai = provider() === 'openai-compatible';
    urlBox.style.display = openai ? '' : 'none';
    keyNote.textContent = state && !state.canStoreKey ?
      'This PC has no keyring, so the key is not kept. Personas added later need it entered again.' :
      storedKeyFits() ? 'Key saved. Leave empty to keep it.' :
        openai ? 'Optional for a local server (llama-server, Ollama).' : '';
    models.clear(openai ? 'Enter the base URL to load models' : 'Enter your key to load models');
  };

  function onProviderChanged() {
    ++generation;
    checked = undefined;
    keyInput.value = '';
    urlInput.value = state?.provider === 'openai-compatible' && provider() === 'openai-compatible' ? state.baseUrl : '';
    status.textContent = '';
    showFields();
    if(askable()) void loadModels();
  }

  async function loadModels(): Promise<void> {
    if(!askable()) return;
    const ask = `${provider()}|${baseUrl()}|${keyInput.value.trim()}`;
    if(checked === ask) return;
    const g = ++generation;
    status.textContent = provider() === 'gemini' ? 'Checking key...' : 'Loading models...';
    const res = await api.check({provider: provider(), baseUrl: baseUrl() || undefined, apiKey: keyInput.value.trim()});
    if(g !== generation) return;
    if(res.ok === false) {
      status.textContent = res.error || 'Could not reach the provider';
      return;
    }
    checked = ask;
    const r = res.value;
    if(r.status === 'failed') {
      status.textContent = `Key rejected (${r.detail})`;
      models.clear();
      return;
    }
    status.textContent = r.status === 'verified' ? `Key verified (${r.dims} dims)` :
      r.models.length ? 'Choose a model' : 'No model list from this endpoint: type a model ID';
    models.setModels(r.models, storedModel());
  }

  /** OpenAI Compatible: prove the picked model with a live embed, as Save will. */
  async function proveModel(): Promise<void> {
    if(provider() !== 'openai-compatible') return;
    const model = models.value();
    if(!model) return;
    const g = ++generation;
    status.textContent = 'Checking model...';
    const res = await api.check({provider: provider(), baseUrl: baseUrl(), apiKey: keyInput.value.trim(), model});
    if(g !== generation) return;
    if(res.ok === false) {
      status.textContent = res.error || 'Could not reach the provider';
      return;
    }
    status.textContent = res.value.status === 'verified' ?
      `Model works (${res.value.dims} dims)` :
      `The model did not embed (${res.value.detail})`;
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
    status.textContent = enabled.checked ? 'Checking and saving...' : 'Saving...';
    try {
      const p = provider();
      const model = models.value() || storedModel() || (p === 'gemini' ? GEMINI_EMBEDDING_MODEL : '');
      if(!model) {
        status.textContent = 'Choose a model';
        return;
      }
      const key = keyInput.value.trim();
      const res = await api.save({
        enabled: enabled.checked,
        provider: p,
        model,
        ...(p === 'openai-compatible' ? {baseUrl: baseUrl()} : {}),
        ...(key ? {apiKey: key} : {})
      });
      if(res.ok === false) {
        status.textContent = res.error;
        return;
      }
      state = res.state;
      keyInput.value = '';
      checked = undefined;
      const line = appliedLine(enabled.checked, res.applied, res.failed.map((f) => `${f.persona} (${f.error})`));
      status.textContent = enabled.checked && !res.failed.length ? `${line}. Indexing notes in the background.` : line;
    } finally {
      busy = false;
      saveBtn.disabled = false;
    }
  }
  attachClickEvent(saveBtn, () => void save());

  const ready = (async() => {
    providerPicker.setOptions(PROVIDERS, 'gemini');
    showFields();
    state = await api.get();
    if(!state) return;
    enabled.setValueSilently(state.configured && state.enabled);
    providerPicker.setOptions(PROVIDERS, state.provider);
    urlInput.value = state.provider === 'openai-compatible' ? state.baseUrl : '';
    showFields();
    if(state.configured) models.setModels([state.model], state.model);
    if(storedKeyFits() || (state.configured && state.provider === 'openai-compatible')) await loadModels();
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
