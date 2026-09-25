/*
 * Which installs may install an update over themselves. This is a safety
 * boundary, not a preference: overwriting a dpkg-owned file or trying
 * Squirrel.Mac on an unsigned app leaves a broken install behind.
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

  it('only notifies on macOS — Squirrel.Mac requires a signed app', () => {
    expect(resolveUpdateCapability(packaged('darwin'))).toBe('notify');
    expect(resolveUpdateCapability(packaged('darwin', {APPIMAGE: '/x'}))).toBe('notify');
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
    expect(describeNotifyReason(packaged('darwin'))).toMatch(/signed app/i);
    expect(describeNotifyReason(packaged('linux', {}))).toMatch(/package manager/i);
    expect(describeNotifyReason({platform: 'linux', env: {}, isPackaged: false})).toMatch(/development/i);
  });
});
