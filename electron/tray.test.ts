/*
 * The tray object itself. Two behaviours carry the weight: a tray with no
 * usable image must NOT exist (the close button would hide the app with
 * nothing to click), and the menu must offer both a way back and a real quit.
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {mkdtempSync, rmSync, writeFileSync, mkdirSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

const electronMock = vi.hoisted(() => ({
  trays: [] as any[],
  empty: false,
  lastTooltip: null as string | null
}));

vi.mock('electron', () => {
  class FakeTray {
    image: unknown;
    tooltip: string | null = null;
    menu: {template: any[]} | null = null;
    handlers: Record<string, () => void> = {};
    constructor(image: unknown) {
      this.image = image;
      electronMock.trays.push(this);
    }
    setToolTip(value: string) {
      this.tooltip = value;
      electronMock.lastTooltip = value;
    }
    setContextMenu(menu: {template: any[]}) {
      this.menu = menu;
    }
    on(name: string, handler: () => void) {
      this.handlers[name] = handler;
    }
  }
  return {
    Tray: FakeTray,
    Menu: {buildFromTemplate: (template: any[]) => ({template})},
    nativeImage: {
      createFromPath: (path: string) => ({
        path,
        isEmpty: () => electronMock.empty,
        resize: (options: unknown) => ({resizedFrom: path, options})
      })
    }
  };
});

import {createTray, resolveTrayIcon} from './tray';

beforeEach(() => {
  electronMock.trays = [];
  electronMock.empty = false;
});

describe('createTray', () => {
  it('resizes the image to the platform size and lets a click reopen the window', () => {
    const onShow = vi.fn();
    const tray = createTray('/res/icon.png', 'linux', {onShow, onQuit: vi.fn()});
    expect(tray).toBeDefined();
    expect((tray as any).image).toEqual({resizedFrom: '/res/icon.png', options: {width: 22, height: 22, quality: 'best'}});
    expect((tray as any).tooltip).toBe('PhantomChat');
    (tray as any).handlers.click();
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it('offers both a way back and a real quit in the menu', () => {
    const onShow = vi.fn();
    const onQuit = vi.fn();
    const tray = createTray('/res/icon.png', 'win32', {onShow, onQuit});
    const template = (tray as any).menu.template;
    const labels = template.filter((item: any) => item.label).map((item: any) => item.label);
    expect(labels).toEqual(['Open PhantomChat', 'Quit PhantomChat']);
    template.find((item: any) => item.label === 'Quit PhantomChat').click();
    expect(onQuit).toHaveBeenCalledTimes(1);
    expect(onShow).not.toHaveBeenCalled();
  });

  it('is not created at all when the image cannot be loaded', () => {
    electronMock.empty = true;
    expect(createTray('/res/missing.png', 'linux', {onShow: vi.fn(), onQuit: vi.fn()})).toBeUndefined();
    expect(electronMock.trays).toHaveLength(0);
  });
});

describe('resolveTrayIcon', () => {
  it('prefers the packaged resource and falls back to the build directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-tray-'));
    try {
      const resources = join(dir, 'res');
      const build = join(dir, 'build');
      mkdirSync(resources);
      mkdirSync(build);
      writeFileSync(join(build, 'icon.png'), 'png');
      expect(resolveTrayIcon({resourcesPath: resources, devBuildDir: build})).toBe(join(build, 'icon.png'));
      writeFileSync(join(resources, 'icon.png'), 'png');
      expect(resolveTrayIcon({resourcesPath: resources, devBuildDir: build})).toBe(join(resources, 'icon.png'));
      expect(resolveTrayIcon({resourcesPath: join(dir, 'nope'), devBuildDir: join(dir, 'nope')})).toBeUndefined();
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
});
