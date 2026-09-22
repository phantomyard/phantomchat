/*
 * publish-release.sh contract tests (issue #150 PR#1).
 *
 * Runs the real script against a stub `gh` CLI on PATH that models remote
 * tag/release state in a state file — no network, no real repo involved.
 *
 * The app-release workflow synthesizes phantomchat-v1.0.<run_number> tags from
 * its monotonic run counter (phantombot's naming model), so the contract
 * here is: the release must not exist, the synthesized tag must not exist,
 * the tag must be pinned to the built commit (--target), the release must
 * be a prerelease (preview ring), and every listed artifact must actually
 * be present as a file before `gh release create` runs.
 */
import {describe, it, expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'publish-release.sh');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const VERSION = '1.0.42';
const TAG = `phantomchat-v${VERSION}`;
const ASSETS = [`PhantomChat-${VERSION}.AppImage`, `phantomchat_${VERSION}_amd64.deb`, 'SHA256SUMS.txt'];

// Stub gh: state file lines look like `key=value`. `release-<tag>` present
// means the release exists; `<tag>=<sha>` is the remote tag -> commit map;
// `created-<tag>` is set when `release create` succeeds (with the sha the
// tag was pinned to via --target).
const GH_SHIM = `#!/usr/bin/env bash
set -u
STATE="\${GH_STUB_STATE:?}"
get() { grep -m1 "^$1=" "$STATE" 2>/dev/null | cut -d= -f2-; }
setkv() { grep -v "^$1=" "$STATE" > "$STATE.tmp" 2>/dev/null || true; mv "$STATE.tmp" "$STATE"; echo "$1=$2" >> "$STATE"; }
fail() { echo "stub: $*" >&2; exit 1; }

cmd="\${1:-}"; shift || true
case "$cmd" in
  api)
    path=""
    for a in "$@"; do
      [[ "$a" != -* && -z "$path" ]] && path="$a"
    done
    case "$path" in
      repos/*/git/ref/tags/*)
        t="\${path##*/tags/}"
        [[ -n "$(get "$t")" ]] || exit 1
        echo "{\"ref\": \"refs/tags/$t\", \"object\": {\"sha\": \"$(get "$t")\", \"type\": \"commit\"}}" ;;
      *) fail "unexpected api path: \${path}" ;;
    esac ;;
  release)
    sub="\${1:-}"; shift || true
    case "$sub" in
      view)
        t="\${1:-}"; [[ "$t" == view ]] && { t="\${2:-}"; shift; } || true
        [[ -n "$(get "release-$t")" ]] || exit 1 ;;
      create)
        t=""; target=""; prerelease=0; notes_file=""; assets=()
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --target) target="\${2:-}"; shift 2 ;;
            --notes-file) notes_file="\${2:-}"; shift 2 ;;
            --prerelease) prerelease=1; shift ;;
            --repo|--title|--notes) shift 2 ;;
            --*) shift ;;
            *) if [[ -z "$t" ]]; then t="$1"; else assets+=("$1"); fi; shift ;;
          esac
        done
        [[ -n "$(get "release-$t")" ]] && fail "release \${t} already exists"
        [[ -n "$(get "$t")" ]] && fail "tag \${t} already exists (stub refuses to move refs)"
        [[ "$prerelease" == 1 ]] || fail "release create without --prerelease (preview ring is mandatory)"
        [[ -n "$target" ]] || fail "release create without --target (tag must be pinned to the built commit)"
        [[ -n "$notes_file" ]] && [[ ! -f "$notes_file" ]] && fail "notes file missing: \${notes_file}"
        # every listed asset must exist as a file before the create call
        for f in "\${assets[@]}"; do [[ -f "$f" ]] || fail "asset file missing: $f"; done
        setkv "$t" "$target"
        setkv "created-$t" "prerelease"
        echo "https://github.com/phantomyard/phantomchat/releases/tag/\${t}" ;;
      *) fail "unexpected release subcommand: \${sub}" ;;
    esac ;;
  *) fail "unexpected command: \${cmd}" ;;
esac
`;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runPublish(opts: {
  remoteTagSha?: string; // absent = tag not on remote
  releaseExists?: boolean;
  tag?: string;
  version?: string;
  notesFile?: string | false; // false = unset; string path = RELEASE_NOTES_FILE
  title?: string;
  missingAsset?: string; // asset name to omit from the artifacts dir
}): RunResult & {state: string} {
  const sandbox = mkdtempSync(join(tmpdir(), 'publish-release-test-'));
  try {
    const binDir = join(sandbox, 'bin');
    const artifacts = join(sandbox, 'artifacts');
    mkdirSync(binDir);
    mkdirSync(artifacts);
    const state = join(sandbox, 'state');
    const lines: string[] = [];
    if (opts.remoteTagSha) lines.push(`${opts.tag ?? TAG}=${opts.remoteTagSha}`);
    if (opts.releaseExists) lines.push(`release-${opts.tag ?? TAG}=1`);
    writeFileSync(state, lines.join('\n') + (lines.length ? '\n' : ''));
    for (const asset of ASSETS) {
      if (asset === opts.missingAsset) continue;
      writeFileSync(join(artifacts, asset), `fixture-${asset}\n`);
    }
    const shim = join(binDir, 'gh');
    writeFileSync(shim, GH_SHIM);
    chmodSync(shim, 0o755);
    const notesPath = typeof opts.notesFile === 'string' ? opts.notesFile : undefined;
    if (notesPath !== undefined && opts.notesFile !== 'does-not-exist.md') {
      // Production layout: the workflow writes the notes at the INVOCATION
      // dir (repo root), not inside the artifacts dir — the script must
      // resolve the relative path against where it is invoked from, before it
      // cd's into the artifacts directory.
      writeFileSync(join(sandbox, notesPath), 'notes body\n');
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      GH_STUB_STATE: state
    };
    if (notesPath !== undefined) env.RELEASE_NOTES_FILE = notesPath;
    if (opts.title !== undefined) env.RELEASE_TITLE = opts.title;
    const res = spawnSync(
      'bash',
      [SCRIPT, opts.tag ?? TAG, opts.version ?? VERSION, COMMIT, artifacts, 'phantomyard/phantomchat'],
      {cwd: sandbox, env, encoding: 'utf8'}
    ) as unknown as RunResult;
    return {...res, state: readFileSync(state, 'utf8')};
  } finally {
    rmSync(sandbox, {recursive: true, force: true});
  }
}

