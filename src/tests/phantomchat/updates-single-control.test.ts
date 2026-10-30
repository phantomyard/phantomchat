/*
 * One Release channel control for both surfaces (owner batch 8, 2026-10-30).
 *
 * Before this, Electron had two update controls: an application channel
 * picker and a separate desktop-installer ring, each with its own
 * Stable/Preview radio. One intent, two switches — so a user could land on
 * preview web with a stable installer and believe they had switched.
 *
 * What is tested here is the decision, not the DOM: which channel a single
 * radio shows, and what happens to the *other* surface when one of them
 * refuses.
 */
import {describe, it, expect, vi} from 'vitest';
import {readFileSync} from 'fs';
import {resolve} from 'path';
import {getChannelChoiceState, applyChannelChoice} from '../../lib/phantomchat/desktop-update-view';
import type {UpdateChannel} from '../../lib/phantomchat/desktop-api';

function desktopTarget(current: UpdateChannel | null, impl?: (c: UpdateChannel) => Promise<UpdateChannel>) {
  const set = vi.fn(impl ?? (async(c: UpdateChannel) => c));
  return {target: {current, set}, set};
}

describe('getChannelChoiceState', () => {
  it('prefers the application channel when both surfaces exist', () => {
    // The user is looking at the app, so the radio must not advertise a ring
    // the app is not running.
    expect(getChannelChoiceState({application: 'stable', desktop: 'preview'}).selected).toBe('stable');
    expect(getChannelChoiceState({application: 'preview', desktop: 'stable'}).selected).toBe('preview');
  });

  it('falls back to the desktop ring, then to stable', () => {
    expect(getChannelChoiceState({application: null, desktop: 'preview'}).selected).toBe('preview');
    expect(getChannelChoiceState({application: null, desktop: null}).selected).toBe('stable');
  });

  it('is only interactive when at least one surface exists', () => {
    expect(getChannelChoiceState({application: 'stable', desktop: null}).interactive).toBe(true);
    expect(getChannelChoiceState({application: null, desktop: 'stable'}).interactive).toBe(true);
    expect(getChannelChoiceState({application: null, desktop: null}).interactive).toBe(false);
  });
});

describe('applyChannelChoice', () => {
  it('drives both surfaces from one choice', async () => {
    const {target, set} = desktopTarget('stable');
    const choose = vi.fn(() => true);
    const result = await applyChannelChoice({
      application: {current: 'stable', choose},
      desktop: target
    }, 'preview');

    expect(set.mock.calls).toEqual([['preview']]);
    expect(choose.mock.calls).toEqual([['preview']]);
    expect(result).toMatchObject({application: 'preview', desktop: 'preview', outcome: 'applied'});
  });

  it('sets the desktop ring before the application side can navigate away', async () => {
    const order: string[] = [];
    const {target} = desktopTarget('stable', async(c) => { order.push('desktop:' + c); return c; });
    await applyChannelChoice({
      application: {current: 'stable', choose: () => { order.push('app'); return true; }},
      desktop: target
    }, 'preview');
    expect(order).toEqual(['desktop:preview', 'app']);
  });

  it('never touches the application side when the desktop ring rejects the channel', async () => {
    const {target} = desktopTarget('stable', async() => { throw new Error('nope'); });
    const choose = vi.fn(() => true);
    const result = await applyChannelChoice({
      application: {current: 'stable', choose},
      desktop: target
    }, 'preview');

    expect(choose).not.toHaveBeenCalled();
    expect(result).toMatchObject({application: 'stable', desktop: 'stable', outcome: 'desktop-rejected'});
  });

  it('rolls the desktop ring back when the user cancels the application switch', async () => {
    // Preview asks for a confirmation; backing out of it must not leave the
    // installer on a ring the user declined.
    const {target, set} = desktopTarget('stable');
    const result = await applyChannelChoice({
      application: {current: 'stable', choose: () => false},
      desktop: target
    }, 'preview');

    expect(set.mock.calls).toEqual([['preview'], ['stable']]);
    expect(result).toMatchObject({application: 'stable', desktop: 'stable', outcome: 'cancelled'});
  });

  it('works with a desktop surface alone (no channel shell)', async () => {
    const {target} = desktopTarget('stable');
    const result = await applyChannelChoice({application: null, desktop: target}, 'preview');
    expect(result).toMatchObject({application: null, desktop: 'preview', outcome: 'applied'});
  });

  it('works with an application surface alone (PWA, no installer)', async () => {
    const result = await applyChannelChoice({
      application: {current: 'stable', choose: () => true},
      desktop: null
    }, 'preview');
    expect(result).toMatchObject({application: 'preview', desktop: null, outcome: 'applied'});
  });

  it('is a no-op on the desktop side when the ring is already the one chosen', async () => {
    const {target, set} = desktopTarget('preview');
    await applyChannelChoice({application: null, desktop: target}, 'preview');
    expect(set).not.toHaveBeenCalled();
  });
});

describe('the tab carries only one release-channel control', () => {
  const tabSrc = readFileSync(resolve(__dirname, '../../components/sidebarLeft/tabs/phantomchatApplicationUpdates.ts'), 'utf8');
  const desktopTabSrc = readFileSync(resolve(__dirname, '../../components/sidebarLeft/tabs/phantomchatDesktopUpdates.ts'), 'utf8');

  it('has exactly one radio group, used for both surfaces', () => {
    // Two radios, one group: the same name is what makes Stable/Preview
    // mutually exclusive, and a second group would mean a second control.
    const names = [...tabSrc.matchAll(/name: '(phantomchat[-a-z]+-channel)'/g)].map((m) => m[1]);
    expect(names).toEqual(['phantomchat-update-channel', 'phantomchat-update-channel']);
  });

  it('no longer links to a second "Desktop updates" screen', () => {
    // The old second control was a Row titled "Desktop updates" that opened
    // its own ring picker.
    expect(tabSrc).not.toContain("title: 'Desktop updates'");
    expect(tabSrc).not.toContain('phantomchatDesktopUpdates');
  });

  it('routes the desktop entry point at the same implementation', () => {
    expect(desktopTabSrc).toContain("export {default} from '@components/sidebarLeft/tabs/phantomchatApplicationUpdates';");
  });
});
