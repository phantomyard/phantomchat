/*
 * Desktop permission policy (issue #215): the app's own pages get the
 * local-app contract — promptless clipboard, native prompts for everything
 * else, remembered grants and settings-tab overrides. Foreign origins are
 * denied outright on both handler paths.
 */
import {describe, it, expect} from 'vitest';
import {
  resolvePermissionRequest,
  isPermissionCheckAllowed,
  isTrustedAppUrl,
  grantAlways,
  parsePermissionSettings,
  defaultPermissionSettings,
  PROMPTLESS_PERMISSIONS,
  PERMISSION_SETTINGS_FILE,
  isPermissionSetting,
  type PermissionSettings
} from './permissions';

const APP = 'app://localhost/index.html';
const APP_ORIGIN = 'app://localhost';
const DEV = 'http://localhost:8080';

describe('resolvePermissionRequest', () => {
  it('denies every foreign origin outright, no prompt', () => {
    for(const requestingUrl of ['https://evil.example/', 'app://localhost.evil/', 'file:///etc/passwd', 'not a url', undefined]) {
      for(const permission of ['media', 'clipboard-read', 'notifications', 'geolocation', 'unknown']) {
        expect(resolvePermissionRequest({permission, requestingUrl}, defaultPermissionSettings())).toBe('deny');
      }
    }
  });

  it('allows the promptless clipboard permissions without a prompt', () => {
    expect(PROMPTLESS_PERMISSIONS).toContain('clipboard-read');
    expect(PROMPTLESS_PERMISSIONS).toContain('clipboard-sanitized-write');
    expect(resolvePermissionRequest({permission: 'clipboard-read', requestingUrl: APP}, defaultPermissionSettings())).toBe('allow');
    expect(resolvePermissionRequest({permission: 'clipboard-sanitized-write', requestingUrl: APP}, defaultPermissionSettings())).toBe('allow');
  });

  it('prompts for everything else on first use', () => {
    for(const permission of ['media', 'notifications', 'geolocation', 'midi', 'hid', 'serial', 'usb', 'display-capture']) {
      expect(resolvePermissionRequest({permission, requestingUrl: APP}, defaultPermissionSettings())).toBe('prompt');
    }
  });

  it('allows a remembered "Always allow" grant', () => {
    const settings = grantAlways(defaultPermissionSettings(), 'media');
    expect(resolvePermissionRequest({permission: 'media', requestingUrl: APP}, settings)).toBe('allow');
    // …but only that permission — others still prompt.
    expect(resolvePermissionRequest({permission: 'geolocation', requestingUrl: APP}, settings)).toBe('prompt');
  });

  it('an explicit override wins over both grants and promptless defaults', () => {
    const deny: PermissionSettings = {...defaultPermissionSettings(), overrides: {'clipboard-read': 'deny'}};
    expect(resolvePermissionRequest({permission: 'clipboard-read', requestingUrl: APP}, deny)).toBe('deny');

    const denyGrant: PermissionSettings = {...defaultPermissionSettings(), overrides: {'media': 'deny'}, granted: ['media']};
    expect(resolvePermissionRequest({permission: 'media', requestingUrl: APP}, denyGrant)).toBe('deny');

    const allow: PermissionSettings = {...defaultPermissionSettings(), overrides: {'geolocation': 'allow'}};
    expect(resolvePermissionRequest({permission: 'geolocation', requestingUrl: APP}, allow)).toBe('allow');
  });

  it('an "allow" override beats a deny already recorded as granted, and vice versa', () => {
    // Overrides are the settings tab's word, remembered grants are only the
    // prompt's — the tab wins in both directions.
    const allow: PermissionSettings = {...defaultPermissionSettings(), overrides: {'midi': 'allow'}, granted: []};
    expect(resolvePermissionRequest({permission: 'midi', requestingUrl: APP}, allow)).toBe('allow');
  });

  it('trusts the dev server origin only when running in dev', () => {
    const req = {permission: 'media', requestingUrl: DEV + '/'};
    expect(resolvePermissionRequest(req, defaultPermissionSettings(), DEV)).toBe('prompt');
    expect(resolvePermissionRequest(req, defaultPermissionSettings())).toBe('deny');
    expect(isTrustedAppUrl('http://localhost:9999/', DEV)).toBe(false);
  });
});

