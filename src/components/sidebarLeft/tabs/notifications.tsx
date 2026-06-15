import {SETTINGS_INIT} from '@config/state';
import {i18n} from '@lib/langPack';
import {useAppSettings} from '@stores/appSettings';
import CheckboxFieldTsx from '@components/checkboxFieldTsx';
import RangeSettingSelector from '@components/rangeSettingSelector';
import Row from '@components/rowTsx';
import Section from '@components/section';
import {createMemo, createSignal} from 'solid-js';
import {toastNew} from '@components/toast';
import Button from '@components/buttonTsx';
import cancelEvent from '@helpers/dom/cancelEvent';
import {useHotReloadGuard} from '@lib/solidjs/hotReloadGuard';
import PhantomChatBackgroundNotifications from '@components/sidebarLeft/tabs/phantomchatBackgroundNotifications';
import App from '@config/app';

const NotificationsSection = () => {
  const {uiNotificationsManager} = useHotReloadGuard();
  const [appSettings, setAppSettings] = useAppSettings();
  const [permission, setPermission] = createSignal<NotificationPermission>(Notification.permission);
  const isGranted = createMemo(() => permission() === 'granted');

  const onClick = (e: MouseEvent) => {
    cancelEvent(e);
    // const now = Date.now();
    Notification.requestPermission().then((permission) => {
      setPermission(permission);
      if(permission === 'granted') {
        uiNotificationsManager.onPushConditionsChange();
      } else {
        throw 1;
      }
    }, () => {
      // if((Date.now() - now) < 100) {
      toastNew({langPackKey: 'Notifications.Restricted'});
      // }
    });
  };

  const NotificationRow = (props: Parameters<typeof Row>[0]) => {
    return (
      <Row
        {...props}
        fakeDisabled={!isGranted()}
        clickable={!isGranted() && onClick}
      />
    );
  };

  const NotificationCheckbox = (props: Parameters<typeof CheckboxFieldTsx>[0]) => {
    return (
      <CheckboxFieldTsx
        {...props}
        checked={isGranted() && props.checked}
      />
    );
  };

  return (
    <Section
      name="Notifications.Web"
      caption={isGranted() ? 'MultiAccount.ShowNotificationsFromCaption' : 'Notifications.Default'}
    >
      <NotificationRow>
        <Row.CheckboxFieldToggle>
          <NotificationCheckbox
            checked={appSettings.notifications.desktop}
            onChange={(value) => setAppSettings('notifications', 'desktop', value)}
            toggle
          />
        </Row.CheckboxFieldToggle>
        <Row.Title>{i18n('Notifications.Show')}</Row.Title>
      </NotificationRow>
      {App.pushEnabled && (
        <NotificationRow>
          <Row.CheckboxFieldToggle>
            <NotificationCheckbox
              checked={appSettings.notifications.push}
              onChange={(value) => setAppSettings('notifications', 'push', value)}
              toggle
            />
          </Row.CheckboxFieldToggle>
          <Row.Title>{i18n('Notifications.Offline')}</Row.Title>
        </NotificationRow>
      )}
      <NotificationRow>
        <Row.CheckboxFieldToggle>
          <NotificationCheckbox
            checked={appSettings.notifyAllAccounts}
            onChange={(value) => setAppSettings('notifyAllAccounts', value)}
            toggle
          />
        </Row.CheckboxFieldToggle>
        <Row.Title>{i18n('MultiAccount.AllAccounts')}</Row.Title>
      </NotificationRow>
      {!isGranted() && (
        <Button
          text="Notifications.Enable"
          class="btn-primary primary btn-transparent"
          icon="unmute"
          disabled={isGranted()}
          onClick={onClick}
        />
      )}
    </Section>
  );
};

const SoundSection = () => {
  const {uiNotificationsManager} = useHotReloadGuard();
  const [appSettings, setAppSettings] = useAppSettings();

  return (
    <Section
      name="Notifications.Sound.Section"
      caption="Notifications.Sound.Caption"
    >
      <Row>
        <Row.CheckboxFieldToggle>
          <CheckboxFieldTsx
            checked={appSettings.notifications.sound}
            onChange={(value) => {
              if(value && !appSettings.notifications.volume) {
                setAppSettings('notifications', 'volume', SETTINGS_INIT.notifications.volume);
              }

              setAppSettings('notifications', 'sound', value);
            }}
            toggle
          />
        </Row.CheckboxFieldToggle>
        <Row.Title>{i18n('Notifications.Sound')}</Row.Title>
      </Row>
      <RangeSettingSelector
        textLeft={i18n('Notifications.Sound.Volume')}
        textRight={(value) => '' + Math.floor(value * 100) + '%'}
        step={0.01}
        value={appSettings.notifications.volume}
        minValue={0}
        maxValue={1}
        onChange={(value) => {
          value = +value.toFixed(2);
          if(!value) {
            setAppSettings('notifications', 'sound', false);
          }

          setAppSettings('notifications', 'volume', value);
        }}
        onMouseUp={() => {
          uiNotificationsManager.testSound(appSettings.notifications.volume);
        }}
      />
    </Section>
  );
};

const SoundEffectsSection = () => {
  const [appSettings, setAppSettings] = useAppSettings();

  return (
    <Section name="Notifications.Sound.Effects">
      <Row>
        <Row.CheckboxFieldToggle>
          <CheckboxFieldTsx
            checked={appSettings.notifications.sentMessageSound}
            onChange={(value) => setAppSettings('notifications', 'sentMessageSound', value)}
            toggle
          />
        </Row.CheckboxFieldToggle>
        <Row.Title>{i18n('Notifications.Sound.Sent')}</Row.Title>
      </Row>
    </Section>
  );
};

const Notifications = () => {
  return (
    <>
      <NotificationsSection />
      {App.pushEnabled && <PhantomChatBackgroundNotifications />}
      <SoundSection />
      <SoundEffectsSection />
    </>
  );
}

export default Notifications;
