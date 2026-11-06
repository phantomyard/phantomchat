/*
 * PhantomChat desktop — the tray icon itself.
 *
 * Thin on purpose: everything that can be decided without Electron (which
 * icon path, what size, when the app should stay hidden) lives in presence.ts
 * and is unit-tested there. This module only wires a Tray, its image and its
 * menu, so the "no tray" path in main is a missing object, not a special case
 * sprinkled through the boot sequence.
 */
import {Menu, Tray, nativeImage} from 'electron';
import {existsSync} from 'fs';
import {trayIconCandidates, trayIconSize} from './presence';

export interface TrayHandlers {
  /** Show (and focus) the main window. */
  onShow: () => void;
  /** Quit for real — this is the only way out when the window is hidden. */
  onQuit: () => void;
}

/** First candidate that exists on disk, or undefined. */
export function resolveTrayIcon(opts: {resourcesPath: string; devBuildDir: string}): string | undefined {
  return trayIconCandidates(opts).find((path) => existsSync(path));
}

/**
 * Build the tray. Returns undefined when the image cannot be loaded: a tray
 * with an empty icon is worse than no tray, since the window's close button
 * would then hide the app with nothing to click.
 */
export function createTray(iconPath: string, platform: NodeJS.Platform, handlers: TrayHandlers): Tray | undefined {
  const source = nativeImage.createFromPath(iconPath);
  if(source.isEmpty()) return undefined;
  const size = trayIconSize(platform);
  const tray = new Tray(source.resize({width: size, height: size, quality: 'best'}));
  tray.setToolTip('PhantomChat');
  tray.setContextMenu(Menu.buildFromTemplate([
    {label: 'Open PhantomChat', click: () => handlers.onShow()},
    {type: 'separator'},
    {label: 'Quit PhantomChat', click: () => handlers.onQuit()}
  ]));
  // Left click opens the window on Windows and Linux. macOS opens the menu
  // instead (the platform's own convention), so the handler is harmless there.
  tray.on('click', () => handlers.onShow());
  return tray;
}
