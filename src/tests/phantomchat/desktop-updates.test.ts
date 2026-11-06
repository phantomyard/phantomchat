/*
 * Desktop update settings — renderer side (issue #164).
 *
 * The tab itself needs a slider and a DOM, so what is tested here is the part
 * that carries the decisions: whether the row appears at all, and the status
 * text a user reads to decide whether to restart.
 */
import {describe, it, expect, afterEach} from 'vitest';
import {readFileSync} from 'fs';
import {resolve} from 'path';
import {
  getDesktopApi,
  isDesktopApp,
  hasDesktopUpdateApi,
  hasDesktopUpdateNotificationApi,
  type PhantomChatDesktopApi,
  type UpdateState
} from '../../lib/phantomchat/desktop-api';
import {
  describeUpdateStatus,
  describeLastChecked,
  describeActionButton,
  describeUpdateNotification
} from '../../lib/phantomchat/desktop-update-view';
import {mountUpdateNotification, UPDATE_NOTIFICATION_CLASS} from '../../lib/phantomchat/desktop-update-modal';

const baseState: UpdateState = {
  channel: 'stable',
  capability: 'auto',
  capabilityReason: null,
  currentVersion: '1.0.45',
  lastCheckedAt: null,
  status: 'idle',
  availableVersion: null,
  releaseUrl: null,
  progressPercent: null,
  error: null
};

const state = (patch: Partial<UpdateState>): UpdateState => ({...baseState, ...patch});

afterEach(() => {
  delete (window as any).phantomchatDesktop;
});

describe('desktop bridge detection', () => {
  it('reports web when the bridge is absent', () => {
    expect(getDesktopApi()).toBeNull();
    expect(isDesktopApp()).toBe(false);
    expect(hasDesktopUpdateApi()).toBe(false);
  });

  it('reports desktop when the bridge is present', () => {
    (window as any).phantomchatDesktop = {getUpdateState: () => {}, onUpdateState: () => () => {}};
    expect(isDesktopApp()).toBe(true);
    expect(hasDesktopUpdateApi()).toBe(true);
  });

  it('does NOT claim the update API on a desktop build packaged before #164', () => {
    // The bridge exists (getVersion/openExternal) but the update methods do
    // not. Showing the Updates row there would open a tab that can only
    // throw, so the row must stay hidden.
    (window as any).phantomchatDesktop = {getVersion: () => {}, openExternal: () => {}};
    expect(isDesktopApp()).toBe(true);
    expect(hasDesktopUpdateApi()).toBe(false);
  });

  it('ignores a non-object bridge', () => {
    (window as any).phantomchatDesktop = 'yes';
    expect(getDesktopApi()).toBeNull();
  });
});

describe('describeUpdateStatus', () => {
  it('explains each state in words a user can act on', () => {
    expect(describeUpdateStatus(state({status: 'checking'}))).toMatch(/checking/i);
    expect(describeUpdateStatus(state({status: 'up-to-date'}))).toMatch(/up to date/i);
    expect(describeUpdateStatus(state({status: 'available', availableVersion: '1.0.50'}))).toContain('1.0.50');
    expect(describeUpdateStatus(state({status: 'ready', availableVersion: '1.0.50'}))).toMatch(/restart/i);
  });

  it('shows download progress when there is a percentage', () => {
    expect(describeUpdateStatus(state({status: 'downloading', availableVersion: '1.0.50', progressPercent: 42})))
      .toContain('42%');
  });

  it('still reads sensibly before the first progress event', () => {
    const text = describeUpdateStatus(state({status: 'downloading', availableVersion: '1.0.50', progressPercent: null}));
    expect(text).toContain('1.0.50');
    expect(text).not.toContain('null');
  });

  it('surfaces the error instead of silently claiming everything is fine', () => {
    // A quietly failing updater is how an install sits on an old build for
    // months with nobody noticing.
    const text = describeUpdateStatus(state({status: 'error', error: 'GitHub returned 503'}));
    expect(text).toContain('503');
  });
});

describe('describeLastChecked', () => {
  const now = 1_700_000_000_000;

  it('says never before the first check', () => {
    expect(describeLastChecked(null, now)).toMatch(/never/i);
  });

  it('scales the unit with the age', () => {
    expect(describeLastChecked(now - 10_000, now)).toMatch(/just now/i);
    expect(describeLastChecked(now - 5 * 60_000, now)).toContain('5 minutes ago');
    expect(describeLastChecked(now - 3 * 3_600_000, now)).toContain('3 hours ago');
    expect(describeLastChecked(now - 2 * 86_400_000, now)).toContain('2 days ago');
  });

  it('singularises', () => {
    expect(describeLastChecked(now - 60_000, now)).toContain('1 minute ago');
    expect(describeLastChecked(now - 3_600_000, now)).toContain('1 hour ago');
  });

  it('never renders a negative age from a future timestamp', () => {
    expect(describeLastChecked(now + 3_600_000, now)).toMatch(/just now/i);
  });
});

