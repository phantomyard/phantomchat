import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {load} from 'js-yaml';

// electron-builder's macOS signing config is exercised ONLY on a real release:
// builder-util's isPullRequest() keys off GITHUB_BASE_REF, so electron-builder
// skips macOS signing on every pull_request run. That means a wrong or missing
// file path in the signing config cannot fail PR CI — it fails at the codesign
// step of the first signed release, after the tag is already cut.
//
// These tests close that gap the cheap way: assert that every path
// electron-builder.yml points at actually exists in the tree.
const configPath = join(process.cwd(), 'electron-builder.yml');

type BuilderConfig = {
  mac?: {
    entitlements?: string;
    entitlementsInherit?: string;
    hardenedRuntime?: boolean;
    identity?: string;
    target?: {target?: string; arch?: string[]}[];
  };
};

describe('electron-builder.yml — referenced files exist', () => {
  let config: BuilderConfig;

  beforeAll(() => {
    config = load(readFileSync(configPath, 'utf8')) as BuilderConfig;
  });

  test.each(['entitlements', 'entitlementsInherit'] as const)(
    'mac.%s points at a file that exists',
    key => {
      const relativePath = config.mac?.[key];
      expect(relativePath, `mac.${key} is not set in electron-builder.yml`).toBeTruthy();
      const absolutePath = join(process.cwd(), relativePath as string);
      expect(
        existsSync(absolutePath),
        `electron-builder.yml mac.${key} references "${relativePath}", which does not exist. ` +
          'A signed release build would fail at the codesign step.',
      ).toBe(true);
    },
  );

  test('the entitlements file is a parseable plist carrying the entitlements the hardened runtime needs', () => {
    const relativePath = config.mac?.entitlements as string;
    const plist = readFileSync(join(process.cwd(), relativePath), 'utf8');

    // Not a full plist parse — just enough that an empty or truncated file, or
    // one that lost a load-bearing key, fails here rather than at runtime on a
    // user's Mac (Electron's V8 needs JIT; our helpers are not Apple-signed).
    expect(plist).toContain('<plist');
    expect(plist).toContain('</plist>');
    for (const entitlement of [
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-library-validation',
    ]) {
      expect(plist, `${relativePath} is missing ${entitlement}`).toContain(entitlement);
    }
  });

  test('hardenedRuntime stays enabled — notarization is refused without it', () => {
    expect(config.mac?.hardenedRuntime).toBe(true);
  });

  test('mac ships a zip target for both architectures — Squirrel.Mac installs the zip, not the DMG', () => {
    // MacUpdater resolves the update payload with findFile(files, 'zip', ...)
    // and throws ERR_UPDATER_ZIP_FILE_NOT_FOUND when latest-mac.yml lists only
    // a DMG. Dropping the zip target would leave the release looking complete
    // while every macOS auto-update fails on the user's machine (#169).
    const targets = config.mac?.target ?? [];
    const zip = targets.find(t => t.target === 'zip');
    expect(zip, 'electron-builder.yml mac.target has no zip entry').toBeTruthy();
    expect(zip?.arch?.slice().sort()).toEqual(['arm64', 'x64']);
    const dmg = targets.find(t => t.target === 'dmg');
    expect(dmg?.arch?.slice().sort()).toEqual(['arm64', 'x64']);
    // zip first: it becomes files[0] in latest-mac.yml, which is what the
    // legacy top-level path/sha512 fields describe.
    expect(targets[0]?.target).toBe('zip');
  });

  test('mac.identity omits the "Developer ID Application:" prefix', () => {
    // app-builder-lib's findIdentity -> checkPrefix throws
    // InvalidConfigurationError when the certificate-type prefix is included,
    // so the bare "Name (TEAMID)" form is required here.
    expect(config.mac?.identity).toBeTruthy();
    expect(config.mac?.identity).not.toMatch(/^Developer ID Application:/);
  });
});
