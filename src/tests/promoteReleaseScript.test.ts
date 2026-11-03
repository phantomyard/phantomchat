/*
 * promote-release.sh contract tests (issue #150 PR#1 review).
 *
 * Runs the real script against a stub `gh` CLI on PATH, so no network and
 * no real release is involved. Covers Kai's blocker: a missing required
 * artifact must fail the promotion (an unmatched glob used to pass the
 * length check because bash leaves it literal without nullglob).
 */
import {describe, it, expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'promote-release.sh');
const TAG = 'phantomchat-v1.0.42';

const GH_SHIM = `#!/usr/bin/env bash
set -u
cmd="\${1:-}"; shift || true
case "$cmd" in
  release)
    sub="\${1:-}"; shift || true
    case "$sub" in
      view)
        # Notes are the stored body: the preview notes until an edit writes new ones.
        body="$(cat "$GH_FAKE_STATE/body" 2>/dev/null || printf '%s' "\${GH_FAKE_BODY:-}")"
        if [[ " $* " == *" --jq "* ]]; then printf '%s\n' "$body"
        else jq -n --arg body "$body" '{isPrerelease: true, isDraft: false, assets: [], body: $body}'; fi ;;
      download)
        for f in $GH_FAKE_ASSETS; do
          # The update feeds are parsed by the script (version check), so the
          # shim has to emit something feed-shaped rather than opaque bytes.
          case "$f" in
            *.yml) printf 'version: %s\nfiles:\n  - url: x\n' "\${GH_FAKE_FEED_VERSION:-1.0.42}" > "$f" ;;
            *) echo "payload-of-$f" > "$f" ;;
          esac
        done
        if [[ -n "\${GH_FAKE_ASSETS:-}" ]]; then
          sha256sum $GH_FAKE_ASSETS > SHA256SUMS.txt
        fi
        ;;
      edit)
        echo "$*" > "$GH_FAKE_STATE/edit-args"
        while [[ $# -gt 0 ]]; do
          if [[ "$1" == "--notes-file" ]]; then
            [[ -n "\${GH_FAKE_EDIT_IGNORES_NOTES:-}" ]] || cp "$2" "$GH_FAKE_STATE/body"
          fi
          shift
        done ;;
      *) exit 1 ;;
    esac ;;
  api)
    # Mimic the real gh: --jq .tag_name prints just the tag.
    if [[ "\${2:-}" == "--jq" && "\${3:-}" == ".tag_name" ]]; then
      echo "\${GH_FAKE_LATEST_TAG:-phantomchat-v1.0.0}"
    else
      echo "{\\"tag_name\\": \\"\${GH_FAKE_LATEST_TAG:-phantomchat-v1.0.0}\\"}"
    fi ;;
  *) exit 64 ;;
esac
`;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  body?: string;
  editArgs?: string;
}

// The tail app-release.yml writes on every Preview release (issue #413).
const PREVIEW_NOTES = `Desktop release from workflow run #7 (run id 41617655530).
Originating PR: #411 — feat

Verify with: sha256sum -c SHA256SUMS.txt
Install and channel docs: docs/ELECTRON-DESKTOP.md

Release ring: PREVIEW. This is a prerelease, so it is not served as
the stable/latest release. To ship it to everyone, run the
"Electron 2. Promote Preview to Stable — manual" workflow against phantomchat-v1.0.42 — that flips this exact release
(same artifacts, same checksums) to stable without rebuilding.`;

const ALL_ASSETS = [
  'PhantomChat-1.0.42.AppImage',
  'phantomchat_1.0.42_amd64.deb',
  'phantomchat_1.0.42_x86_64.rpm',
  'PhantomChat-1.0.42-x64.dmg',
  'PhantomChat-1.0.42-arm64.dmg',
  'PhantomChat-1.0.42-x64.zip',
  'PhantomChat-1.0.42-arm64.zip',
  'PhantomChat-1.0.42-windows-x64.exe',
  'PhantomChat-1.0.42-windows-arm64.exe',
  'latest.yml',
  'latest-mac.yml',
  'latest-linux.yml'
].join(' ');

function runPromote(assets: string, feedVersion = '1.0.42', extraEnv: Record<string, string> = {}): RunResult {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-release-test-'));
  try {
    const state = join(sandbox, 'state');
    mkdirSync(state);
    const binDir = join(sandbox, 'bin');
    mkdirSync(binDir);
    const shim = join(binDir, 'gh');
    writeFileSync(shim, GH_SHIM);
    chmodSync(shim, 0o755);
    const result = spawnSync('bash', [SCRIPT, TAG, 'phantomyard/phantomchat'], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        GH_FAKE_ASSETS: assets,
        GH_FAKE_FEED_VERSION: feedVersion,
        GH_FAKE_LATEST_TAG: TAG,
        GH_FAKE_STATE: state,
        GH_FAKE_BODY: PREVIEW_NOTES,
        PROMOTE_RUN_URL: 'https://github.com/phantomyard/phantomchat/actions/runs/1',
        ...extraEnv
      },
      encoding: 'utf8'
    }) as unknown as RunResult;
    const read = (name: string) => { try { return readFileSync(join(state, name), 'utf8'); } catch { return undefined; } };
    return {...result, body: read('body'), editArgs: read('edit-args')};
  } finally {
    rmSync(sandbox, {recursive: true, force: true});
  }
}

