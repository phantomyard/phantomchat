import {describe, expect, it} from 'vitest';
import {chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';

const WORKFLOW = readFileSync(join(process.cwd(), '.github', 'workflows', 'app-release.yml'), 'utf8');
const NOTARIZE = readFileSync(join(process.cwd(), 'scripts', 'notarize-macos-artifacts.sh'), 'utf8');

describe('macOS release retry boundary', () => {
  it('preserves signed packages before the notarization job', () => {
    expect(WORKFLOW).toContain('macos-package:');
    expect(WORKFLOW).toContain('name: signed-macos-${{ matrix.arch }}');
    expect(WORKFLOW).toContain('macos-notarize:');
    expect(WORKFLOW).toContain('needs: [linux, macos-package]');
    expect(WORKFLOW).toContain('name: signed-macos-${{ matrix.arch }}');
    expect(WORKFLOW).toContain('needs: [linux, macos-notarize, windows]');
  });

  it('retries ticket operations without resubmitting an accepted artifact', () => {
    expect(NOTARIZE).toMatch(/notarytool submit/);
    expect(NOTARIZE).toMatch(/submission_id=.*\.id/);
    expect(NOTARIZE).toMatch(/retry xcrun notarytool wait "\$submission_id"/);
    expect(NOTARIZE).toMatch(/retry xcrun stapler staple "\$DMG"/);
    expect(NOTARIZE).toMatch(/response="\$\(retry xcrun notarytool submit/);
  });

  it('skips desktop releases for non-payload-only changes', () => {
    for(const ignored of ['.github/**', 'src/tests/**', 'scripts/**']) {
      expect(WORKFLOW).toContain(`- '${ignored}'`);
    }
  });

  it('retries transient Apple operations and produces a re-zipped app', () => {
    const root = mkdtempSync(join(tmpdir(), 'phantomchat-notary-test-'));
    const bin = join(root, 'bin');
    const state = join(root, 'state');
    mkdirSync(bin);
    mkdirSync(state);

    const fake = (name: string, source: string) => {
      const path = join(bin, name);
      writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${source}\n`);
      chmodSync(path, 0o755);
    };
    fake('uname', 'echo Darwin');
    fake('sleep', ':');
    fake('ditto', [
      'if [[ "$1" == "-x" ]]; then',
      '  for dest; do :; done',
      '  mkdir -p "$dest/PhantomChat.app"',
      'else',
      '  for dest; do :; done',
      '  printf zip > "$dest"',
      'fi'
    ].join('\n'));
    fake('xcrun', String.raw`
operation="$1-$2"
counter="$TEST_STATE/$operation"
count=0
[[ -f "$counter" ]] && count="$(cat "$counter")"
count=$((count + 1))
printf '%s' "$count" > "$counter"
if [[ "$operation" == "notarytool-submit" ]]; then
  printf '{"id":"submission-%s"}\n' "$count"
elif [[ "$operation" == "notarytool-wait" && "$count" -lt 3 ]]; then
  exit 68
elif [[ "$operation" == "stapler-staple" && "$count" -eq 1 ]]; then
  exit 68
fi`);

    const dmg = join(root, 'PhantomChat.dmg');
    const zip = join(root, 'PhantomChat.zip');
    writeFileSync(dmg, 'signed dmg');
    writeFileSync(zip, 'signed zip');
    execFileSync('bash', [join(process.cwd(), 'scripts', 'notarize-macos-artifacts.sh'), dmg, zip], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_STATE: state,
        APPLE_ID: 'test@example.invalid',
        APPLE_APP_SPECIFIC_PASSWORD: 'test-password',
        APPLE_TEAM_ID: 'TESTTEAM',
        RETRY_MAX_ATTEMPTS: '4',
        RETRY_INITIAL_DELAY_SECONDS: '0'
      },
      stdio: 'pipe'
    });

    expect(readFileSync(join(state, 'notarytool-submit'), 'utf8')).toBe('1');
    expect(readFileSync(join(state, 'notarytool-wait'), 'utf8')).toBe('3');
    expect(Number(readFileSync(join(state, 'stapler-staple'), 'utf8'))).toBeGreaterThan(1);
    expect(readFileSync(zip, 'utf8')).toBe('zip');
  });
});
