/*
 * Which installs may install an update over themselves. This is a safety
 * boundary, not a preference: overwriting a dpkg-owned file or trying
 * Squirrel.Mac on a bundle sitting on a read-only DMG leaves a broken
 * install behind.
 */
import {describe, it, expect} from 'vitest';
import {resolveUpdateCapability, describeNotifyReason} from './updateCapability';

const packaged = (platform: NodeJS.Platform, env: Record<string, string | undefined> = {}) =>
  ({platform, env, isPackaged: true});

describe('resolveUpdateCapability', () => {
  it('auto-updates a packaged Windows install (NSIS works unsigned)', () => {
    expect(resolveUpdateCapability(packaged('win32'))).toBe('auto');
  });

  it('auto-updates an AppImage, identified by the APPIMAGE env var', () => {
    expect(resolveUpdateCapability(packaged('linux', {APPIMAGE: '/tmp/PhantomChat.AppImage'}))).toBe('auto');
  });

  it('only notifies on a .deb install — dpkg owns those files', () => {
    expect(resolveUpdateCapability(packaged('linux', {}))).toBe('notify');
  });

  it('treats an empty APPIMAGE as not-an-AppImage rather than truthy-by-presence', () => {
    expect(resolveUpdateCapability(packaged('linux', {APPIMAGE: ''}))).toBe('notify');
  });

  it('auto-updates a packaged macOS install (signed + notarized, #168/#169)', () => {
    expect(resolveUpdateCapability({...packaged('darwin'), appPath: '/Applications/PhantomChat.app/Contents/MacOS/PhantomChat'})).toBe('auto');
    // No appPath at all must not read as "running from a DMG".
    expect(resolveUpdateCapability(packaged('darwin'))).toBe('auto');
  });

  it('stays notify-only on macOS when the app is running from its mounted DMG', () => {
    // Squirrel.Mac cannot replace a bundle on a read-only volume, and the
    // update would be ejected with the image anyway.
    expect(resolveUpdateCapability({
      ...packaged('darwin'),
      appPath: '/Volumes/PhantomChat 1.0.274/PhantomChat.app/Contents/MacOS/PhantomChat'
    })).toBe('notify');
  });

  it('stays notify-only on macOS under Gatekeeper App Translocation', () => {
    // The COMMON shape of "launched from the DMG": a quarantined app run from
    // outside /Applications is copied to a randomized read-only mount and
    // executed from there, so there is no /Volumes prefix to match on. A
    // guard that only knows /Volumes would hand Squirrel.Mac exactly the
    // read-only install it exists to refuse.
    expect(resolveUpdateCapability({
      ...packaged('darwin'),
      appPath: '/private/var/folders/qz/8m1k3d1x0_s7/T/AppTranslocation/3F2A1C8E-0B44-4E77-9A31-1D2C3B4A5E6F/d/PhantomChat.app/Contents/MacOS/PhantomChat'
    })).toBe('notify');
  });

  it('never auto-updates an unpackaged dev run, on any platform', () => {
    for(const platform of ['win32', 'linux', 'darwin'] as NodeJS.Platform[]) {
      expect(resolveUpdateCapability({platform, env: {APPIMAGE: '/x'}, isPackaged: false})).toBe('notify');
    }
  });

  it('defaults unknown platforms to notify', () => {
    expect(resolveUpdateCapability(packaged('freebsd' as NodeJS.Platform))).toBe('notify');
  });
});

describe('describeNotifyReason', () => {
  it('explains each ceiling in terms the user can act on', () => {
    expect(describeNotifyReason({
      ...packaged('darwin'),
      appPath: '/Volumes/PhantomChat 1.0.274/PhantomChat.app/Contents/MacOS/PhantomChat'
    })).toMatch(/applications folder/i);
    expect(describeNotifyReason({
      ...packaged('darwin'),
      appPath: '/private/var/folders/qz/8m1k3d1x0_s7/T/AppTranslocation/3F2A1C8E/d/PhantomChat.app/Contents/MacOS/PhantomChat'
    })).toMatch(/applications folder/i);
    expect(describeNotifyReason(packaged('linux', {}))).toMatch(/package manager/i);
    expect(describeNotifyReason({platform: 'linux', env: {}, isPackaged: false})).toMatch(/development/i);
  });
});
