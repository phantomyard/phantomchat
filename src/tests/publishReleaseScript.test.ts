/*
 * publish-release.sh contract tests (issue #150 PR#1 review, round 2).
 *
 * Runs the real script against a stub `gh` CLI on PATH that models remote
 * tag/release state in a state file — no network, no real repo involved.
 * Covers Kai's round-2 blocker: `--verify-tag` made the manual-dispatch
 * release path impossible (the synthesized desktop-v1.0.<run_number> tag
 * does not exist remotely), and the fix must still fail closed if a tag of
 * that name already exists pointing at a different commit (tag drift).
 */
import {describe, it, expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'publish-release.sh');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const OTHER_COMMIT = 'ffffffffffffffffffffffffffffffffffffffff';
const TAG = 'desktop-v1.0.42';

// Stub gh: state file lines look like `key=value`. `release-<tag>` present
// means the release exists; `<tag>=<sha>` is the remote tag → commit map.
// `release create` enforces the real contract: --verify-tag must be passed
// and --target must match the remote tag's commit.
const GH_SHIM = `#!/usr/bin/env bash
set -u
STATE="\${GH_STUB_STATE:?}"
get() { grep -m1 "^$1=" "$STATE" 2>/dev/null | cut -d= -f2-; }
setkv() { grep -v "^$1=" "$STATE" > "$STATE.tmp" 2>/dev/null || true; mv "$STATE.tmp" "$STATE"; echo "$1=$2" >> "$STATE"; }
fail() { echo "stub: $*" >&2; exit 1; }

cmd="\${1:-}"; shift || true
case "$cmd" in
  api)
    # extract the --jq filter (gh applies it client-side); the first
    # non-flag argument is the API path.
    path=""; jq=""; prev=""
    for a in "$@"; do
      [[ "$prev" == "--jq" ]] && jq="$a"
      if [[ "$a" != -* && "$prev" != "--jq" && -z "$path" ]]; then path="$a"; fi
      prev="$a"
    done
    case "$path" in
      repos/*/git/refs)
        # POST creating a ref: -f ref=refs/tags/<t> -f sha=<sha>
        ref=""; sha=""
        while [[ $# -gt 0 ]]; do
          case "$1" in
            -f) key="\${2%%=*}"; val="\${2#*=}"; [[ "$key" == ref ]] && ref="$val"; [[ "$key" == sha ]] && sha="$val"; shift 2 ;;
            *) shift ;;
          esac
        done
        t="\${ref#refs/tags/}"
        [[ -n "$(get "$t")" ]] && fail "ref \${ref} already exists (422)"
        setkv "$t" "$sha"
        echo '{"ref": "'"$ref"'"}' ;;
      repos/*/git/ref/tags/*)
        t="\${path##*/tags/}"
        sha="$(get "$t")"
        [[ -z "$sha" ]] && fail "tag \${t} not found (404)"
        if [[ "$jq" == ".object.sha" ]]; then
          echo "$sha"
        elif [[ "$jq" == ".object.type" ]]; then
          echo "\${GH_FAKE_TAG_TYPE:-commit}"
        else
          echo "{\"object\": {\"sha\": \"\$sha\", \"type\": \"\${GH_FAKE_TAG_TYPE:-commit}\"}}"
        fi ;;
      repos/*/git/tags/*)
        # annotated-tag deref: object.sha is the underlying commit
        if [[ "$jq" == ".object.sha" ]]; then
          echo "\${GH_FAKE_ANNOTATED_TARGET:-$COMMIT}"
        else
          echo "{\"object\": {\"sha\": \"\${GH_FAKE_ANNOTATED_TARGET:-$COMMIT}\", \"type\": \"commit\"}}"
        fi ;;
      *) fail "unexpected api path: \${path}" ;;
    esac ;;
  release)
    sub="\${1:-}"; shift || true
    case "$sub" in
      view)
        t="\${1:-}"; [[ "$t" == view ]] && { t="\${2:-}"; shift; } || true
        [[ -n "$(get "release-$t")" ]] || exit 1 ;;
      create)
        t=""; target=""; verify=0
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --verify-tag) verify=1; shift ;;
            --target) target="\${2:-}"; shift 2 ;;
            --repo) shift 2 ;;
            --prerelease) shift ;;
            --title|--notes) shift 2 ;;
            --*) shift ;;
            *) [[ -z "$t" ]] && t="$1" || shift ;;
          esac
        done
        [[ -n "$(get "release-$t")" ]] && fail "release \${t} already exists"
        [[ "$verify" == 1 ]] || fail "release create without --verify-tag"
        # Compare --target against the tag's *resolved* commit — for an
        # annotated tag the ref's object sha is the annotation object, and
        # the deref goes through the git/tags endpoint like the real gh.
        expected="$(get "$t")"
        [[ "\${GH_FAKE_TAG_TYPE:-commit}" == "tag" ]] && expected="$GH_FAKE_ANNOTATED_TARGET"
        [[ "$target" == "$expected" ]] || fail "release create --target \${target} != tag commit \${expected}"
        setkv "release-$t" 1
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
  trigger: 'tag' | 'manual';
  remoteTagSha?: string; // absent = tag not on remote
  releaseExists?: boolean;
  annotatedTarget?: string;
  annotated?: boolean; // remote tag object is an annotated tag (type "tag")
  tag?: string;
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
    const shim = join(binDir, 'gh');
    writeFileSync(shim, GH_SHIM);
    chmodSync(shim, 0o755);
    const res = spawnSync(
      'bash',
      [SCRIPT, opts.tag ?? TAG, '1.0.42', COMMIT, opts.trigger, artifacts, 'phantomyard/phantomchat'],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GH_STUB_STATE: state,
          GH_FAKE_ANNOTATED_TARGET: opts.annotatedTarget ?? COMMIT,
          GH_FAKE_TAG_TYPE: opts.annotated ? 'tag' : 'commit'
        },
        encoding: 'utf8'
      }
    ) as unknown as RunResult;
    return {...res, state: readFileSync(state, 'utf8')};
  } finally {
    rmSync(sandbox, {recursive: true, force: true});
  }
}

describe('publish-release.sh', () => {
  it('manual run: creates the missing tag at the built commit, then publishes', () => {
    const res = runPublish({trigger: 'manual'});
    expect(res.status).toBe(0);
    // The synthesized tag now exists on the "remote" at the built commit...
    expect(res.state).toContain(`${TAG}=${COMMIT}`);
    // ...and the release was created (stub enforces --verify-tag + --target).
    expect(res.state).toContain(`release-${TAG}=1`);
  });

  it('manual run: an existing tag pointing at the same commit is accepted', () => {
    const res = runPublish({trigger: 'manual', remoteTagSha: COMMIT});
    expect(res.status).toBe(0);
    expect(res.state).toContain(`release-${TAG}=1`);
  });

  it('manual run: fails closed when the tag exists but points elsewhere (tag drift)', () => {
    const res = runPublish({trigger: 'manual', remoteTagSha: OTHER_COMMIT});
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('tag drift');
    expect(res.state).not.toContain(`release-${TAG}`);
  });

  it('tag run: a tag resolving to the built commit publishes', () => {
    const res = runPublish({trigger: 'tag', remoteTagSha: COMMIT});
    expect(res.status).toBe(0);
    expect(res.state).toContain(`release-${TAG}=1`);
  });

  it('tag run: fails when the tag is missing from the remote', () => {
    const res = runPublish({trigger: 'tag'});
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('not found on the remote');
    expect(res.state).not.toContain(`release-${TAG}`);
  });

  it('tag run: fails closed on tag drift (tag points at another commit)', () => {
    const res = runPublish({trigger: 'tag', remoteTagSha: OTHER_COMMIT});
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('tag drift');
    expect(res.state).not.toContain(`release-${TAG}`);
  });

  it('fails closed when the release already exists (immutability)', () => {
    const res = runPublish({trigger: 'manual', remoteTagSha: COMMIT, releaseExists: true});
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('immutable');
  });

  it('resolves annotated tags to the underlying commit', () => {
    // Remote tag object is type "tag" (annotated); the stub's git/tags
    // endpoint returns the underlying commit (GH_FAKE_ANNOTATED_TARGET).
    const res = runPublish({trigger: 'tag', remoteTagSha: 'aaaannotatedobjectsha', annotated: true, annotatedTarget: COMMIT});
    expect(res.status).toBe(0);
    expect(res.state).toContain(`release-${TAG}=1`);
  });

  it('rejects an annotated tag whose underlying commit is not the built commit', () => {
    const res = runPublish({trigger: 'tag', remoteTagSha: 'aaaannotatedobjectsha', annotated: true, annotatedTarget: OTHER_COMMIT});
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('tag drift');
  });
});
