/*
 * PhantomChat desktop — what "update" can actually mean on this install.
 *
 * Auto-install is not a policy choice, it is a platform fact:
 *
 *  - Windows NSIS  — works unsigned; the installer relaunches in place.
 *  - Linux AppImage — works; electron-updater swaps the AppImage file.
 *  - Linux .deb    — apt/dpkg owns that file. An in-place overwrite would
 *                    desynchronise the package database, so we only notify.
 *  - macOS         — Squirrel.Mac REQUIRES a signed, notarised app. Our
 *                    builds set mac.identity=null, so an auto-update attempt
 *                    fails with a code-signature error. Notify only, until
 *                    the Axelera Developer ID lands.
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
}

export function resolveUpdateCapability({platform, env, isPackaged}: CapabilityInput): UpdateCapability {
  // An unpackaged run has no installer to replace and electron-updater
  // throws on it outright. Treat dev as notify-only so the UI still renders.
  if(!isPackaged) return 'notify';

  if(platform === 'win32') return 'auto';

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
export function describeNotifyReason({platform, env, isPackaged}: CapabilityInput): string {
  if(!isPackaged) return 'Development build — updates are not installed automatically.';
  if(platform === 'darwin') return 'Automatic installation on macOS needs a signed app. PhantomChat will tell you when a new version is available.';
  if(platform === 'linux' && !env.APPIMAGE) return 'This copy is managed by your package manager, so PhantomChat will not replace it. You will be told when a new version is available.';
  return 'This install cannot update itself automatically. You will be told when a new version is available.';
}
