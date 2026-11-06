import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import {el, NOTE_CSS, noteLine, saveButton} from '@components/sidebarLeft/tabs/phantomchatModelKit';
import {getDesktopVoiceModels} from '@lib/phantomchat/desktop-api';
import {
  applyRemoteVoiceDefaults,
  createVoiceDirectionForm,
  listPhantomVoiceTargets,
  voiceValue,
  type VoiceDirectionForm,
  type VoiceModality,
  type VoiceModelsCall
} from '@lib/phantomchat/voice-models';

/*
 * Desktop only (Settings > Specialized Models > Voice Models): app-wide TTS
 * and STT defaults for every local persona and Phantom contact. Main owns the
 * settings and keys (electron/voiceModels.ts).
 *
 * Same layout as Decision Model and Embeddings (AGENTS.md, "Settings screens:
 * one design"): one captioned section per direction, then one Save.
 */

const CAPTIONS: Record<VoiceModality, string> = {
  tts: 'Text-to-speech: the voice your assistants answer with.',
  stt: 'Speech-to-text: how your assistants read the voice notes you send.'
};

/** The page, apart from the tab so tests drive it without the slider. */
export async function mountVoiceModels(parent: {append(...nodes: Node[]): void}, call: VoiceModelsCall): Promise<{save(): Promise<void>; dispose(): void}> {
  const [settings, providers] = await Promise.all([voiceValue(call, 'get'), voiceValue(call, 'providers')]);
  const forms: [VoiceModality, VoiceDirectionForm][] = [];
  for(const d of ['tts', 'stt'] as const) {
    const section = new SettingSection({name: el('span', undefined, d === 'tts' ? 'Text-to-speech (TTS)' : 'Speech-to-text (STT)'), caption: true});
    section.caption.textContent = CAPTIONS[d];
    const form = createVoiceDirectionForm(d, settings[d], providers, call);
    section.content.append(form.section);
    parent.append(section.container);
    forms.push([d, form]);
  }

  const footer = new SettingSection({noDelimiter: true});
  const status = noteLine('voice-models-status', true);
  const saveBtn = saveButton('voice-models-save');
  const column = el('div', 'display:flex;flex-direction:column;gap:.75rem;padding:0 .5rem;');
  column.append(status, saveBtn);
  footer.content.append(column);
  parent.append(footer.container);

  let busy = false;
  async function save() {
    if(busy) return;
    busy = true;
    saveBtn.disabled = true;
    status.textContent = 'Saving...';
    try {
      const result = await voiceValue(call, 'save', Object.fromEntries(forms.map(([d, form]) => [d, form.value()])));
      let remoteApplied = 0;
      try {
        const targets = await listPhantomVoiceTargets();
        const remote = await applyRemoteVoiceDefaults(targets, result.remotes, call, (done, total) => {
          status.textContent = `Applied to local personas. Checking Phantoms ${done}/${total}...`;
        });
        remoteApplied = remote.applied;
        result.failures.push(...remote.failures);
      } catch{result.failures.push('Remote contacts could not be loaded');}
      status.textContent = `Applied to ${result.applied} local persona${result.applied === 1 ? '' : 's'} and ${remoteApplied} remote Phantom${remoteApplied === 1 ? '' : 's'}` +
        (result.failures.length ? `; failed: ${result.failures.join(', ')}` : '') +
        (result.resets.length ? `. Contact models reset to default: ${result.resets.join(', ')}` : '');
    } catch(err) {
      status.textContent = err instanceof Error ? err.message : 'Could not save voice settings';
    } finally {
      busy = false;
      saveBtn.disabled = false;
    }
  }
  attachClickEvent(saveBtn, () => void save());
  return {save, dispose: () => forms.forEach(([, form]) => form.dispose())};
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
