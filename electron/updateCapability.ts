/*
 * PhantomChat desktop — what "update" can actually mean on this install.
 *
 * Auto-install is not a policy choice, it is a platform fact:
 *
 *  - Windows NSIS  — works unsigned; the installer relaunches in place.
 *  - Linux AppImage — works; electron-updater swaps the AppImage file.
 *  - Linux .deb    — apt/dpkg owns that file. An in-place overwrite would
 *                    desynchronise the package database, so we only notify.
 *  - macOS         — works, but only since the app became Developer ID
 *                    signed and notarized (#168) and the release started
 *                    carrying a zip + latest-mac.yml (#169). Squirrel.Mac
 *                    rejects an unsigned app outright. One exception stays
 *                    notify-only: an app still running from a read-only
 *                    image — the mounted DMG, or the App Translocation copy
 *                    Gatekeeper makes of it — which cannot be replaced in
 *                    place.
 *
 * Getting this wrong is worse than not shipping updates: an auto-update that
 * half-succeeds on a .deb leaves a machine whose package manager disagrees
 * with what is on disk.
 */
export type UpdateCapability =
  /** electron-updater can download and install this build. */
  | 'auto'
  /** We can detect a new version but the user must install it themselves. */
  | 'notify';

export interface CapabilityInput {
  platform: NodeJS.Platform;
  /** process.env — AppImage sets APPIMAGE to the mounted image path. */
  env: Record<string, string | undefined>;
  /** app.isPackaged; a dev run must never try to update itself. */
  isPackaged: boolean;
  /**
   * Absolute path the app is running from (app.getPath('exe')). macOS only
   * uses it, to spot an app launched straight out of its mounted DMG.
   */
  appPath?: string;
}

/**
 * True when a macOS app is executing from a read-only image rather than from
 * a real install. Squirrel.Mac cannot swap the bundle in that case — and even
 * if it could, the update would vanish with the eject. Detecting it turns a
 * confusing mid-update failure into a sentence telling the user to install
 * the app.
 *
 * TWO paths mean this, and missing either one defeats the guard:
 *
 *  - /Volumes/... — the app was launched straight out of the mounted DMG.
 *  - .../AppTranslocation/<uuid>/d/... — Gatekeeper App Translocation. A
 *    QUARANTINED app (which is every app a browser downloaded) run from
 *    outside /Applications is copied to a randomized read-only mount under
 *    /private/var/folders and executed from there, so the DMG case usually
 *    does NOT show a /Volumes path at all. This is the common shape, not the
 *    exotic one.
 */
export function isRunningFromReadOnlyImage(appPath: string | undefined): boolean {
  if(typeof appPath !== 'string') return false;
  return appPath.startsWith('/Volumes/') || appPath.includes('/AppTranslocation/');
}

export function resolveUpdateCapability({platform, env, isPackaged, appPath}: CapabilityInput): UpdateCapability {
  // An unpackaged run has no installer to replace and electron-updater
  // throws on it outright. Treat dev as notify-only so the UI still renders.
  if(!isPackaged) return 'notify';

  if(platform === 'win32') return 'auto';

  // macOS: signed, notarized and served a zip by latest-mac.yml, so
  // Squirrel.Mac can do its job — unless we are running off a read-only
  // image (mounted DMG, or its translocated copy).
  if(platform === 'darwin') return isRunningFromReadOnlyImage(appPath) ? 'notify' : 'auto';

  // The AppImage runtime exports APPIMAGE (absolute path of the image).
  // Its absence on linux means .deb, a distro package, or an unpacked dir —
  // none of which we may overwrite.
  if(platform === 'linux' && typeof env.APPIMAGE === 'string' && env.APPIMAGE.length > 0) {
    return 'auto';
  }

  return 'notify';
}

/**
 * Human-readable reason for the notify-only ceiling, shown in the settings
 * tab so the user is told WHY rather than left wondering why the toggle is
 * missing.
 */
export function describeNotifyReason({platform, env, isPackaged, appPath}: CapabilityInput): string {
  if(!isPackaged) return 'Development build — updates are not installed automatically.';
  if(platform === 'darwin' && isRunningFromReadOnlyImage(appPath)) {
    return 'PhantomChat is running from its disk image. Drag it to your Applications folder to get automatic updates.';
  }
  if(platform === 'linux' && !env.APPIMAGE) return 'This copy is managed by your package manager, so PhantomChat will not replace it. You will be told when a new version is available.';
  return 'This install cannot update itself automatically. You will be told when a new version is available.';
}
