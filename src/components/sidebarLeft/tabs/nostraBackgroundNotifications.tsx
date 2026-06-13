import {createEffect, createSignal, onCleanup, Show} from 'solid-js';
import rootScope from '@lib/rootScope';
import {i18n} from '@lib/langPack';
import Row from '@components/rowTsx';
import Section from '@components/section';
import CheckboxFieldTsx from '@components/checkboxFieldTsx';
import {
  getPreviewLevel,
  setPreviewLevel,
  getEndpointBase,
  setEndpointBase,
  getSubscription,
  DEFAULT_ENDPOINT,
  type PreviewLevel
} from '@lib/nostra/nostra-push-storage';

const NostraBackgroundNotifications = () => {
  const [enabled, setEnabled] = createSignal(false);
  const [previewLevel, setPreviewLevelSig] = createSignal<PreviewLevel>('A');
  const [endpoint, setEndpointSig] = createSignal(DEFAULT_ENDPOINT);
  const [advancedOpen, setAdvancedOpen] = createSignal(false);

  const refreshState = async() => {
    if(typeof Notification !== 'undefined') {
      const sub = await getSubscription();
      setEnabled(Notification.permission === 'granted' && sub !== null);
    }
    setPreviewLevelSig(await getPreviewLevel());
    setEndpointSig(await getEndpointBase());
  };

  createEffect(() => { void refreshState(); });

  const onSubscriptionChanged = () => { void refreshState(); };
  rootScope.addEventListener('nostra_push_subscription_changed' as any, onSubscriptionChanged);
  onCleanup(() => rootScope.removeEventListener('nostra_push_subscription_changed' as any, onSubscriptionChanged));

  const onToggle = async(value: boolean) => {
    if(typeof Notification === 'undefined') return;
    if(value) {
      if(Notification.permission !== 'granted') {
        const result = await Notification.requestPermission();
        if(result !== 'granted') return;
      }
      const {subscribePush} = await import('@lib/nostra/nostra-push-client');
      const {resolveVapidKey} = await import('@lib/nostra/nostra-push-helpers');
      const {loadIdentity} = await import('@lib/nostra/identity');
      const identity = await loadIdentity();
      if(!identity) return;
      const vapidKey = await resolveVapidKey();
      if(!vapidKey) return;
      await subscribePush({
        pubkeyHex: identity.publicKey,
        privkeyHex: identity.privateKey,
        vapidPublicKey: vapidKey
      });
    } else {
      const {unsubscribePush} = await import('@lib/nostra/nostra-push-client');
      const {loadIdentity} = await import('@lib/nostra/identity');
      const identity = await loadIdentity();
      if(!identity) return;
      await unsubscribePush({privkeyHex: identity.privateKey});
    }
    await refreshState();
  };

  const onPreviewChange = async(level: PreviewLevel) => {
    await setPreviewLevel(level);
    setPreviewLevelSig(level);
  };

  const onEndpointBlur = async(e: FocusEvent) => {
    const value = (e.target as HTMLInputElement).value.trim();
    await setEndpointBase(value === '' || value === DEFAULT_ENDPOINT ? null : value);
    setEndpointSig(value || DEFAULT_ENDPOINT);
  };

  return (
    <>
      <Section name="Nostra.BackgroundPush.Section">
        <Row>
          <Row.CheckboxFieldToggle>
            <CheckboxFieldTsx
              checked={enabled()}
              onChange={onToggle}
              toggle
            />
          </Row.CheckboxFieldToggle>
          <Row.Title>{i18n('Nostra.BackgroundPush.Enable' as any)}</Row.Title>
          <Row.Subtitle>{i18n('Nostra.BackgroundPush.EnableCaption' as any)}</Row.Subtitle>
        </Row>

        <Show when={enabled()}>
          <Row>
            <Row.Title>{i18n('Nostra.BackgroundPush.Preview' as any)}</Row.Title>
          </Row>
          <Row>
            <Row.CheckboxField>
              <input
                type="radio"
                name="nostra-push-preview"
                checked={previewLevel() === 'A'}
                onChange={() => onPreviewChange('A')}
              />
            </Row.CheckboxField>
            <Row.Title>{i18n('Nostra.BackgroundPush.PreviewGeneric' as any)}</Row.Title>
          </Row>
          <Row>
            <Row.CheckboxField>
              <input
                type="radio"
                name="nostra-push-preview"
                checked={previewLevel() === 'B'}
                onChange={() => onPreviewChange('B')}
              />
            </Row.CheckboxField>
            <Row.Title>{i18n('Nostra.BackgroundPush.PreviewSenderContent' as any)}</Row.Title>
          </Row>
          <Row>
            <Row.CheckboxField>
              <input
                type="radio"
                name="nostra-push-preview"
                checked={previewLevel() === 'C'}
                onChange={() => onPreviewChange('C')}
              />
            </Row.CheckboxField>
            <Row.Title>{i18n('Nostra.BackgroundPush.PreviewSenderOnly' as any)}</Row.Title>
          </Row>

          <Row
            class="nostra-push-advanced-toggle"
            clickable={() => setAdvancedOpen((v) => !v)}
          >
            <Row.Title>{i18n('Nostra.BackgroundPush.Advanced' as any)}</Row.Title>
          </Row>

          <Show when={advancedOpen()}>
            <Row>
              <Row.Title>{i18n('Nostra.BackgroundPush.Endpoint' as any)}</Row.Title>
              <Row.Subtitle>
                <input
                  class="nostra-push-endpoint-input"
                  type="text"
                  value={endpoint()}
                  onBlur={onEndpointBlur}
                />
              </Row.Subtitle>
            </Row>
          </Show>

          <Row class="nostra-push-disclosure">
            <Row.Subtitle>
              {'Your public key and IP address (unless Tor is enabled) are sent to the push relay. Message contents stay end-to-end encrypted. '}
              <a href="/docs/PUSH-NOTIFICATIONS.md" target="_blank" rel="noreferrer">
                Learn more
              </a>
              {'.'}
            </Row.Subtitle>
          </Row>
        </Show>
      </Section>
    </>
  );
};

export default NostraBackgroundNotifications;