describe('describeActionButton', () => {
  it('offers a restart once an update is downloaded', () => {
    expect(describeActionButton(state({status: 'ready', availableVersion: '1.0.50'})))
      .toEqual({label: 'Restart and install', enabled: true});
  });

  it('offers the release page on notify-only installs', () => {
    expect(describeActionButton(state({status: 'available', capability: 'notify', releaseUrl: 'https://x'})))
      .toEqual({label: 'Open release page', enabled: true});
  });

  it('offers nothing while idle, checking or up to date', () => {
    for(const status of ['idle', 'checking', 'up-to-date', 'downloading', 'error'] as const) {
      expect(describeActionButton(state({status}))).toBeNull();
    }
  });
});

describe('settings list wiring', () => {
  const settingsSrc = readFileSync(resolve(__dirname, '../../components/sidebarLeft/tabs/settings.ts'), 'utf8');

  it('gates the Updates row on the desktop update API, not merely on the bridge', () => {
    expect(settingsSrc).toContain('hasDesktopUpdateApi()');
  });

  it('loads the tab behind a dynamic import so the PWA never bundles it', () => {
    expect(settingsSrc).toContain("await import('@components/sidebarLeft/tabs/phantomchatDesktopUpdates')");
  });
});

describe('hasDesktopUpdateNotificationApi', () => {
  it('requires both the snooze and the dismiss method', () => {
    expect(hasDesktopUpdateNotificationApi()).toBe(false);
    (window as any).phantomchatDesktop = {
      getUpdateState: () => {},
      onUpdateState: () => () => {},
      remindLaterUpdate: () => {}
    };
    expect(hasDesktopUpdateNotificationApi()).toBe(false);
    (window as any).phantomchatDesktop = {
      getUpdateState: () => {},
      onUpdateState: () => () => {},
      remindLaterUpdate: () => {},
      dismissUpdateNotification: () => {}
    };
    expect(hasDesktopUpdateNotificationApi()).toBe(true);
  });
});

describe('describeUpdateNotification', () => {
  it('offers the restart once the update is downloaded', () => {
    const copy = describeUpdateNotification(state({status: 'ready', availableVersion: '1.1.120'}))!;
    expect(copy.title).toContain('1.1.120');
    expect(copy.updateLabel).toBe('Restart and install');
    expect(copy.remindLabel).toBe('Remind me later');
    // The primary label must match the Updates tab's button for the same
    // state: one update path, not two that disagree.
    expect(copy.updateLabel).toBe(describeActionButton(state({status: 'ready'}))!.label);
  });

  it('names the ring on the open-the-download path', () => {
    const stable = describeUpdateNotification(state({status: 'available', channel: 'stable', availableVersion: '1.1.120'}))!;
    const preview = describeUpdateNotification(state({status: 'available', channel: 'preview', availableVersion: '1.1.120'}))!;
    expect(stable.body).toContain('Stable');
    expect(preview.body).toContain('Preview');
    expect(preview.title).toContain('1.1.120');
    expect(preview.updateLabel).toBe('Open download page');
  });

  it('has nothing to say while checking, downloading, up to date or failed', () => {
    for(const status of ['idle', 'checking', 'downloading', 'up-to-date', 'error'] as const) {
      expect(describeUpdateNotification(state({status}))).toBeNull();
    }
  });

  it('never renders a notification without a version', () => {
    expect(describeUpdateNotification(state({status: 'ready', availableVersion: null}))).toBeNull();
  });
});

// --- the modal itself -------------------------------------------------------

type FakeApi = PhantomChatDesktopApi & {
  emit(state: UpdateState): void;
  calls: string[];
};

function fakeApi(initial: UpdateState): FakeApi {
  const listeners: ((state: UpdateState) => void)[] = [];
  const calls: string[] = [];
  let current = initial;
  return {
    calls,
    getVersion: async() => current.currentVersion,
    getPlatform: async() => 'linux',
    openExternal: async() => {},
    getUpdateState: async() => current,
    setUpdateChannel: async() => current,
    checkForUpdates: async() => current,
    installUpdate: async() => {
      calls.push('install');
      return true;
    },
    remindLaterUpdate: async() => {
      calls.push('remind');
      return current;
    },
    dismissUpdateNotification: async() => {
      calls.push('dismiss');
      return current;
    },
    onUpdateState: (listener) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if(index >= 0) listeners.splice(index, 1);
      };
    },
    emit(next: UpdateState) {
      current = next;
      for(const listener of [...listeners]) listener(next);
    }
  } as FakeApi;
}

