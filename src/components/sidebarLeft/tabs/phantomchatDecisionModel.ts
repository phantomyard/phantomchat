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
  showStoredKey,
  textField,
  toggleRow
} from '@components/sidebarLeft/tabs/phantomchatModelKit';
import {
  getDesktopDecisionModel,
  type DecisionModelProvider,
  type DecisionModelState,
  type DesktopDecisionModelApi
} from '@lib/phantomchat/desktop-api';

/*
 * Desktop only: one decision model (e.g. TypeSafe Jev) for every persona of
 * the bundled phantombot engine (issue #449). It screens untrusted turns
 * (the judge) and picks the primary or coder model per turn (the router).
 *
 * Main owns the setting and the key (electron/decisionModel.ts): this tab
 * sends a typed key once and afterwards only learns whether one is stored.
 * Test and Apply checks the key live (typed or stored) and only then writes
 * it into every persona of the bundled engine, i.e. every Provider contact
 * (npub Phantoms and humans are never touched); ones created later inherit it.
 */

export const DEFAULT_DECISION_MODEL = 'typesafe/jev-1.13';

const PROVIDERS: {value: DecisionModelProvider; label: string}[] = [
  {value: 'openrouter', label: 'OpenRouter'},
  {value: 'typesafe', label: 'TypeSafe'}
];

export interface DecisionModelForm {
  section: HTMLElement;
  /** Resolves once the stored setting is shown (and its models, when a key is stored). */
  ready: Promise<void>;
  save(): Promise<void>;
  /** Check the typed (or stored) key and fill the model list. */
  loadModels(): Promise<void>;
  destroy(): void;
}