describe('isPermissionCheckAllowed (setPermissionCheckHandler path)', () => {
  // The check result is what navigator.permissions.query reports, so it
  // must mirror the request policy EXACTLY (review blocker on #216): true
  // only when the effective decision is 'allow', false for both 'prompt'
  // and 'deny'. Otherwise a request handler that would deny is bypassed.
  it('answers yes only for effective-allow states: promptless defaults, remembered grants, allow overrides', () => {
    const settings = defaultPermissionSettings();
    // Promptless clipboard pair is allowed by default.
    expect(isPermissionCheckAllowed({permission: 'clipboard-read', requestingOrigin: APP_ORIGIN}, settings)).toBe(true);
    expect(isPermissionCheckAllowed({permission: 'clipboard-sanitized-write', requestingOrigin: APP_ORIGIN}, settings)).toBe(true);
    // Remembered "Always allow" grant.
    const granted = grantAlways(defaultPermissionSettings(), 'media');
    expect(isPermissionCheckAllowed({permission: 'media', requestingOrigin: APP_ORIGIN}, granted)).toBe(true);
    // Explicit allow override, incl. one that beats a recorded grant.
    const allow: PermissionSettings = {...defaultPermissionSettings(), overrides: {'geolocation': 'allow'}};
    expect(isPermissionCheckAllowed({permission: 'geolocation', requestingOrigin: APP_ORIGIN}, allow)).toBe(true);
    const allowGrant: PermissionSettings = {...defaultPermissionSettings(), overrides: {'midi': 'allow'}, granted: ['midi']};
    expect(isPermissionCheckAllowed({permission: 'midi', requestingOrigin: APP_ORIGIN}, allowGrant)).toBe(true);
  });

  // Integration-level regression for the #216 review blocker: with the old
  // origin-only check, an app-origin geolocation with a deny request
  // handler reported navigator.permissions.query as 'granted' and the
  // request handler was never called. The check must NOT report granted
  // for a denied or un-granted ('ask') permission.
  it('never reports granted for a denied or ask (un-granted, promptless-default) permission', () => {
    const deny: PermissionSettings = {...defaultPermissionSettings(), overrides: {'geolocation': 'deny'}};
    expect(isPermissionCheckAllowed({permission: 'geolocation', requestingOrigin: APP_ORIGIN}, deny)).toBe(false);
    // 'ask' = no override, no grant, not promptless: the default state for
    // media/notifications/geolocation/etc.
    expect(isPermissionCheckAllowed({permission: 'geolocation', requestingOrigin: APP_ORIGIN}, defaultPermissionSettings())).toBe(false);
    expect(isPermissionCheckAllowed({permission: 'media', requestingOrigin: APP_ORIGIN, mediaType: 'screen'}, defaultPermissionSettings())).toBe(false);
    expect(isPermissionCheckAllowed({permission: 'notifications', requestingOrigin: APP_ORIGIN}, defaultPermissionSettings())).toBe(false);
    // An explicit deny even beats a remembered grant (tab wins).
    const denyBeatsGrant: PermissionSettings = {...defaultPermissionSettings(), overrides: {'media': 'deny'}, granted: ['media']};
    expect(isPermissionCheckAllowed({permission: 'media', requestingOrigin: APP_ORIGIN}, denyBeatsGrant)).toBe(false);
    // Turning OFF the promptless clipboard default is honoured too.
    const clipboardOff: PermissionSettings = {...defaultPermissionSettings(), overrides: {'clipboard-read': 'deny'}};
    expect(isPermissionCheckAllowed({permission: 'clipboard-read', requestingOrigin: APP_ORIGIN}, clipboardOff)).toBe(false);
  });

  it('denies foreign origins on the check path, regardless of settings', () => {
    const allow: PermissionSettings = {...defaultPermissionSettings(), overrides: {'media': 'allow'}};
    for(const requestingOrigin of ['https://evil.example', 'app://localhost.evil', 'file://', 'null', undefined]) {
      expect(isPermissionCheckAllowed({permission: 'media', requestingOrigin, mediaType: 'audio'}, defaultPermissionSettings())).toBe(false);
      expect(isPermissionCheckAllowed({permission: 'notifications', requestingOrigin}, defaultPermissionSettings())).toBe(false);
      expect(isPermissionCheckAllowed({permission: 'media', requestingOrigin}, allow)).toBe(false);
    }
  });

  it('trusts the dev server origin in dev only, on both handler paths', () => {
    const granted = grantAlways(defaultPermissionSettings(), 'media');
    expect(isPermissionCheckAllowed({permission: 'media', requestingOrigin: 'http://localhost:8080', mediaType: 'audio'}, granted, DEV)).toBe(true);
    expect(isPermissionCheckAllowed({permission: 'media', requestingOrigin: 'http://localhost:8080', mediaType: 'audio'}, granted)).toBe(false);
    expect(isPermissionCheckAllowed({permission: 'notifications', requestingOrigin: 'http://localhost:9999'}, granted, DEV)).toBe(false);
  });

  it('a full requestingUrl vouches on the check path too, when present', () => {
    const granted = grantAlways(defaultPermissionSettings(), 'media');
    expect(isPermissionCheckAllowed({permission: 'media', requestingOrigin: 'null', requestingUrl: APP, mediaType: 'audio'}, granted)).toBe(true);
    expect(isPermissionCheckAllowed({permission: 'media', requestingOrigin: 'null', requestingUrl: 'https://evil.example/', mediaType: 'audio'}, granted)).toBe(false);
  });

  it('uses the exact Electron 39 permission identifier for file access (fileSystem, not file-system)', () => {
    // Electron emits 'fileSystem' camelCase; a kebab-case key would store an
    // override Electron never consults (review blocker on #216).
    const deny: PermissionSettings = {...defaultPermissionSettings(), overrides: {'fileSystem': 'deny'}};
    expect(isPermissionCheckAllowed({permission: 'fileSystem', requestingOrigin: APP_ORIGIN}, deny)).toBe(false);
    expect(isPermissionCheckAllowed({permission: 'fileSystem', requestingOrigin: APP_ORIGIN}, defaultPermissionSettings())).toBe(false);
    const allow: PermissionSettings = {...defaultPermissionSettings(), overrides: {'fileSystem': 'allow'}};
    expect(isPermissionCheckAllowed({permission: 'fileSystem', requestingOrigin: APP_ORIGIN}, allow)).toBe(true);
    // The request path must agree on the identifier.
    expect(resolvePermissionRequest({permission: 'fileSystem', requestingUrl: APP}, allow)).toBe('allow');
    expect(resolvePermissionRequest({permission: 'fileSystem', requestingUrl: APP}, defaultPermissionSettings())).toBe('prompt');
  });
});