/** Let the mount's initial getUpdateState() promise settle. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const modal = () => document.querySelector(`.${UPDATE_NOTIFICATION_CLASS}`) as HTMLElement | null;
const buttons = () => Array.from(modal()?.querySelectorAll('button') ?? []) as HTMLButtonElement[];

const readyState = (patch: Partial<UpdateState> = {}): UpdateState => state({
  status: 'ready',
  availableVersion: '1.1.120',
  progressPercent: 100,
  notifyPending: true,
  ...patch
});

afterEach(() => {
  modal()?.remove();
});

describe('the update notification modal', () => {
  it('appears on launch when main already reports a pending update', async() => {
    const api = fakeApi(readyState());
    const unmount = mountUpdateNotification({api});
    await flush();

    expect(modal()).not.toBeNull();
    expect(modal()!.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
    expect(buttons().map((b) => b.textContent)).toEqual(['Restart and install', 'Remind me later']);
    unmount();
  });

  it('does the same thing as the Updates tab button, then records it as handled', async() => {
    const api = fakeApi(readyState());
    const unmount = mountUpdateNotification({api});
    await flush();

    buttons()[0].click();
    await flush();
    expect(api.calls).toEqual(['install', 'dismiss']);
    expect(modal()).toBeNull();
    unmount();
  });

  it('snoozes instead of installing when told to remind later', async() => {
    const api = fakeApi(readyState());
    const unmount = mountUpdateNotification({api});
    await flush();

    buttons()[1].click();
    await flush();
    expect(api.calls).toEqual(['remind']);
    expect(modal()).toBeNull();
    unmount();
  });

  it('treats Escape as the quiet answer, never as update', async() => {
    const api = fakeApi(readyState());
    const unmount = mountUpdateNotification({api});
    await flush();

    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
    await flush();
    expect(api.calls).toEqual(['remind']);
    expect(modal()).toBeNull();
    unmount();
  });

  it('follows pushed state: raises on a push, disappears when it stops pending', async() => {
    const api = fakeApi(state({status: 'checking'}));
    const unmount = mountUpdateNotification({api});
    await flush();
    expect(modal()).toBeNull();

    api.emit(readyState());
    expect(modal()).not.toBeNull();

    api.emit(readyState({notifyPending: false}));
    expect(modal()).toBeNull();
    unmount();
  });

  it('never stacks a second modal for the same pending update', async() => {
    const api = fakeApi(readyState());
    const unmount = mountUpdateNotification({api});
    await flush();

    api.emit(readyState());
    api.emit(readyState());
    expect(document.querySelectorAll(`.${UPDATE_NOTIFICATION_CLASS}`)).toHaveLength(1);
    unmount();
  });

  it('stays quiet without notifyPending — including on bridges that never send it', async() => {
    for(const pending of [false, undefined]) {
      const api = fakeApi(readyState({notifyPending: pending}));
      const unmount = mountUpdateNotification({api});
      await flush();
      expect(modal()).toBeNull();
      unmount();
    }
  });

  it('stays quiet when an update exists but cannot be acted on yet', async() => {
    const api = fakeApi(readyState({status: 'downloading', notifyPending: false}));
    const unmount = mountUpdateNotification({api});
    await flush();
    expect(modal()).toBeNull();
    unmount();
  });

  it('removes the modal and the key listener on unmount', async() => {
    const api = fakeApi(readyState());
    const unmount = mountUpdateNotification({api});
    await flush();
    expect(modal()).not.toBeNull();

    unmount();
    expect(modal()).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
    await flush();
    expect(api.calls).toEqual([]);
  });

  it('does nothing at all on a build that cannot snooze or dismiss', async() => {
    // Older packaged build: the update bridge exists, the notification methods
    // do not. A modal there could not be answered, so it must not appear.
    (window as any).phantomchatDesktop = {
      getUpdateState: async() => readyState(),
      onUpdateState: () => () => {},
      installUpdate: async() => true
    };
    const unmount = mountUpdateNotification();
    await flush();
    expect(modal()).toBeNull();
    unmount();
  });
});

describe('update notification boot wiring', () => {
  const integrationSrc = readFileSync(resolve(__dirname, '../../pages/phantomchat-onboarding-integration.ts'), 'utf8');

  it('mounts from the boot integration, behind a dynamic import', () => {
    expect(integrationSrc).toContain("await import('@lib/phantomchat/desktop-update-modal')");
    expect(integrationSrc).toContain('mountUpdateNotification()');
  });
});
