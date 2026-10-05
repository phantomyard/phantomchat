/*
 * PhantomChat desktop — what "update" can actually mean on this install.
 *
 * Auto-install is not a policy choice, it is a platform fact:
 *
 *  - Windows NSIS  — works unsigned; the installer relaunches in place.
 *  - Linux AppImage — works; electron-updater swaps the AppImage file.
 *  - Linux .deb/.rpm — works since electron-updater 6.8 (DebUpdater /
 *    RpmUpdater): the new package is downloaded and installed THROUGH the
 *    package manager (dpkg / dnf / zypper), via pkexec for the root step.
 *    Requires a privilege-escalation agent on the desktop; without one we
 *    fall back to notify rather than promising an install that cannot
 *    prompt.
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
 * half-succeeds leaves a machine whose package manager disagrees with what
 * is on disk. The deb/rpm paths avoid that by construction — the install is
 * a real `dpkg -i` / `dnf install` — but they only work when the updater can
 * actually get root, hence the privilege-agent gate below.
 */
export type UpdateCapability =
  /** electron-updater can download and install this build. */
  | 'auto'
  /** We can detect a new version but the user must install it themselves. */
  | 'notify';

/** Package types electron-builder writes to resources/package-type. */
export type PackageType = 'deb' | 'rpm' | 'pacman';

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
  /**
   * Contents of resources/package-type on Linux packaged installs —
   * 'deb', 'rpm' or 'pacman'. electron-builder writes it when the publish
   * block exists, and electron-updater 6.6+ reads it to pick the platform
   * updater. Null when absent (AppImage, unpacked dir, dev run, or a
   * pre-6.6-era build).
   */
  packageType?: PackageType | null;
  /**
   * True when an installed update can actually get root on this desktop:
   * running as root, or one of electron-updater's graphical sudo agents
   * (pkexec/gksudo/kdesudo/beesu) is on PATH. Plain `sudo` does NOT count —
   * it needs a terminal, which a desktop app has no way to offer.
   */
  privilegeAgentPresent?: boolean;
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

function isPackageInstall(input: CapabilityInput): boolean {
  return input.packageType === 'deb' || input.packageType === 'rpm';
}

export function resolveUpdateCapability(input: CapabilityInput): UpdateCapability {
  const {platform, env, isPackaged, appPath} = input;
  // An unpackaged run has no installer to replace and electron-updater
  // throws on it outright. Treat dev as notify-only so the UI still renders.
  if(!isPackaged) return 'notify';

  if(platform === 'win32') return 'auto';

  // macOS: signed, notarized and served a zip by latest-mac.yml, so
  // Squirrel.Mac can do its job — unless we are running off a read-only
  // image (mounted DMG, or its translocated copy).
  if(platform === 'darwin') return isRunningFromReadOnlyImage(appPath) ? 'notify' : 'auto';

  // The AppImage runtime exports APPIMAGE (absolute path of the image).
  if(platform === 'linux' && typeof env.APPIMAGE === 'string' && env.APPIMAGE.length > 0) {
    return 'auto';
  }

  // Package-managed installs (.deb/.rpm). electron-updater installs through
  // the package manager — no in-place file overwrite, so the package
  // database stays consistent — but the root step needs a graphical
  // privilege agent to prompt. Without one, an 'auto' install would die
  // mid-flight with a cryptic sudo error, so notify and point at the
  // release page instead.
  if(platform === 'linux' && isPackageInstall(input)) {
    return input.privilegeAgentPresent ? 'auto' : 'notify';
  }

  // Anything else on Linux: an unpacked dir, a pacman install, or a build
  // without package-type metadata — none of which we may overwrite.
  return 'notify';
}

/**
 * Human-readable reason for the notify-only ceiling, shown in the settings
 * tab so the user is told WHY rather than left wondering why the toggle is
 * missing.
 */
export function describeNotifyReason(input: CapabilityInput): string {
  const {platform, env, isPackaged, appPath} = input;
  if(!isPackaged) return 'Development build — updates are not installed automatically.';
  if(platform === 'darwin' && isRunningFromReadOnlyImage(appPath)) {
    return 'PhantomChat is running from its disk image. Drag it to your Applications folder to get automatic updates.';
  }
  if(platform === 'linux' && isPackageInstall(input) && !input.privilegeAgentPresent) {
    return 'Installing updates needs your package-manager password, but no desktop authorization tool (pkexec) was found on this system. You will be told when a new version is available.';
  }
  if(platform === 'linux' && !env.APPIMAGE) return 'This copy is managed by your package manager, so PhantomChat will not replace it. You will be told when a new version is available.';
  return 'This install cannot update itself automatically. You will be told when a new version is available.';
}