describe('publish-release.sh', () => {
  it('publishes a preview release with the tag pinned to the built commit', () => {
    const res = runPublish({});
    expect(res.status).toBe(0);
    expect(res.state).toContain(`created-${TAG}=prerelease`);
    expect(res.state).toContain(`${TAG}=${COMMIT}`);
  });

  it('passes the custom title and notes file through to gh release create', () => {
    const res = runPublish({notesFile: 'release-notes.md', title: `${TAG} (PR #151)`});
    expect(res.status).toBe(0);
    expect(res.state).toContain(`created-${TAG}=prerelease`);
  });

  it("resolves a relative RELEASE_NOTES_FILE from the invocation dir (workflow layout: notes at repo root, relative artifacts dir, script cd's into artifacts)", () => {
    // Reproduces the app-release workflow's exact invocation: the notes file
    // is written at the "repo root", the script is invoked from there with a
    // RELATIVE artifacts dir (release/<version>), and RELEASE_NOTES_FILE is
    // passed as a bare relative path. Before the fix this failed with
    // "RELEASE_NOTES_FILE not found" on every real publication.
    const sandbox = mkdtempSync(join(tmpdir(), 'publish-release-wf-'));
    try {
      const binDir = join(sandbox, 'bin');
      const artifacts = join(sandbox, `release/${VERSION}`);
      mkdirSync(binDir, {recursive: true});
      mkdirSync(artifacts, {recursive: true});
      const state = join(sandbox, 'state');
      writeFileSync(state, '');
      for (const asset of ASSETS) {
        writeFileSync(join(artifacts, asset), `fixture-${asset}\n`);
      }
      const shim = join(binDir, 'gh');
      writeFileSync(shim, GH_SHIM);
      chmodSync(shim, 0o755);
      writeFileSync(join(sandbox, 'release-notes.md'), 'notes body\n');
      const res = spawnSync(
        'bash',
        [SCRIPT, TAG, VERSION, COMMIT, `release/${VERSION}`, 'phantomyard/phantomchat'],
        {
          cwd: sandbox,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STUB_STATE: state,
            RELEASE_NOTES_FILE: 'release-notes.md'
          },
          encoding: 'utf8'
        }
      ) as unknown as RunResult;
      expect(res.status).toBe(0);
      expect(res.stderr).toBe('');
      expect(readFileSync(state, 'utf8')).toContain(`created-${TAG}=prerelease`);
    } finally {
      rmSync(sandbox, {recursive: true, force: true});
    }
  });

  it('fails closed when the release already exists (immutability)', () => {
    const res = runPublish({releaseExists: true});
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('immutable');
  });

  it('fails closed when the synthesized tag already exists on the remote', () => {
    const res = runPublish({remoteTagSha: COMMIT});
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('already exists on the remote');
    expect(res.state).not.toContain(`created-${TAG}`);
  });

  it('refuses a version outside the strict numeric semver grammar', () => {
    const res = runPublish({version: '1.0.42$(boom)', tag: 'phantomchat-v1.0.42$(boom)'});
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('unsupported version');
  });

  it('refuses a tag that does not match its version', () => {
    const res = runPublish({tag: 'phantomchat-v9.9.9'});
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('must be phantomchat-v<version>');
  });

  it('fails closed when a required artifact file is missing', () => {
    const res = runPublish({missingAsset: `phantomchat_${VERSION}_amd64.deb`});
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('PUBLISH FAILED');
    expect(res.state).not.toContain(`created-${TAG}`);
  });

  it('fails closed when RELEASE_NOTES_FILE points at a missing file', () => {
    const res = runPublish({notesFile: 'does-not-exist.md'});
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('RELEASE_NOTES_FILE not found');
  });
});