describe('parsePermissionSettings (defensive JSON parse)', () => {
  it('returns defaults for garbage, null, non-objects', () => {
    for(const raw of [undefined, null, 42, 'x', {overrides: 'nope'}, {granted: 'nope'}]) {
      expect(parsePermissionSettings(raw)).toEqual(defaultPermissionSettings());
    }
  });

  it('keeps valid overrides and drops invalid ones', () => {
    const parsed = parsePermissionSettings({overrides: {media: 'deny', midi: 'allow', evil: 'yes', fullscreen: 'ask'}});
    expect(parsed.overrides).toEqual({media: 'deny', midi: 'allow'});
  });

  it('keeps valid permission names in granted, drops the rest', () => {
    const parsed = parsePermissionSettings({granted: ['media', 'not a permission!', 42, null, 'midiSysex']});
    expect(parsed.granted).toEqual(['media', 'midiSysex']);
  });

  it('skips granted entries that an explicit override already governs', () => {
    const parsed = parsePermissionSettings({overrides: {media: 'deny'}, granted: ['media']});
    expect(parsed.granted).toEqual([]);
  });
});

describe('grantAlways', () => {
  it('records the grant exactly once', () => {
    let settings = defaultPermissionSettings();
    grantAlways(settings, 'media');
    grantAlways(settings, 'media');
    expect(settings.granted).toEqual(['media']);
  });

  it('never resurrects a permission the settings tab turned off', () => {
    const settings: PermissionSettings = {...defaultPermissionSettings(), overrides: {'media': 'deny'}};
    grantAlways(settings, 'media');
    expect(settings.granted).toEqual([]);
  });
});

describe('misc', () => {
  it('settings filename is stable (userData/permissions.json)', () => {
    expect(PERMISSION_SETTINGS_FILE).toBe('permissions.json');
  });

  it('isPermissionSetting accepts only the three states', () => {
    expect(isPermissionSetting('allow')).toBe(true);
    expect(isPermissionSetting('deny')).toBe(true);
    expect(isPermissionSetting('ask')).toBe(true);
    expect(isPermissionSetting('yes')).toBe(false);
  });
});
