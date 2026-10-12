/*
 * Desktop permission settings — renderer side (issue #215).
 *
 * The policy decisions live in electron/permissions.test.ts. What is tested
 * here is the bridge detection (the row must not appear where it cannot
 * work) and the settings wiring (the row is gated on the permission API and
 * the tab stays behind a dynamic import so the PWA never bundles it).
 */
import {describe, it, expect, afterEach} from 'vitest';
import {readFileSync} from 'fs';
import {resolve} from 'path';
import {isDesktopApp, hasDesktopPermissionApi} from '../../lib/phantomchat/desktop-api';

afterEach(() => {
  delete (window as any).phantomchatDesktop;
});

describe('permission bridge detection', () => {
  it('reports no permission API on the web', () => {
    expect(isDesktopApp()).toBe(false);
    expect(hasDesktopPermissionApi()).toBe(false);
  });

  it('reports the permission API when the preload exposes both methods', () => {
    (window as any).phantomchatDesktop = {
      getPermissionSettings: () => {},
      setPermissionSetting: () => {}
    };
    expect(hasDesktopPermissionApi()).toBe(true);
  });

  it('does NOT claim the permission API on a desktop build packaged before #215', () => {
    // The bridge exists (getVersion/openExternal) but the permission methods
    // do not. Showing the App Permissions row there would open a tab that
    // can only throw, so the row must stay hidden.
    (window as any).phantomchatDesktop = {getVersion: () => {}, openExternal: () => {}};
    expect(isDesktopApp()).toBe(true);
    expect(hasDesktopPermissionApi()).toBe(false);
  });
});

describe('settings wiring', () => {
  const privacySrc = readFileSync(resolve(__dirname, '../../components/sidebarLeft/tabs/privacyAndSecurity.ts'), 'utf8');

  it('gates the App Permissions row on the desktop permission API', () => {
    expect(privacySrc).toContain('hasDesktopPermissionApi()');
  });

  it('loads the permissions tab behind a dynamic import so the PWA never bundles it', () => {
    expect(privacySrc).toContain("await import('@components/sidebarLeft/tabs/phantomchatDesktopPermissions')");
  });
});
