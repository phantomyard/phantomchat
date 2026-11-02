/**
 * Model and effort on the contact form (#276): only for an External AI, and only
 * on the PC hosting it. There is deliberately no picker at the prompt: changing
 * them means editing the contact, and a change applies to the next message.
 */
import SettingSection from '@components/settingSection';
import {getLocalAiApi, type LocalAiEffortChoices, type LocalAiModelChoice} from './desktop-api';
import {hostedExternalAi} from './local-ai';

const SELECT_STYLE = 'display:block;box-sizing:border-box;width:100%;margin-top:.5rem;padding:.75rem;border-radius:.625rem;background:var(--surface-color);color:var(--primary-text-color);border:1px solid var(--input-search-border-color,var(--border-color))';
const LABEL_STYLE = 'display:block;margin:.75rem .5rem 0;color:var(--secondary-text-color);font-size:.875rem';
export const DEFAULT_MODEL_VALUE = '';

export function fillModelSelect(select: HTMLSelectElement, models: LocalAiModelChoice[], current: string | null): void {
  select.replaceChildren();
  const fallback = document.createElement('option');
  fallback.value = DEFAULT_MODEL_VALUE;
  fallback.textContent = 'Automatic';
  select.append(fallback);

  const groups = new Map<string, HTMLOptGroupElement>();
  for(const model of models) {
    let group = groups.get(model.provider);
    if(!group) {
      group = document.createElement('optgroup');
      group.label = model.providerName;
      groups.set(model.provider, group);
      select.append(group);
    }
    const option = document.createElement('option');
    option.value = model.value;
    option.textContent = model.label;
    group.append(option);
  }

  // A stored model whose provider has since been removed stays visible, not silently replaced.
  if(current && !models.some((model) => model.value === current)) {
    const option = document.createElement('option');
    option.value = current;
    option.textContent = `${current} (unavailable)`;
    select.append(option);
  }
  select.value = current ?? DEFAULT_MODEL_VALUE;
}

/** Grey means the model takes no effort setting, or its gateway did not say. */
export function fillEffortSelect(select: HTMLSelectElement, choices: LocalAiEffortChoices, current: string | null): void {
  select.replaceChildren();
  select.disabled = !choices.enabled;
  const levels = choices.levels.length ? choices.levels : ['off'];
  for(const level of levels) {
    const option = document.createElement('option');
    option.value = level;
    option.textContent = level[0].toUpperCase() + level.slice(1);
    select.append(option);
  }
  select.value = current && levels.includes(current) ? current : levels[0];
}

export async function appendExternalAiFields(userId: number, parent: {append(...nodes: Node[]): void}): Promise<boolean> {
  const api = getLocalAiApi();
  const hosted = await hostedExternalAi(userId);
  if(!api || !hosted) return false;

  const section = new SettingSection({name: 'AI model' as any, caption: 'Applies from the next message.' as any});
  const label = (text: string, control: HTMLElement) => {
    const el = document.createElement('label');
    el.style.cssText = LABEL_STYLE;
    el.textContent = text;
    el.append(control);
    return el;
  };
  const modelSelect = document.createElement('select');
  modelSelect.className = 'external-ai-model';
  modelSelect.style.cssText = SELECT_STYLE;
  const effortSelect = document.createElement('select');
  effortSelect.className = 'external-ai-effort';
  effortSelect.style.cssText = SELECT_STYLE;
  section.content.append(label('Model', modelSelect), label('Effort', effortSelect));
  parent.append(section.container);

  const models = await api['model-choices']();
  fillModelSelect(modelSelect, models.ok === true ? models.value : [], hosted.model);

  let effort = hosted.effort;
  const refreshEffort = async() => {
    effortSelect.disabled = true;
    const choices = await api['effort-choices'](modelSelect.value || null);
    fillEffortSelect(effortSelect, choices.ok === true ? choices.value : {levels: [], enabled: false}, effort);
  };
  await refreshEffort();

  modelSelect.addEventListener('change', async() => {
    await api['update-external-ai'](hosted.pubkey, {model: modelSelect.value || null});
    await refreshEffort();
    effort = effortSelect.disabled ? null : effortSelect.value;
    await api['update-external-ai'](hosted.pubkey, {effort});
  });
  effortSelect.addEventListener('change', async() => {
    effort = effortSelect.value;
    await api['update-external-ai'](hosted.pubkey, {effort});
  });
  return true;
}
