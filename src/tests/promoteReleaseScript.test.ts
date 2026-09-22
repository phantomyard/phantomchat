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
import {mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync} from 'node:fs';
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
      view) echo '{"isPrerelease": true, "isDraft": false, "assets": []}' ;;
      download)
        for f in $GH_FAKE_ASSETS; do echo "payload-of-$f" > "$f"; done
        if [[ -n "\${GH_FAKE_ASSETS:-}" ]]; then
          sha256sum $GH_FAKE_ASSETS > SHA256SUMS.txt
        fi
        ;;
      edit) : ;;
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
}

function runPromote(assets: string): RunResult {
  const sandbox = mkdtempSync(join(tmpdir(), 'promote-release-test-'));
  try {
    const binDir = join(sandbox, 'bin');
    mkdirSync(binDir);
    const shim = join(binDir, 'gh');
    writeFileSync(shim, GH_SHIM);
    chmodSync(shim, 0o755);
    return spawnSync('bash', [SCRIPT, TAG, 'phantomyard/phantomchat'], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        GH_FAKE_ASSETS: assets,
        GH_FAKE_LATEST_TAG: TAG
      },
      encoding: 'utf8'
    }) as unknown as RunResult;
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

  it('promotes when every required artifact is present and checksums verify', () => {
    const res = runPromote('PhantomChat-1.0.42.AppImage phantomchat_1.0.42_amd64.deb');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('All required artifacts present');
    expect(res.stdout).toContain(`Verified: ${TAG} is the stable latest.`);
  });
});
