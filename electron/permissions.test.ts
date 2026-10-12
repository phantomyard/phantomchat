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
  // Electron 39 checks permissions BEFORE requesting them — the check must
  // answer "a request may come" for the app origin or most APIs never fire a
  // request at all (review blocker on #153). The real gate is the request
  // handler's prompt.
  it('answers yes for the app origin, any permission, any media type', () => {
    for(const permission of ['media', 'notifications', 'clipboard-read', 'geolocation', 'fullscreen', 'unknown']) {
      expect(isPermissionCheckAllowed({permission, requestingOrigin: APP_ORIGIN})).toBe(true);
    }
    expect(isPermissionCheckAllowed({permission: 'media', requestingOrigin: APP_ORIGIN, mediaType: 'screen'})).toBe(true);
    expect(isPermissionCheckAllowed({permission: 'media', requestingOrigin: APP_ORIGIN})).toBe(true);
  });

  it('denies foreign origins on the check path', () => {
    for(const requestingOrigin of ['https://evil.example', 'app://localhost.evil', 'file://', 'null', undefined]) {
      expect(isPermissionCheckAllowed({permission: 'media', requestingOrigin, mediaType: 'audio'})).toBe(false);
      expect(isPermissionCheckAllowed({permission: 'notifications', requestingOrigin})).toBe(false);
    }
  });

  it('trusts the dev server origin in dev only, on both handler paths', () => {
    expect(isPermissionCheckAllowed({permission: 'media', requestingOrigin: 'http://localhost:8080', mediaType: 'audio'}, DEV)).toBe(true);
    expect(isPermissionCheckAllowed({permission: 'media', requestingOrigin: 'http://localhost:8080', mediaType: 'audio'})).toBe(false);
    expect(isPermissionCheckAllowed({permission: 'notifications', requestingOrigin: 'http://localhost:9999'}, DEV)).toBe(false);
  });

  it('a full requestingUrl vouches on the check path too, when present', () => {
    expect(isPermissionCheckAllowed({permission: 'media', requestingOrigin: 'null', requestingUrl: APP, mediaType: 'audio'})).toBe(true);
    expect(isPermissionCheckAllowed({permission: 'media', requestingOrigin: 'null', requestingUrl: 'https://evil.example/', mediaType: 'audio'})).toBe(false);
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
