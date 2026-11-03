/*
 * Desktop phantombot bridge — renderer side. The bridge itself is tested in
 * electron/phantombot/; this pins the PWA's detection, which must return null
 * on the web and on desktop installs packaged before the bridge shipped.
 */
import {describe, it, expect, afterEach} from 'vitest';
import {getDesktopPhantombot} from '../../lib/phantomchat/desktop-api';

afterEach(() => {
  delete (window as any).phantomchatDesktop;
});

describe('phantombot bridge detection', () => {
  it('is null on the web', () => {
    expect(getDesktopPhantombot()).toBeNull();
  });

  it('is null on an older desktop install without the bridge', () => {
    (window as any).phantomchatDesktop = {getVersion: () => {}};
    expect(getDesktopPhantombot()).toBeNull();
  });

  it('is null when the bridge is incomplete', () => {
    (window as any).phantomchatDesktop = {phantombot: {call: () => {}}};
    expect(getDesktopPhantombot()).toBeNull();
  });

  it('returns the bridge when the preload exposes it', () => {
    const phantombot = {call: () => Promise.resolve({ok: true, value: null}), onEvent: () => () => {}};
    (window as any).phantomchatDesktop = {phantombot};
    expect(getDesktopPhantombot()).toBe(phantombot);
  });
});