/** The form, apart from the tab so tests drive it without the slider. */
export function createDecisionModelForm(api: DesktopDecisionModelApi): DecisionModelForm {
  const section = formColumn('decision-model-form');

  const {container: enabledRow, field: enabled} = toggleRow(
    'decision-model-enabled', 'Enabled', 'Screen untrusted messages and route each turn');

  const {container: providerBox, picker: providerPicker} = labelledPicker({
    testId: 'decision-model-provider',
    label: 'Provider',
    placeholder: 'Choose a provider',
    onChange: () => onProviderChanged()
  });

  const {container: keyBox, input: keyInput} = textField('decision-model-key', 'API key', {secret: true, maxLength: 4096});
  const keyNote = noteLine('decision-model-key-note');

  const models = createModelChooser({
    testId: 'decision-model-model',
    placeholder: 'Enter your key to load models'
  });

  const status = noteLine('decision-model-status', true);
  const saveBtn = saveButton('decision-model-save', 'Test and Apply');

  section.append(enabledRow, providerBox, keyBox, keyNote, models.container, status, saveBtn);

  let state: DecisionModelState | null = null;
  let checkGeneration = 0;
  let checkedKey: {provider: string; key: string} | undefined;
  /** The provider whose check filled the model picker; a pick is only valid for it. */
  let modelsProvider: DecisionModelProvider | undefined;
  let busy = false;

  const provider = (): DecisionModelProvider => (providerPicker.getValue() as DecisionModelProvider) || 'openrouter';
  /** The stored key belongs to the provider on screen. */
  const storedKeyFits = () => !!state?.hasKey && state.provider === provider();

  /** The saved model, only when it was saved for this provider. */
  const storedModelFor = (p: DecisionModelProvider) => state?.configured && state.provider === p ? state.model : undefined;
  /** A default only where it is that provider's own id; OpenRouter has none. */
  const defaultFor = (p: DecisionModelProvider) => p === 'typesafe' ? DEFAULT_DECISION_MODEL : undefined;
  /** The picked model, only while the picker holds this provider's list. */
  const pickedModelFor = (p: DecisionModelProvider) => modelsProvider === p ? models.value() || undefined : undefined;

  const clearModels = () => {
    modelsProvider = undefined;
    models.clear();
  };

  const setModels = (p: DecisionModelProvider, ids: string[], preferred?: string) => {
    if(!ids.length && !preferred) {
      clearModels();
      return;
    }
    modelsProvider = p;
    models.setModels(ids, preferred, (id) => id === DEFAULT_DECISION_MODEL ? 'recommended' : undefined);
  };

  const showKeyNote = () => {
    showStoredKey(keyInput, storedKeyFits());
    if(state && !state.canStoreKey) {
      keyNote.textContent = 'This PC has no keyring, so the key is not kept. Personas added later need it entered again.';
    } else {
      keyNote.textContent = storedKeyFits() ? 'Key saved. Leave empty to keep it.' : '';
    }
  };

  function onProviderChanged() {
    // Discard a check still running for the previous provider.
    ++checkGeneration;
    checkedKey = undefined;
    keyInput.value = '';
    status.textContent = '';
    clearModels();
    showKeyNote();
    if(storedKeyFits()) void loadModels();
  }

  async function loadModels(): Promise<void> {
    const p = provider();
    const key = keyInput.value.trim();
    if(!key && !storedKeyFits()) return;
    if(checkedKey && checkedKey.provider === p && checkedKey.key === key) return;
    const generation = ++checkGeneration;
    status.textContent = 'Loading models...';
    const res = await api.check(p, key);
    if(generation !== checkGeneration) return;
    if(res.ok === false) {
      status.textContent = `Could not check the key (${res.error || 'no answer'})`;
      return;
    }
    checkedKey = {provider: p, key};
    const r = res.value;
    if(r.status === 'invalid') {
      status.textContent = `Key rejected (${r.detail})`;
      clearModels();
      return;
    }
    status.textContent = r.status === 'verified' ? '' : `Could not confirm the key (${r.detail})`;
    setModels(p, r.models, pickedModelFor(p) || storedModelFor(p) || defaultFor(p));
  }

  keyInput.addEventListener('input', () => {
    checkedKey = undefined;
  });
  keyInput.addEventListener('blur', () => void loadModels());

  async function save(): Promise<void> {
    if(busy) return;
    busy = true;
    saveBtn.disabled = true;
    ++checkGeneration;
    status.textContent = enabled.checked ? 'Testing the key...' : 'Saving...';
    try {
      const key = keyInput.value.trim();
      const p = provider();
      const model = pickedModelFor(p) || storedModelFor(p) || defaultFor(p);
      if(!model) {
        status.textContent = 'Choose a model';
        return;
      }
      const res = await api.save({
        enabled: enabled.checked,
        provider: p,
        model,
        ...(key ? {apiKey: key} : {})
      });
      if(res.ok === false) {
        status.textContent = `Not applied: ${res.error}`;
        return;
      }
      state = res.state;
      keyInput.value = '';
      checkedKey = undefined;
      showKeyNote();
      status.textContent = appliedLine(enabled.checked, res.applied, res.failed.map((f) => `${f.persona} (${f.error})`));
    } finally {
      busy = false;
      saveBtn.disabled = false;
    }
  }
  attachClickEvent(saveBtn, () => void save());

  const ready = (async() => {
    providerPicker.setOptions(PROVIDERS, 'openrouter');
    state = await api.get();
    if(!state) return;
    enabled.setValueSilently(state.configured && state.enabled);
    providerPicker.setOptions(PROVIDERS, state.provider);
    showKeyNote();
    if(storedKeyFits()) await loadModels();
    else if(state.configured) setModels(state.provider, [state.model], state.model);
  })();

  return {
    section,
    ready,
    save,
    loadModels,
    destroy: () => {
      providerPicker.destroy();
      models.destroy();
    }
  };
}

export default class AppPhantomChatDecisionModelTab extends SliderSuperTab {
  private form: DecisionModelForm | undefined;

  public init() {
    this.container.classList.add('phantomchat-decision-model');
    this.setTitle('DecisionModel');
    const api = getDesktopDecisionModel();
    const settingSection = new SettingSection({caption: true});
    settingSection.caption.textContent = 'One decision model for every assistant in this app. It screens messages from anyone you have not allowed, and picks the main or coding model for each turn. Assistants you add later get it too.';
    if(!api) {
      settingSection.content.append(el('div', NOTE_CSS, 'Not available in this version of the app.'));
      this.scrollable.append(settingSection.container);
      return;
    }
    this.form = createDecisionModelForm(api);
    settingSection.content.append(this.form.section);
    this.scrollable.append(settingSection.container);
  }

  public onCloseAfterTimeout() {
    this.form?.destroy();
    return super.onCloseAfterTimeout();
  }
}
