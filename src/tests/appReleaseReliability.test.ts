import {describe, expect, it} from 'vitest';
import {chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {load} from 'js-yaml';

const WORKFLOW = readFileSync(join(process.cwd(), '.github', 'workflows', 'app-release.yml'), 'utf8');
const NOTARIZE = readFileSync(join(process.cwd(), 'scripts', 'notarize-macos-artifacts.sh'), 'utf8');
const CHECK_PACKAGE = readFileSync(join(process.cwd(), 'scripts', 'check-macos-package.sh'), 'utf8');
const CHECK_UPDATE_ZIP = readFileSync(join(process.cwd(), 'scripts', 'check-macos-update-zip.sh'), 'utf8');

type Workflow = {
  jobs: {
    'macos-notarize': {
      steps: Array<{name?: string; run?: string}>;
    };
  };
};

type Sandbox = {
  bin: string;
  state: string;
  dmg: string;
  zip: string;
};

const setupSandbox = (xcrunSource: string): Sandbox => {
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
  fake('xcrun', xcrunSource);

  const dmg = join(root, 'PhantomChat.dmg');
  const zip = join(root, 'PhantomChat.zip');
  writeFileSync(dmg, 'signed dmg');
  writeFileSync(zip, 'signed zip');
  return {bin, state, dmg, zip};
};

const runNotarize = (sandbox: Sandbox) => {
  execFileSync('bash', [join(process.cwd(), 'scripts', 'notarize-macos-artifacts.sh'), sandbox.dmg, sandbox.zip], {
    env: {
      ...process.env,
      PATH: `${sandbox.bin}:${process.env.PATH}`,
      TEST_STATE: sandbox.state,
      APPLE_ID: 'test@example.invalid',
      APPLE_APP_SPECIFIC_PASSWORD: 'test-password',
      APPLE_TEAM_ID: 'TESTTEAM',
      RETRY_MAX_ATTEMPTS: '4',
      RETRY_INITIAL_DELAY_SECONDS: '0'
    },
    stdio: 'pipe'
  });
};

describe('macOS release retry boundary', () => {
  it('preserves signed packages before the notarization job', () => {
    expect(WORKFLOW).toContain('macos-package:');
    expect(WORKFLOW).toContain('macos-notarize:');
    expect(WORKFLOW).toContain('needs: [linux, macos-package]');
    expect(WORKFLOW).toContain('needs: [linux, macos-notarize, windows]');
    // Upload in macos-package and download in macos-notarize: both sides of
    // the signed-artifact handoff must keep the same artifact name.
    expect(WORKFLOW.match(/name: signed-macos-\$\{\{ matrix\.arch \}\}/g)?.length).toBe(2);
  });

  it('passes artifact paths without YAML-folded leading spaces', () => {
    const workflow = load(WORKFLOW) as Workflow;
    const command = workflow.jobs['macos-notarize'].steps.find(
      ({name}) => name === 'Notarize, staple, and re-zip the stapled app'
    )?.run;

    expect(command).toBe(
      'scripts/notarize-macos-artifacts.sh \\\n' +
      '"release/${VERSION}/PhantomChat-${VERSION}-${ARCH}.dmg" \\\n' +
      '"release/${VERSION}/PhantomChat-${VERSION}-${ARCH}.zip"\n'
    );
  });

  it('retries ticket operations without resubmitting an accepted artifact', () => {
    expect(NOTARIZE).toMatch(/notarytool submit/);
    expect(NOTARIZE).toMatch(/submission_id=.*\.id/);
    expect(NOTARIZE).toMatch(/retry xcrun notarytool wait "\$submission_id"/);
    expect(NOTARIZE).toMatch(/retry xcrun stapler staple "\$DMG"/);
    // Submission is single-shot: wrapping it in retry would resubmit accepted
    // bytes and merge every attempt's stdout into one poisoned capture.
    expect(NOTARIZE).not.toMatch(/retry xcrun notarytool submit/);
    expect(NOTARIZE).toMatch(/response="\$\(xcrun notarytool submit/);
  });

  it('keeps post-staple verification local and blocking', () => {
    for(const script of [NOTARIZE, CHECK_PACKAGE, CHECK_UPDATE_ZIP]) {
      expect(script).not.toMatch(/stapler validate/);
    }
    for(const script of [CHECK_PACKAGE, CHECK_UPDATE_ZIP]) {
      expect(script).toMatch(/codesign --verify --deep --strict[\s\S]*?\|\| \{[\s\S]*?exit 1; \}/);
      expect(script).toMatch(/Authority=Developer ID Application: Andrew Hodges \(644GWVQQ4P\)/);
      expect(script).toMatch(/spctl --assess --type execute[\s\S]*?\|\| \{[\s\S]*?exit 1; \}/);
    }
    expect(CHECK_PACKAGE).toMatch(/flags=\.\*runtime/);
    expect(CHECK_PACKAGE).toMatch(/file "\$EXECUTABLE" \| grep -q "\$FILE_ARCH"/);
    expect(CHECK_UPDATE_ZIP).toMatch(/zip does not contain PhantomChat\.app at its root/);
  });

  it('skips desktop releases for non-payload-only changes', () => {
    for(const ignored of ['.github/**', 'src/tests/**', 'scripts/**']) {
      expect(WORKFLOW).toContain(`- '${ignored}'`);
    }
  });

  it('retries transient Apple operations and produces a re-zipped app', () => {
    const sandbox = setupSandbox(String.raw`
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

    runNotarize(sandbox);

    expect(readFileSync(join(sandbox.state, 'notarytool-submit'), 'utf8')).toBe('1');
    expect(readFileSync(join(sandbox.state, 'notarytool-wait'), 'utf8')).toBe('3');
    expect(Number(readFileSync(join(sandbox.state, 'stapler-staple'), 'utf8'))).toBeGreaterThan(1);
    expect(readFileSync(sandbox.zip, 'utf8')).toBe('zip');
  });

  it('does not perform a CloudKit validation lookup after successful stapling', () => {
    // Run 39586434529 failed with exit 68 only after Apple accepted the
    // submission and stapler had already reported success. Any validate call
    // is a regression and makes this otherwise-successful fixture fail.
    const sandbox = setupSandbox(String.raw`
operation="$1-$2"
printf '%s\n' "$operation" >> "$TEST_STATE/operations"
if [[ "$operation" == "notarytool-submit" ]]; then
  printf '{"id":"accepted-submission"}\n'
elif [[ "$operation" == "stapler-validate" ]]; then
  exit 68
fi`);

    runNotarize(sandbox);

    expect(readFileSync(join(sandbox.state, 'operations'), 'utf8')).not.toContain('stapler-validate');
    expect(readFileSync(sandbox.zip, 'utf8')).toBe('zip');
  });

  it('fails closed when Apple rejects notarization', () => {
    const sandbox = setupSandbox(String.raw`
operation="$1-$2"
printf '%s\n' "$operation" >> "$TEST_STATE/operations"
if [[ "$operation" == "notarytool-submit" ]]; then
  printf '{"id":"rejected-submission"}\n'
elif [[ "$operation" == "notarytool-wait" ]]; then
  exit 1
fi`);

    expect(() => runNotarize(sandbox)).toThrow();
    expect(readFileSync(join(sandbox.state, 'operations'), 'utf8')).not.toContain('stapler-staple');
    expect(readFileSync(sandbox.zip, 'utf8')).toBe('signed zip');
  });

  it('fails closed when stapling exhausts its retries', () => {
    const sandbox = setupSandbox(String.raw`
operation="$1-$2"
counter="$TEST_STATE/$operation"
count=0
[[ -f "$counter" ]] && count="$(cat "$counter")"
count=$((count + 1))
printf '%s' "$count" > "$counter"
if [[ "$operation" == "notarytool-submit" ]]; then
  printf '{"id":"accepted-submission"}\n'
elif [[ "$operation" == "stapler-staple" ]]; then
  exit 68
fi`);

    expect(() => runNotarize(sandbox)).toThrow();
    expect(readFileSync(join(sandbox.state, 'stapler-staple'), 'utf8')).toBe('4');
    expect(readFileSync(sandbox.zip, 'utf8')).toBe('signed zip');
  });

  it('never resubmits after a lost-connection submit flake', () => {
    // The run 38387097087 flake class: the submission is accepted, the
    // connection drops, and the exit-68 lands after the accepted JSON.
    const sandbox = setupSandbox(String.raw`
operation="$1-$2"
counter="$TEST_STATE/$operation"
count=0
[[ -f "$counter" ]] && count="$(cat "$counter")"
count=$((count + 1))
printf '%s' "$count" > "$counter"
if [[ "$operation" == "notarytool-submit" ]]; then
  printf '{"id":"submission-%s"}\n' "$count"
  exit 68
fi`);

    expect(() => runNotarize(sandbox)).toThrow();

    // Exactly one submission attempt, and nothing downstream of a submission
    // id may run: the job fails fast so a rerun reuses the signed artifacts.
    expect(readFileSync(join(sandbox.state, 'notarytool-submit'), 'utf8')).toBe('1');
    expect(existsSync(join(sandbox.state, 'notarytool-wait'))).toBe(false);
    expect(existsSync(join(sandbox.state, 'stapler-staple'))).toBe(false);
    // The signed zip is untouched by a failed run.
    expect(readFileSync(sandbox.zip, 'utf8')).toBe('signed zip');
  });
});
