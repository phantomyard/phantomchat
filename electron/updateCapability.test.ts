/*
 * Which installs may install an update over themselves. This is a safety
 * boundary, not a preference: overwriting a dpkg-owned file or trying
 * Squirrel.Mac on a bundle sitting on a read-only DMG leaves a broken
 * install behind.
 */
import {describe, it, expect} from 'vitest';
import {mkdirSync, mkdtempSync, writeFileSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  resolveUpdateCapability,
  describeNotifyReason,
  findExecutableOnPath,
  PRIVILEGE_AGENTS
} from './updateCapability';

const packaged = (platform: NodeJS.Platform, env: Record<string, string | undefined> = {}) =>
  ({platform, env, isPackaged: true});

describe('resolveUpdateCapability', () => {
  it('auto-updates a packaged Windows install (NSIS works unsigned)', () => {
    expect(resolveUpdateCapability(packaged('win32'))).toBe('auto');
  });

  it('auto-updates an AppImage, identified by the APPIMAGE env var', () => {
    expect(resolveUpdateCapability(packaged('linux', {APPIMAGE: '/tmp/PhantomChat.AppImage'}))).toBe('auto');
  });

  it('treats an empty APPIMAGE as not-an-AppImage rather than truthy-by-presence', () => {
    expect(resolveUpdateCapability(packaged('linux', {APPIMAGE: ''}))).toBe('notify');
  });

  it('auto-updates a .deb install when a privilege agent can prompt for root', () => {
    // electron-updater 6.8 DebUpdater: dpkg -i the downloaded package.
    expect(resolveUpdateCapability({...packaged('linux'), packageType: 'deb', privilegeAgentPresent: true})).toBe('auto');
  });

  it('auto-updates an .rpm install the same way (dnf/zypper)', () => {
    expect(resolveUpdateCapability({...packaged('linux'), packageType: 'rpm', privilegeAgentPresent: true})).toBe('auto');
  });

  it('falls back to notify on a deb/rpm install without a privilege agent', () => {
    // No pkexec on PATH: an install would die mid-flight at the sudo step.
    expect(resolveUpdateCapability({...packaged('linux'), packageType: 'deb', privilegeAgentPresent: false})).toBe('notify');
    expect(resolveUpdateCapability({...packaged('linux'), packageType: 'rpm', privilegeAgentPresent: false})).toBe('notify');
  });

  it('stays notify-only on a pacman install (no PacmanUpdater wiring here)', () => {
    expect(resolveUpdateCapability({...packaged('linux'), packageType: 'pacman', privilegeAgentPresent: true})).toBe('notify');
  });

  it('stays notify-only when no install type is identifiable on linux', () => {
    // Unpacked dir, or a package built before package-type existed.
    expect(resolveUpdateCapability(packaged('linux', {}))).toBe('notify');
  });

  it('treats a garbage package-type as unidentifiable, never as deb/rpm', () => {
    expect(resolveUpdateCapability({...packaged('linux'), packageType: null, privilegeAgentPresent: true})).toBe('notify');
  });

  it('the APPIMAGE signal wins even if package metadata is somehow present', () => {
    expect(resolveUpdateCapability({
      ...packaged('linux', {APPIMAGE: '/tmp/PhantomChat.AppImage'}),
      packageType: 'deb',
      privilegeAgentPresent: false
    })).toBe('auto');
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
      expect(resolveUpdateCapability({platform, env: {APPIMAGE: '/x'}, isPackaged: false, packageType: 'deb'})).toBe('notify');
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
    expect(describeNotifyReason({...packaged('linux'), packageType: 'deb', privilegeAgentPresent: false})).toMatch(/pkexec/i);
    expect(describeNotifyReason({...packaged('linux'), packageType: 'rpm', privilegeAgentPresent: false})).toMatch(/pkexec/i);
    // With an agent present the deb/rpm reasons never appear — capability is auto.
    expect(describeNotifyReason({...packaged('linux'), packageType: 'rpm', privilegeAgentPresent: true})).not.toMatch(/pkexec/i);
    expect(describeNotifyReason({platform: 'linux', env: {}, isPackaged: false})).toMatch(/development/i);
  });
});

describe('findExecutableOnPath (privilege-agent probe)', () => {
  const mkdtempTree = () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-agent-'));
    return root;
  };

  it('finds an executable agent anywhere on PATH', () => {
    const dir = mkdtempTree();
    const agent = join(dir, 'pkexec');
    writeFileSync(agent, '#!/bin/sh\n');
    chmodSync(agent, 0o755);
    expect(findExecutableOnPath('pkexec', dir)).toBe(agent);
  });

  it('rejects a NON-EXECUTABLE file named pkexec (existsSync would pass, command -v would not)', () => {
    // Kai/Omar's #202 repro: a file named pkexec without the exec bit must
    // not advertise 'auto' — electron-updater would fall through to bare sudo.
    const dir = mkdtempTree();
    const agent = join(dir, 'pkexec');
    writeFileSync(agent, 'not a program');
    chmodSync(agent, 0o644);
    expect(findExecutableOnPath('pkexec', dir)).toBeNull();
    // Even 000 — existsSync still true, usable it is not.
    chmodSync(agent, 0o000);
    expect(findExecutableOnPath('pkexec', dir)).toBeNull();
  });

  it('rejects a directory named pkexec on PATH', () => {
    const dir = mkdtempTree();
    mkdirSync(join(dir, 'pkexec'));
    expect(findExecutableOnPath('pkexec', dir)).toBeNull();
  });

  it('returns null for an empty or unset PATH and keeps scanning past misses', () => {
    expect(findExecutableOnPath('pkexec', '')).toBeNull();
    expect(findExecutableOnPath('pkexec', undefined)).toBeNull();
    const emptyDir = mkdtempTree();
    const realDir = mkdtempTree();
    const agent = join(realDir, 'gksudo');
    writeFileSync(agent, '#!/bin/sh\n');
    chmodSync(agent, 0o755);
    expect(findExecutableOnPath('gksudo', [emptyDir, realDir].join(':'))).toBe(agent);
  });

  it('covers every agent the updater can invoke, matching the sudo command list', () => {
    const dir = mkdtempTree();
    for(const agent of PRIVILEGE_AGENTS) {
      const p = join(dir, agent);
      writeFileSync(p, '#!/bin/sh\n');
      chmodSync(p, 0o755);
      expect(findExecutableOnPath(agent, dir)).toBe(p);
    }
  });
});
