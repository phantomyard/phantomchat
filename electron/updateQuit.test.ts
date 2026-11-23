/*
 * macOS update restart must quit, not hide to the tray.
 *
 * Squirrel.Mac's quitAndInstall closes every window before the app's
 * 'before-quit' fires. With close-to-tray on (the default), the close handler
 * used to see "not quitting", cancel the close and hide the window — so the
 * update restart waited forever with the app still running. Electron emits
 * 'before-quit-for-update' before closing the windows; that must flip the
 * app into quitting so the close goes through.
 */
import {describe, it, expect} from 'vitest';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {quitForRealOnUpdateRestart} from './updateRestart';
import {closeHidesWindow, DEFAULT_PRESENCE, type PresenceCapability} from './presence';

const withTray: PresenceCapability = {tray: true, autostart: true, trayReason: 'ok', autostartReason: 'ok'};

describe('update restart vs close-to-tray', () => {
  it('a plain window close still hides to the tray', () => {
    expect(closeHidesWindow(false, DEFAULT_PRESENCE, withTray)).toBe(true);
  });

  it('a real quit closes the window', () => {
    expect(closeHidesWindow(true, DEFAULT_PRESENCE, withTray)).toBe(false);
  });

  it('no tray: close always closes', () => {
    expect(closeHidesWindow(false, DEFAULT_PRESENCE, {...withTray, tray: false})).toBe(false);
  });

  it('before-quit-for-update makes the next window close a real close', () => {
    const nativeUpdater = new EventEmitter();
    let quitting = false;
    quitForRealOnUpdateRestart(nativeUpdater, () => {
      quitting = true;
    });
    // Before the restart starts, closing still hides (tray behaviour kept).
    expect(closeHidesWindow(quitting, DEFAULT_PRESENCE, withTray)).toBe(true);
    // Squirrel.Mac: emitted just before Electron closes all windows.
    nativeUpdater.emit('before-quit-for-update');
    expect(closeHidesWindow(quitting, DEFAULT_PRESENCE, withTray)).toBe(false);
  });

  it('main.ts wires the native updater and routes the close handler through closeHidesWindow', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    expect(main).toMatch(/quitForRealOnUpdateRestart\(nativeAutoUpdater,\s*\(\)\s*=>\s*\{\s*quitting = true;/);
    expect(main).toMatch(/autoUpdater as nativeAutoUpdater[^;]*from 'electron'/);
    expect(main).toContain("if(!closeHidesWindow(quitting, presenceSettings, presenceCapability)) return;");
    // The wiring must not be Linux-only by accident: macOS is the platform that needs it.
    expect(main).toContain("if(process.platform !== 'linux') {");
  });
});