describe('promote-release.sh', () => {
  it('fails closed when a required artifact is missing from the release', () => {
    // deb + checksum manifest exist, but the AppImage is absent — the
    // promotion must abort before any metadata is touched.
    const res = runPromote('phantomchat_1.0.42_amd64.deb');
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('required artifact missing');
    expect(res.stderr).toContain('PhantomChat-*.AppImage');
  });

  it('fails closed when the release has no artifacts at all', () => {
    const res = runPromote('');
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('required artifact missing');
  });

  it('fails closed when the Apple Silicon DMG is missing', () => {
    const res = runPromote(
      'PhantomChat-1.0.42.AppImage phantomchat_1.0.42_amd64.deb phantomchat_1.0.42_x86_64.rpm PhantomChat-1.0.42-x64.dmg'
    );
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('required artifact missing');
    expect(res.stderr).toContain('PhantomChat-*-arm64.dmg');
  });

  it('fails closed when the rpm is missing (deb/rpm auto-update)', () => {
    // RpmUpdater installs pick their payload out of latest-linux.yml — a
    // release without the rpm breaks every package-managed rpm install.
    const res = runPromote(ALL_ASSETS.replace('phantomchat_1.0.42_x86_64.rpm ', ''));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('required artifact missing');
    expect(res.stderr).toContain('phantomchat_*_x86_64.rpm');
  });

  it('fails closed when the Windows arm64 installer is missing', () => {
    const res = runPromote(
      ALL_ASSETS.replace(' PhantomChat-1.0.42-windows-arm64.exe', '')
    );
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('required artifact missing');
    expect(res.stderr).toContain('PhantomChat-*-windows-arm64.exe');
  });

  it('fails closed when the Windows update feed is missing (issue #164)', () => {
    // Without latest.yml the stable ring is invisible to every installed
    // client: they check, get a 404 and sit on the old build forever.
    const res = runPromote(ALL_ASSETS.replace('latest.yml ', ''));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('required artifact missing');
    expect(res.stderr).toContain('latest.yml');
  });

  it('fails closed when the Linux update feed is missing (issue #164)', () => {
    const res = runPromote(ALL_ASSETS.replace(' latest-linux.yml', ''));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('required artifact missing');
    expect(res.stderr).toContain('latest-linux.yml');
  });

  it('fails closed when the macOS update feed is missing (issue #169)', () => {
    // 1.0.274 shipped exactly this way: both DMGs present, no latest-mac.yml,
    // so every Mac install silently stopped seeing updates.
    const res = runPromote(ALL_ASSETS.replace(' latest-mac.yml', ''));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('required artifact missing');
    expect(res.stderr).toContain('latest-mac.yml');
  });

  it('fails closed when a macOS update zip is missing (issue #169)', () => {
    // The zip, not the DMG, is what Squirrel.Mac installs — a release with
    // the feed but without the zip 404s mid-update.
    const res = runPromote(ALL_ASSETS.replace(' PhantomChat-1.0.42-arm64.zip', ''));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('required artifact missing');
    expect(res.stderr).toContain('arm64.zip');
  });

  it('fails closed when a feed describes a DIFFERENT release than the tag', () => {
    // A stale feed re-uploaded from an earlier run would point stable users
    // at artifacts that are not on this release.
    const res = runPromote(ALL_ASSETS, '1.0.41');
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('does not declare version 1.0.42');
  });

  it('promotes when every required artifact is present and checksums verify', () => {
    const res = runPromote(ALL_ASSETS);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Update feeds declare version 1.0.42');
    expect(res.stdout).toContain('All required artifacts present');
    expect(res.stdout).toContain(`Verified: ${TAG} is the stable latest.`);
  });

  it('rewrites the preview ring paragraph so a promoted release says it is stable (issue #413)', () => {
    const res = runPromote(ALL_ASSETS);
    expect(res.status).toBe(0);
    expect(res.editArgs).toContain('--prerelease=false');
    expect(res.editArgs).toContain('--notes-file');
    expect(res.body).not.toContain('This is a prerelease');
    expect(res.body).not.toContain('Release ring: PREVIEW');
    expect(res.body).toMatch(/^Release ring: STABLE\. Promoted to stable on \d{4}-\d{2}-\d{2} \(https:\/\/github\.com\/phantomyard\/phantomchat\/actions\/runs\/1\)\.$/m);
    // Everything above the ring paragraph is the build's audit trail: kept as is.
    expect(res.body!.startsWith(PREVIEW_NOTES.slice(0, PREVIEW_NOTES.indexOf('Release ring:')))).toBe(true);
    expect(res.stdout).toContain(`Verified: the notes of ${TAG} say it is stable.`);
  });

  it('a re-run replaces the stable block instead of stacking a second one', () => {
    const first = runPromote(ALL_ASSETS);
    const again = runPromote(ALL_ASSETS, '1.0.42', {GH_FAKE_BODY: first.body!});
    expect(again.status).toBe(0);
    expect(again.body!.match(/Release ring:/g)).toHaveLength(1);
  });

  it('fails the run when the notes did not change on the release', () => {
    const res = runPromote(ALL_ASSETS, '1.0.42', {GH_FAKE_EDIT_IGNORES_NOTES: '1'});
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('do not say it is stable');
  });
});
