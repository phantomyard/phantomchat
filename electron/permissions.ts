/*
 * Chromium permission policy for the desktop app (issue #215).
 *
 * Policy: the app's own pages (the packaged app:// bundle, or the Vite dev
 * server in dev) get the local-app contract — a permission is either granted
 * outright or answered with a native prompt (Allow / Always allow / Deny).
 * Content from any other origin is denied outright, no prompt, no dialog.
 *
 *  - Promptless (granted without asking): clipboard read and sanitized
 *    write. These fire from keyboard shortcuts (Ctrl+C/Ctrl+V) which cannot
 *    wait on a dialog. Both can still be disabled in Settings →
 *    Privacy & Security → Permissions.
 *  - Everything else prompts per request; "Always allow" is remembered.
 *  - The settings tab sets explicit overrides ('allow' | 'deny') that win
 *    over both the promptless defaults and remembered grants.
 *
 * The decision logic here is pure and unit-tested; main.ts owns the dialog,
 * persistence and the Electron handler wiring.
 */
export const APP_ORIGIN = 'app://localhost';

export type PermissionSetting = 'ask' | 'allow' | 'deny';

/** What the request handler should do with a permission request. */
export type PermissionDecision = 'allow' | 'deny' | 'prompt';

export interface PermissionSettings {
  /** Explicit overrides from the Permissions settings tab. */
  overrides: Record<string, PermissionSetting>;
  /** Permissions the user answered "Always allow" to in a prompt. */
  granted: string[];
}

export function defaultPermissionSettings(): PermissionSettings {
  return {overrides: {}, granted: []};
}

/** Keyboard-shortcut flows that cannot wait on a dialog. */
export const PROMPTLESS_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write']);

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

/**
 * The one decision the request handler makes: allow, deny, or prompt the
 * user. Overrides (settings tab) win, then remembered "Always allow"
 * grants, then the promptless defaults; anything else prompts.
 */
export function resolvePermissionRequest(
  req: PermissionRequest,
  settings: PermissionSettings,
  devUrl?: string
): PermissionDecision {
  if(!isTrustedAppUrl(req.requestingUrl, devUrl)) return 'deny';

  const override = settings.overrides[req.permission];
  if(override === 'allow') return 'allow';
  if(override === 'deny') return 'deny';

  if(settings.granted.includes(req.permission)) return 'allow';
  if(PROMPTLESS_PERMISSIONS.has(req.permission)) return 'allow';

  return 'prompt';
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
 * Synchronous check-side of the policy.
 *
 * Electron 39 requires setPermissionCheckHandler for complete permission
 * handling, and — crucially — the CHECK result is what permission QUERIES
 * (navigator.permissions.query) report as granted/denied; the request
 * handler only fires from actual API use. So the check must mirror the
 * request handler's policy exactly: it answers "granted" (true) only when
 * the effective decision for this permission is 'allow' — an explicit
 * allow override, a remembered "Always allow" grant, or one of the
 * promptless clipboard defaults. A 'prompt' state and an explicit deny
 * both answer false, otherwise a request handler that would deny or
 * prompt is silently bypassed and query reports granted (review blocker
 * on #216). Non-app origins are denied here outright.
 */
export function isPermissionCheckAllowed(
  req: PermissionCheck,
  settings: PermissionSettings,
  devUrl?: string
): boolean {
  if(!isTrustedAppUrl(req.requestingUrl, devUrl)
    && !isTrustedAppUrl(req.requestingOrigin, devUrl)) {
    return false;
  }
  const override = settings.overrides[req.permission];
  if(override === 'allow') return true;
  if(override === 'deny') return false;
  if(settings.granted.includes(req.permission)) return true;
  return PROMPTLESS_PERMISSIONS.has(req.permission);
}

// ─── Persistence ─────────────────────────────────────────────
// Stored as a small JSON file in userData, same contract as the update-ring
// file: a hand-edited, truncated or half-written file degrades to defaults
// rather than throwing during boot.

export const PERMISSION_SETTINGS_FILE = 'permissions.json';

export function isPermissionSetting(value: unknown): value is PermissionSetting {
  return value === 'ask' || value === 'allow' || value === 'deny';
}

/** Defensive parse: anything unreadable becomes the default policy. */
export function parsePermissionSettings(raw: unknown): PermissionSettings {
  const settings = defaultPermissionSettings();
  if(!raw || typeof raw !== 'object') return settings;
  const obj = raw as Record<string, unknown>;

  if(obj.overrides && typeof obj.overrides === 'object') {
    for(const [permission, value] of Object.entries(obj.overrides as Record<string, unknown>)) {
      if(isPermissionSetting(value) && value !== 'ask') settings.overrides[permission] = value;
    }
  }
  if(Array.isArray(obj.granted)) {
    for(const permission of obj.granted) {
      if(typeof permission === 'string' && /^[a-zA-Z-]+$/.test(permission)
        && !settings.overrides[permission]) {
        settings.granted.push(permission);
      }
    }
  }
  return settings;
}

/**
 * Record an "Always allow" answer from a prompt. An explicit deny/ask
 * override in the settings tab wins — the user must clear that there; we
 * never resurrect a permission they deliberately turned off.
 */
export function grantAlways(settings: PermissionSettings, permission: string): PermissionSettings {
  if(settings.overrides[permission]) return settings;
  if(!settings.granted.includes(permission)) settings.granted.push(permission);
  return settings;
}
