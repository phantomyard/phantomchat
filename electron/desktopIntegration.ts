/*
 * PhantomChat desktop — AppImage desktop integration.
 *
 * An AppImage runs portably, but the issue requires an explicit integration
 * path: `phantomchat --install` writes the icon and a .desktop launcher into
 * the user's local application directory so the app appears in the menu of
 * common desktop environments (GNOME, KDE, Hyprland's launcher, etc.).
 * `phantomchat --uninstall` removes them again. The .deb needs none of this —
 * electron-builder ships the desktop file inside the package.
 */
import {copyFileSync, mkdirSync, rmSync, existsSync, writeFileSync} from 'fs';
import {join, dirname} from 'path';
import {execFileSync} from 'child_process';
import {homedir} from 'os';

const APP_ID = 'phantomchat';
const APP_NAME = 'PhantomChat';
const APP_COMMENT = 'Privacy-first messaging with end-to-end encryption';
const GENERIC_NAME = 'Internet Messenger';
const CATEGORIES = 'Network;InstantMessaging;';

function appImage(): string | undefined {
  // electron-builder sets APPIMAGE for AppImage runs; the packaged arg0 is
  // the fallback.
  return process.env.APPIMAGE || process.argv[0] || undefined;
}

/**
 * Escape a path for the desktop entry's Exec key per the Desktop Entry
 * Specification: the argument is wrapped in double quotes, the characters
 * with special meaning inside Exec quotes (backslash, double quote,
 * backtick, dollar) are backslash-escaped, and a literal % is doubled so it
 * is never parsed as a field code.
 */
export function execTokenForDesktopEntry(execPath: string): string {
  const escaped = execPath
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/%/g, '%%');
  return `"${escaped}"`;
}

function desktopEntry(execPath: string): string {
  return [
    '[Desktop Entry]',
    'Version=1.0',
    `Name=${APP_NAME}`,
    `Comment=${APP_COMMENT}`,
    `GenericName=${GENERIC_NAME}`,
    `Exec=${execTokenForDesktopEntry(execPath)}`,
    'Terminal=false',
    'Type=Application',
    `Categories=${CATEGORIES}`,
    `Icon=${APP_ID}`,
    'StartupWMClass=PhantomChat',
    'MimeType=x-scheme-handler/phantomchat;'
  ].join('\n');
}

function refreshDesktopDatabase(): void {
  // Best effort — menu environments that need it re-scan on their own.
  try {
    execFileSync('update-desktop-database', [join(homedir(), '.local/share/applications')], {stdio: 'ignore'});
  } catch {
    // update-desktop-database not installed: harmless.
  }
}

/**
 * Locate the packaged 512px icon. Under a plain AppImage mount,
 * process.resourcesPath points into the squashfs; under
 * --appimage-extract-and-run it can be wrong, so fall back to the AppDir
 * locations AppRun provides.
 */
function findPackagedIcon(): string | undefined {
  const candidates = [
    join(process.resourcesPath || '', 'icon.png'),
    join(process.env.APPDIR || '', 'resources', 'icon.png'),
    join(process.env.APPDIR || '', 'phantomchat.png')
  ].filter((p) => p && existsSync(p));
  return candidates[0];
}

export function installDesktopEntry(): number {
  const image = appImage();
  if(!image || !existsSync(image)) {
    console.error('--install is only supported when running from an AppImage.');
    return 1;
  }

  const iconSource = findPackagedIcon();
  const iconDest = join(homedir(), '.local/share/icons/hicolor/512x512/apps', `${APP_ID}.png`);
  const desktopDest = join(homedir(), '.local/share/applications', `${APP_ID}.desktop`);

  try {
    if(!iconSource) {
      throw new Error('packaged icon not found (looked in resourcesPath and $APPDIR)');
    }
    mkdirSync(dirname(iconDest), {recursive: true});
    mkdirSync(dirname(desktopDest), {recursive: true});
    copyFileSync(iconSource, iconDest);
    writeFileSync(desktopDest, desktopEntry(image) + '\n', {mode: 0o644});
  } catch(err) {
    console.error('desktop integration failed:', err instanceof Error ? err.message : err);
    return 1;
  }

  refreshDesktopDatabase();
  console.log(`PhantomChat installed: ${desktopDest}`);
  return 0;
}

export function uninstallDesktopEntry(): number {
  const iconDest = join(homedir(), '.local/share/icons/hicolor/512x512/apps', `${APP_ID}.png`);
  const desktopDest = join(homedir(), '.local/share/applications', `${APP_ID}.desktop`);

  let removed = false;
  for(const file of [desktopDest, iconDest]) {
    if(existsSync(file)) {
      rmSync(file);
      removed = true;
    }
  }

  if(removed) refreshDesktopDatabase();
  console.log(removed ? 'PhantomChat desktop integration removed.' : 'PhantomChat was not installed.');
  return 0;
}

// Exposed for tests/docs: where the files land.
export function integrationPaths() {
  return {
    desktop: join(homedir(), '.local/share/applications', `${APP_ID}.desktop`),
    icon: join(homedir(), '.local/share/icons/hicolor/512x512/apps', `${APP_ID}.png`)
  };
}
