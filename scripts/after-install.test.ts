/*
 * Maintainer scripts (deb + rpm). The failure this guards against is real and
 * shipped: electron-builder's stock after-install probes `unshare --user` as
 * ROOT (maintainer scripts run under dpkg), where it always succeeds, so
 * chrome-sandbox was stripped of its setuid bit on every install and the app
 * aborted with "FATAL: SUID sandbox helper not configured correctly" on any
 * launch that lost the user-namespace race. We ship a corrected copy of the
 * stock template; this file pins BOTH the fix and the stock behaviour it must
 * keep (PATH link, AppArmor, MIME/desktop databases) so neither can silently
 * regress — the previous custom script deleted all of them at once.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const afterInstall = read('../electron/build/after-install.sh');
const builderYml = read('../electron-builder.yml');
const checkDeb = read('./check-deb-install.sh');

describe('after-install.sh', () => {
  it('installs chrome-sandbox setuid, unconditionally', () => {
    // Exactly one chmod of the sandbox helper, and it is 4755.
    const chmods = [...afterInstall.matchAll(/^\s*chmod\s+(\S+)\s+'?\/opt\/PhantomChat\/chrome-sandbox/gm)];
    expect(chmods.map((m) => m[1])).toEqual(['4755']);
  });

  it('never probes user namespaces to decide sandbox mode', () => {
    // The root-run `unshare --user` misdetection must not come back. Only
    // code counts — the header comment tells the story and names the probe.
    const code = afterInstall.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).not.toContain('unshare');
  });

  it('keeps the stock PATH integration', () => {
    expect(afterInstall).toContain(
      "update-alternatives --install '/usr/bin/phantomchat' 'phantomchat' '/opt/PhantomChat/phantomchat' 100"
    );
    expect(afterInstall).toContain("ln -sf '/opt/PhantomChat/phantomchat' '/usr/bin/phantomchat'");
  });

  it('keeps the stock AppArmor profile install and load', () => {
    expect(afterInstall).toContain("APPARMOR_PROFILE_SOURCE='/opt/PhantomChat/resources/apparmor-profile'");
    expect(afterInstall).toContain("APPARMOR_PROFILE_TARGET='/etc/apparmor.d/phantomchat'");
    expect(afterInstall).toContain('apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"');
  });

  it('keeps the stock desktop/MIME database refresh', () => {
    expect(afterInstall).toContain('update-mime-database /usr/share/mime');
    expect(afterInstall).toContain('update-desktop-database /usr/share/applications');
  });
});

describe('electron-builder.yml', () => {
  it('wires the corrected script into both deb and rpm', () => {
    expect(builderYml).toMatch(/(?<![\w-])afterInstall:\s*electron\/build\/after-install\.sh/);
    const debBlock = builderYml.slice(builderYml.indexOf('\ndeb:'), builderYml.indexOf('\nrpm:'));
    const rpmBlock = builderYml.slice(builderYml.indexOf('\nrpm:'), builderYml.indexOf('\nappImage:'));
    expect(debBlock).toContain('afterInstall: electron/build/after-install.sh');
    expect(rpmBlock).toContain('afterInstall: electron/build/after-install.sh');
  });

  it('does not override afterRemove (stock removal stays)', () => {
    expect(builderYml).not.toMatch(/(?<![\w-])afterRemove:/);
  });
});

describe('scripts/check-deb-install.sh', () => {
  it('asserts setuid 4755 and not the old 4755-or-755 escape hatch', () => {
    expect(checkDeb).toContain('[ "$mode" = 4755 ]');
    expect(checkDeb).not.toMatch(/4755\|755/);
  });
});
