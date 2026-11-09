import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import {el, NOTE_CSS, noteLine, saveButton} from '@components/sidebarLeft/tabs/phantomchatModelKit';
import {getDesktopVoiceModels} from '@lib/phantomchat/desktop-api';
import {createVoiceForm, voiceValue, type VoiceModelsCall} from '@lib/phantomchat/voice-models';

/*
 * Desktop only (Settings > Specialized Models > Voice Models): one provider,
 * one key, a TTS model and an STT model, one Enabled switch for both. Main
 * owns the settings and the key (electron/voiceModels.ts).
 *
 * Test and Save checks the key and both models live and saves only when that
 * works. It pushes nothing to any Phantom: it makes the Voice ID picker
 * appear on Provider contacts, and a contact gets voice when one is picked
 * there. Same layout as Decision Model and Embeddings (AGENTS.md, "Settings
 * screens: one design").
 */

/** The page, apart from the tab so tests drive it without the slider. */
export async function mountVoiceModels(parent: {append(...nodes: Node[]): void}, call: VoiceModelsCall): Promise<{save(): Promise<void>; dispose(): void}> {
  const [settings, providers] = await Promise.all([voiceValue(call, 'get'), voiceValue(call, 'providers')]);
  const section = new SettingSection({caption: true});
  section.caption.textContent = 'One provider and key for text-to-speech (how your assistants answer with voice notes) and speech-to-text (how they read yours). Each Provider contact picks its own voice when you add it or in its Edit pane. PhantomOps contacts use their server\'s voice models.';
  const form = createVoiceForm(settings, providers, call);
  section.content.append(form.section);
  parent.append(section.container);

  const footer = new SettingSection({noDelimiter: true});
  const status = noteLine('voice-models-status', true);
  const saveBtn = saveButton('voice-models-save', 'Test and Save');
  const column = el('div', 'display:flex;flex-direction:column;gap:.75rem;padding:0 .5rem;');
  column.append(status, saveBtn);
  footer.content.append(column);
  parent.append(footer.container);

  let busy = false;
  async function save() {
    if(busy) return;
    busy = true;
    saveBtn.disabled = true;
    const value = form.value();
    status.textContent = value.tts.enabled ? 'Testing the key and models...' : 'Saving...';
    try {
      const result = await voiceValue(call, 'save', value);
      form.saved(result.settings);
      const on = !!value.tts.enabled;
      const touched = result.applied + result.failures.length;
      status.textContent = (on ? 'Works. Saved: pick a Voice ID on each Provider contact' : 'Off. Saved') +
        (touched ? `; updated ${result.applied} contact${result.applied === 1 ? '' : 's'} with a voice` : '') +
        (result.resets?.length ? `; Voice ID cleared (not offered by this model): ${result.resets.join(', ')}` : '') +
        (result.failures.length ? `; failed: ${result.failures.join(', ')}` : '');
    } catch(err) {
      status.textContent = `Not saved: ${err instanceof Error ? err.message : 'could not save voice settings'}`;
    } finally {
      busy = false;
      saveBtn.disabled = false;
    }
  }
  attachClickEvent(saveBtn, () => void save());
  return {save, dispose: () => form.dispose()};
}

export default class AppPhantomChatVoiceModelsTab extends SliderSuperTab {
  public async init() {
    this.container.classList.add('phantomchat-voice-models');
    this.setTitle('VoiceModels');
    const call = getDesktopVoiceModels()?.call;
    if(!call) {
      const section = new SettingSection();
      section.content.append(el('div', NOTE_CSS, 'Not available in this version of the app.'));
      this.scrollable.append(section.container);
      return;
    }
    try {
      const page = await mountVoiceModels(this.scrollable, call);
      this.middlewareHelper.get().onDestroy(() => page.dispose());
    } catch(err) {
      const section = new SettingSection();
      section.content.append(el('div', NOTE_CSS, err instanceof Error ? err.message : 'Voice settings unavailable'));
      this.scrollable.append(section.container);
    }
  }
}
