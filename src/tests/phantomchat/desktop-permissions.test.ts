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
import {PROMPTLESS_PERMISSIONS} from '../../../electron/permissions';

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

/*
 * Freeze regression (#219): the 1.0.304 App Permissions tab froze the app the
 * moment it opened and clobbered permissions.json. `CheckboxField.checked = x`
 * does not just set state — it fires a synthetic 'change' event — so a
 * refresh() that reflects saved state through the checked setter re-enters
 * each row's own change listener -> onToggled -> save -> refresh() and never
 * converges. Reflecting state must go through setValueSilently().
 */
describe('App Permissions tab — freeze regression (#219)', () => {
  const tabSrc = readFileSync(resolve(__dirname, '../../components/sidebarLeft/tabs/phantomchatDesktopPermissions.ts'), 'utf8');
  const checkboxSrc = readFileSync(resolve(__dirname, '../../components/checkboxField.ts'), 'utf8');

  it('precondition: CheckboxField.checked setter fires a synthetic change event', () => {
    // This is what made the old refresh() loop; keep the tab honest about it.
    expect(checkboxSrc).toMatch(/set checked\(checked: boolean\)[\s\S]{0,200}simulateEvent\(this\.input, 'change'\)/);
  });

  it('(bug repro) refresh() must never assign checkbox.checked — that re-fires the row listeners', () => {
    expect(tabSrc).not.toMatch(/^\s*checkbox\.checked\s*=[^=]/m);
  });

  it('(fix) refresh() reflects saved state silently', () => {
    expect(tabSrc).toMatch(/checkbox\.setValueSilently\(/);
  });
});

/*
 * Owner decision (2026-10-13): only permissions that can show a user prompt
 * get a toggle. The promptless clipboard pair (Ctrl+C/V cannot wait on a
 * dialog) is always allowed with NO toggle — and nothing else may be
 * silently allowed: every listed row is ON = "asks the first time it's
 * needed", OFF = blocked.
 */
describe('App Permissions tab — promptable-only toggles (#219)', () => {
  const tabSrc = readFileSync(resolve(__dirname, '../../components/sidebarLeft/tabs/phantomchatDesktopPermissions.ts'), 'utf8');

  it('lists exactly the 12 promptable permissions', () => {
    const permissions = [...tabSrc.matchAll(/permission: '([^']+)'/g)].map((m) => m[1]);
    expect(new Set(permissions)).toEqual(new Set([
      'media', 'notifications', 'display-capture', 'geolocation', 'fileSystem',
      'midi', 'hid', 'serial', 'usb', 'window-management', 'local-fonts', 'sensors'
    ]));
  });

  it('never lists a promptless permission — those get no toggle', () => {
    const permissions = [...tabSrc.matchAll(/permission: '([^']+)'/g)].map((m) => m[1]);
    for(const permission of permissions) {
      expect(PROMPTLESS_PERMISSIONS.has(permission)).toBe(false);
    }
    expect(permissions).not.toContain('clipboard-read');
    expect(permissions).not.toContain('clipboard-sanitized-write');
  });

  it('ON returns to prompting on first use, OFF blocks — no silent allows', () => {
    expect(tabSrc).toMatch(/checked \? 'ask' : 'deny'/);
  });
});
