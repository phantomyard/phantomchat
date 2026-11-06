import {SliderSuperTab} from '@components/slider';
import {getDesktopVoiceModels} from '@lib/phantomchat/desktop-api';
import {applyRemoteVoiceDefaults, createVoiceDirectionForm, listPhantomVoiceTargets, voiceValue} from '@lib/phantomchat/voice-models';

export default class AppPhantomChatVoiceModelsTab extends SliderSuperTab {
  public async init() {
    this.setTitle('VoiceModels');
    const call = getDesktopVoiceModels()?.call;
    if(!call) return;
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    const content = document.createElement('div'); content.style.padding = '16px';
    this.scrollable.append(content);
    content.append(status);
    try {
      const [settings, providers] = await Promise.all([voiceValue(call, 'get'), voiceValue(call, 'providers')]);
      const forms = (['tts', 'stt'] as const).map(d => [d, createVoiceDirectionForm(content, d, settings[d], providers, call)] as const);
      const save = document.createElement('button'); save.type = 'button'; save.className = 'btn-primary'; save.textContent = 'Save'; content.append(save);
      save.addEventListener('click', async() => {
        save.disabled = true;
        try {
          const result = await voiceValue(call, 'save', Object.fromEntries(forms.map(([d, form]) => [d, form.value()])));
          let remoteApplied = 0;
          try {
            const targets = await listPhantomVoiceTargets();
            const remote = await applyRemoteVoiceDefaults(targets, result.remotes, call, (done, total) => {
              status.textContent = `Applied local defaults. Checking Phantoms ${done}/${total}…`;
            });
            remoteApplied = remote.applied;
            result.failures.push(...remote.failures);
          } catch{result.failures.push('Remote contacts could not be loaded');}
          status.textContent = `Applied to ${result.applied} local personas and ${remoteApplied} remote Phantoms` +
            (result.failures.length ? `. Failed: ${result.failures.join(', ')}` : '') +
            (result.resets.length ? `. Incompatible contact models reset to default: ${result.resets.join(', ')}` : '');
        } catch(err) {status.textContent = err instanceof Error ? err.message : 'Could not save voice settings';}
        finally {save.disabled = false;}
      });
      this.middlewareHelper.get().onDestroy(() => forms.forEach(([, form]) => form.dispose()));
    } catch(err) {status.textContent = err instanceof Error ? err.message : 'Voice settings unavailable';}
  }
}
