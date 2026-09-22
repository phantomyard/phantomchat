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
  // setPermissionCheckHandler hands us the ORIGIN, not a full URL — for the
  // non-special app:// scheme that is exactly "app://localhost" (no path),
  // and Chromium may also report the string "null". Accept the bare origin
  // as well as any page under it.
  if(url === APP_ORIGIN || url.startsWith(APP_ORIGIN + '/')) return true;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch{
    return false;
  }
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

/** Shape of Electron's setPermissionCheckHandler callback arguments. */
export type PermissionCheck = {
  permission: string;
  // Origin of the frame asking (requestingOrigin in the check handler — for
  // app:// that is the bare "app://localhost", not a page URL).
  requestingOrigin?: string;
  // Full URL of the frame asking when available (details.requestingUrl).
  requestingUrl?: string;
  // For 'media': the single media type being checked (details.mediaType —
  // the check handler gets ONE device type, not the request handler's list).
  mediaType?: string;
};

/**
 * Synchronous check-side twin of {@link isPermissionAllowed}.
 *
 * Electron 39 requires setPermissionCheckHandler for complete permission
 * handling: most APIs CHECK first and only REQUEST after a check denies, so
 * without this handler the request handler above is not the documented
 * default-deny boundary (review blocker on #153). Same policy: mic, camera
 * and notifications for the app's own origin only; when both a page URL and
 * an origin are supplied either may vouch for the frame.
 */
export function isPermissionCheckAllowed(req: PermissionCheck, devUrl?: string): boolean {
  if(!ALLOWED_PERMISSIONS.has(req.permission)) return false;
  const trusted = isTrustedAppUrl(req.requestingUrl, devUrl)
    || isTrustedAppUrl(req.requestingOrigin, devUrl);
  if(!trusted) return false;
  if(req.permission === 'media') {
    // No mediaType = a general "is media allowed here" probe — defer to the
    // device types the request handler will see. Otherwise the single type
    // must be one we allow ('screen' and friends are denied here).
    return req.mediaType === undefined || ALLOWED_MEDIA_TYPES.has(req.mediaType);
  }
  return true;
}
