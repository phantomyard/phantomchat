/*
 * Chromium permission policy for the desktop app.
 *
 * Default-deny: only the capabilities chat needs are granted, and only to the
 * app's own pages (the packaged app:// bundle, or the Vite dev server in dev).
 *  - media: microphone + camera (voice messages, voice/video calls)
 *  - notifications: new-message notifications
 * Everything else (geolocation, MIDI, HID/serial/USB, clipboard-read, ...)
 * stays denied. Kept in its own module so tests can assert on it without
 * booting Electron.
 */
export const APP_ORIGIN = 'app://localhost';

const ALLOWED_PERMISSIONS = new Set(['media', 'notifications']);
const ALLOWED_MEDIA_TYPES = new Set(['audio', 'video']);

export type PermissionRequest = {
  permission: string;
  // The URL of the frame asking (details.requestingUrl in Electron).
  requestingUrl?: string;
  // For 'media': which devices are requested (details.mediaTypes).
  mediaTypes?: string[];
};

export function isTrustedAppUrl(url: string | undefined, devUrl?: string): boolean {
  if(!url) return false;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch{
    return false;
  }
  // Non-special schemes report origin "null" in WHATWG URL — compare by prefix.
  if(url.startsWith(APP_ORIGIN + '/')) return true;
  if(devUrl) {
    try {
      return origin !== 'null' && origin === new URL(devUrl).origin;
    } catch{
      return false;
    }
  }
  return false;
}

export function isPermissionAllowed(req: PermissionRequest, devUrl?: string): boolean {
  if(!ALLOWED_PERMISSIONS.has(req.permission)) return false;
  if(!isTrustedAppUrl(req.requestingUrl, devUrl)) return false;
  if(req.permission === 'media') {
    const types = req.mediaTypes ?? [];
    // An empty list means "enumerate/any" — fine, the devices are still gated
    // to audio/video by Chromium. Anything else (e.g. screen capture) is denied.
    return types.every((t) => ALLOWED_MEDIA_TYPES.has(t));
  }
  return true;
}
