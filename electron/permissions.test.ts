/*
 * Desktop permission policy: mic, camera and notifications for the app's own
 * pages only; everything else stays denied.
 */
import {describe, it, expect} from 'vitest';
import {isPermissionAllowed, isTrustedAppUrl} from './permissions';

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
