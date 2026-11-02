import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import Row from '@components/row';
import Button from '@components/button';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import {toast} from '@components/toast';
import {getLocalAiApi, type LocalAiApi, type LocalAiOutcome, type LocalAiProvider} from '@lib/phantomchat/desktop-api';
import {createExternalAi, ensureFirstExternalAi} from '@lib/phantomchat/local-ai';

/*
 * Desktop only (#276): AI providers for External AI contacts. The main process
 * holds every secret, in the runtime's own store: this tab only ever sends a key
 * in, and never gets one back.
 */

const INPUT_STYLE = 'display:block;box-sizing:border-box;width:calc(100% - 1rem);margin:.5rem .5rem 0;padding:.75rem;border-radius:.625rem;background:var(--surface-color);color:var(--primary-text-color);border:1px solid var(--input-search-border-color,var(--border-color))';

export function statusText(provider: LocalAiProvider): string {
  if(!provider.configured) return 'Not set up';
  return provider.source === 'environment' ? 'Set up, from an environment variable' : 'Set up';
}

export function textInput(placeholder: string, secret = false): HTMLInputElement {
  const input = document.createElement('input');
  input.type = secret ? 'password' : 'text';
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.style.cssText = INPUT_STYLE;
  return input;
}

export default class AppPhantomChatDesktopProvidersTab extends SliderSuperTab {
  private api: LocalAiApi;
  private providers: HTMLElement;
  private externalAis: HTMLElement;
  private promptArea: HTMLElement;
  private unsubscribe?: () => void;

  public async init() {
    this.container.classList.add('phantomchat-desktop-providers');
    this.setTitle('Providers' as any);
    this.api = getLocalAiApi()!;

    this.promptArea = document.createElement('div');
    this.providers = document.createElement('div');
    this.externalAis = document.createElement('div');
    this.scrollable.append(this.promptArea, this.externalAis, this.providers);

    this.unsubscribe = this.api.onEvent((event) => {
      if(event.type === 'auth-prompt') this.showAuthPrompt(event);
    });

    await Promise.all([this.renderProviders(), this.renderExternalAis()]);
  }

  protected onClose() {
    this.unsubscribe?.();
  }

  private button(text: string, onClick: () => unknown, className = 'btn-primary btn-color-primary'): HTMLButtonElement {
    const button = Button(className);
    button.textContent = text;
    button.style.margin = '.75rem .5rem 0';
    button.style.width = 'calc(100% - 1rem)';
    attachClickEvent(button, () => void onClick(), {listenerSetter: this.listenerSetter});
    return button;
  }

  /** Run a save, say what went wrong if it did, then show the new state. */
  private async apply(run: () => Promise<LocalAiOutcome<unknown>>): Promise<boolean> {
    const result = await run();
    if(result.ok === false) {
      toast(result.error);
      return false;
    }
    try {
      await ensureFirstExternalAi(this.api);
    } catch(err) {
      toast(err instanceof Error ? err.message : String(err));
    }
    await Promise.all([this.renderProviders(), this.renderExternalAis()]);
    return true;
  }

  private async renderProviders(): Promise<void> {
    const listed = await this.api['list-providers']();
    this.providers.replaceChildren();
    if(listed.ok === false) {
      toast(listed.error);
      return;
    }
    const phantomOps = listed.value.find((p) => p.id === 'phantomops')!;
    const compatible = listed.value.find((p) => p.id === 'openai-compatible')!;
    this.providers.append(
      this.phantomOpsSection(phantomOps),
      this.compatibleSection(compatible),
      this.catalogSection(listed.value.filter((p) => !p.custom))
    );
  }

  private removeButton(provider: LocalAiProvider): HTMLButtonElement {
    return this.button('Remove', () => this.apply(() => this.api['remove-provider'](provider.id)), 'btn-primary btn-transparent danger');
  }

