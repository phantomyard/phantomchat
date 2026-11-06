import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import Row from '@components/row';
import {
  getDesktopDecisionModel,
  getDesktopEmbeddings,
  getDesktopVoiceModels
} from '@lib/phantomchat/desktop-api';

/*
 * Settings > Specialized Models: the models an assistant uses besides its main
 * one. Each row opens one screen built from the same kit
 * (phantomchatModelKit.ts). A row exists only where the desktop exposes its
 * API, and the whole menu only where at least one does.
 */

export default class AppPhantomChatSpecializedModelsTab extends SliderSuperTab {
  public init() {
    this.container.classList.add('phantomchat-specialized-models');
    this.setTitle('SpecializedModels');
    const section = new SettingSection({caption: true});
    section.caption.textContent = 'Shared by every assistant in this app, including ones you add later.';
    const rows: HTMLElement[] = [];
    const add = (testId: string, title: string, subtitle: string, icon: Icon, open: () => Promise<void>) => {
      const row = new Row({title, subtitle, icon, clickable: () => void open(), listenerSetter: this.listenerSetter});
      row.container.setAttribute('data-testid', testId);
      rows.push(row.container);
    };
    if(getDesktopDecisionModel()) {
      add('specialized-decision-model', 'Decision Model', 'Screens messages and routes each turn', 'bots', async() => {
        const {default: Tab} = await import('@components/sidebarLeft/tabs/phantomchatDecisionModel');
        this.slider.createTab(Tab).open();
      });
    }
    if(getDesktopVoiceModels()) {
      add('specialized-voice-models', 'Voice Models', 'Text-to-speech and speech-to-text', 'microphone', async() => {
        const {default: Tab} = await import('@components/sidebarLeft/tabs/phantomchatVoiceModels');
        this.slider.createTab(Tab).open();
      });
    }
    if(getDesktopEmbeddings()) {
      add('specialized-embeddings', 'Embeddings', 'Memory search by meaning', 'search', async() => {
        const {default: Tab} = await import('@components/sidebarLeft/tabs/phantomchatEmbeddings');
        this.slider.createTab(Tab).open();
      });
    }
    section.content.append(...rows);
    this.scrollable.append(section.container);
  }
}
