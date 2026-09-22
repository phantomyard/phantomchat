/*
 * Desktop permission policy: mic, camera and notifications for the app's own
 * pages only; everything else stays denied.
 */
import {describe, it, expect} from 'vitest';
import {isPermissionAllowed, isPermissionCheckAllowed, isTrustedAppUrl} from './permissions';

const APP = 'app://localhost/index.html';
const DEV = 'http://localhost:8080';

describe('isPermissionAllowed', () => {
  it('grants microphone and camera to the packaged app', () => {
    expect(isPermissionAllowed({permission: 'media', requestingUrl: APP, mediaTypes: ['audio']})).toBe(true);
    expect(isPermissionAllowed({permission: 'media', requestingUrl: APP, mediaTypes: ['video']})).toBe(true);
    expect(isPermissionAllowed({permission: 'media', requestingUrl: APP, mediaTypes: ['audio', 'video']})).toBe(true);
  });

  it('grants notifications to the packaged app', () => {
    expect(isPermissionAllowed({permission: 'notifications', requestingUrl: APP})).toBe(true);
  });

  it('denies every other permission', () => {
    for(const permission of ['geolocation', 'midi', 'midiSysex', 'clipboard-read', 'hid', 'serial', 'usb', 'openExternal', 'pointerLock', 'unknown']) {
      expect(isPermissionAllowed({permission, requestingUrl: APP})).toBe(false);
    }
  });

  it('denies unexpected media types', () => {
    expect(isPermissionAllowed({permission: 'media', requestingUrl: APP, mediaTypes: ['audio', 'screen']})).toBe(false);
  });

  it('denies foreign origins, missing and malformed URLs', () => {
    for(const requestingUrl of ['https://evil.example/', 'app://localhost.evil/', 'file:///etc/passwd', 'not a url', undefined]) {
      expect(isPermissionAllowed({permission: 'media', requestingUrl, mediaTypes: ['audio']})).toBe(false);
      expect(isPermissionAllowed({permission: 'notifications', requestingUrl})).toBe(false);
    }
  });

  it('trusts the dev server origin only when running in dev', () => {
    const req = {permission: 'media', requestingUrl: DEV + '/', mediaTypes: ['audio']};
    expect(isPermissionAllowed(req, DEV)).toBe(true);
    expect(isPermissionAllowed(req)).toBe(false);
    expect(isTrustedAppUrl('http://localhost:9999/', DEV)).toBe(false);
  });
});

describe('isPermissionCheckAllowed (setPermissionCheckHandler path)', () => {
  // Electron 39 checks permissions BEFORE requesting them — without a check
  // handler the request handler above is not the boundary (review blocker on
  // #153). The check path differs in shape: a bare ORIGIN, one mediaType.
  const APP_ORIGIN = 'app://localhost';

  it('grants mic/camera/notification checks for the bare app origin', () => {
    expect(isPermissionCheckAllowed({permission: 'media', requestingOrigin: APP_ORIGIN, mediaType: 'audio'})).toBe(true);
    expect(isPermissionCheckAllowed({permission: 'media', requestingOrigin: APP_ORIGIN, mediaType: 'video'})).toBe(true);
    expect(isPermissionCheckAllowed({permission: 'notifications', requestingOrigin: APP_ORIGIN})).toBe(true);
  });

  it('grants a media probe with no mediaType (the types are gated at request time)', () => {
    expect(isPermissionCheckAllowed({permission: 'media', requestingOrigin: APP_ORIGIN})).toBe(true);
  });

  it('denies screen capture and every other permission on the check path', () => {
    expect(isPermissionCheckAllowed({permission: 'media', requestingOrigin: APP_ORIGIN, mediaType: 'screen'})).toBe(false);
    for(const permission of ['geolocation', 'clipboard-read', 'fullscreen', 'unknown']) {
      expect(isPermissionCheckAllowed({permission, requestingOrigin: APP_ORIGIN})).toBe(false);
    }
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