  private phantomOpsSection(provider: LocalAiProvider): HTMLElement {
    const section = new SettingSection({
      name: 'PhantomOps' as any,
      caption: `${statusText(provider)}. Your phantom, with no model to choose. Just add your personal API token.` as any
    });
    const token = textInput('Personal API token (pok_…)', true);
    section.content.append(
      token,
      this.button('Save', () => this.apply(() => this.api['configure-phantomops'](token.value)))
    );
    if(provider.configured) section.content.append(this.removeButton(provider));
    return section.container;
  }

  private compatibleSection(provider: LocalAiProvider): HTMLElement {
    const section = new SettingSection({
      name: 'OpenAI-Compatible' as any,
      caption: `${statusText(provider)}. Self-hosted servers such as Ollama or LM Studio.` as any
    });
    const baseUrl = textInput('Base URL, e.g. http://localhost:11434/v1');
    baseUrl.value = provider.baseUrl ?? '';
    const key = textInput('API key (optional)', true);
    const model = textInput('Model name (optional if the server lists them)');
    section.content.append(
      baseUrl,
      key,
      model,
      this.button('Save', () => this.apply(() => this.api['configure-openai-compatible'](baseUrl.value, key.value, model.value)))
    );
    if(provider.configured) section.content.append(this.removeButton(provider));
    return section.container;
  }

  private catalogSection(providers: LocalAiProvider[]): HTMLElement {
    const section = new SettingSection({name: 'All providers' as any});
    const order = [...providers].sort((a, b) => Number(b.configured) - Number(a.configured));
    for(const provider of order) {
      const panel = document.createElement('div');
      panel.hidden = true;
      const row = new Row({
        title: provider.name,
        subtitle: statusText(provider),
        clickable: () => {
          panel.hidden = !panel.hidden;
          if(!panel.hidden && !panel.childElementCount) this.fillProviderPanel(panel, provider);
        },
        listenerSetter: this.listenerSetter
      });
      section.content.append(row.container, panel);
    }
    return section.container;
  }

  private fillProviderPanel(panel: HTMLElement, provider: LocalAiProvider): void {
    panel.style.padding = '0 1rem 1rem';
    if(provider.canUseKey) {
      const key = textInput('API key', true);
      panel.append(key, this.button('Save', () => this.apply(() => this.api['set-provider-key'](provider.id, key.value))));
    }
    if(provider.canUseOAuth) {
      panel.append(this.button('Sign in with browser', () => this.apply(() => this.api['sign-in'](provider.id))));
    }
    if(provider.configured && provider.source !== 'environment') panel.append(this.removeButton(provider));
    if(!panel.childElementCount) {
      const note = document.createElement('div');
      note.textContent = 'This provider is set up outside the app, through its own credentials on this PC.';
      panel.append(note);
    }
  }

  private async renderExternalAis(): Promise<void> {
    const list = await this.api['list-external-ai']();
    const section = new SettingSection({
      name: 'External AI' as any,
      caption: 'AI contacts hosted on this PC. Change one\'s model and effort by editing the contact.' as any
    });
    for(const ai of list) {
      section.content.append(new Row({title: ai.name, subtitle: ai.model ?? 'Automatic'}).container);
    }
    section.content.append(this.button('New External AI', async() => {
      try {
        const created = await createExternalAi(this.api);
        toast(`${created.name} added to your contacts`);
      } catch(err) {
        toast(err instanceof Error ? err.message : String(err));
      }
      await this.renderExternalAis();
    }));
    this.externalAis.replaceChildren(section.container);
  }

  /** A question from a sign-in in progress, such as pasting a code back. */
  private showAuthPrompt(event: {id: string; message: string; placeholder?: string; secret: boolean}): void {
    const section = new SettingSection({name: 'Sign in' as any});
    const message = document.createElement('div');
    message.style.whiteSpace = 'pre-wrap';
    message.textContent = event.message;
    const input = textInput(event.placeholder ?? '', event.secret);
    const finish = (value: string | null) => {
      section.container.remove();
      void this.api['answer-auth-prompt'](event.id, value);
    };
    section.content.append(
      message,
      input,
      this.button('Continue', () => finish(input.value)),
      this.button('Cancel', () => finish(null), 'btn-primary btn-transparent')
    );
    this.promptArea.append(section.container);
    section.container.scrollIntoView();
  }
}
