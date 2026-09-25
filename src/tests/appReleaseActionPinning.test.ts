import {readFileSync} from 'node:fs';
import {join} from 'node:path';

// app-release.yml is the only workflow that handles code-signing credentials:
// it passes ES_USERNAME / ES_PASSWORD / ES_CREDENTIAL_ID / ES_TOTP_SECRET to
// the eSigner action and the Apple P12 / notarization secrets to the macOS
// packaging steps. Every step in those jobs runs on the same runner BEFORE
// the secrets are exposed, so any action referenced by a mutable ref (a
// branch or a major tag like @v4, both of which can be deleted and re-pushed
// at the same name) is part of the credential path: a compromised retag can
// alter the workspace or toolchain, append to GITHUB_PATH/GITHUB_ENV, or
// leave a process behind to observe the signing credentials later in the job.
//
// This guard fails the moment someone adds an unpinned `uses:` back. It runs
// on every PR, unlike the signing steps themselves.
const WORKFLOW = join(process.cwd(), '.github', 'workflows', 'app-release.yml');

const SHA_REF = /^[0-9a-f]{40}$/;

type UseRef = {
  line: number;
  raw: string;
  action: string;
  ref: string;
  comment: string;
};

function collectUses(text: string): UseRef[] {
  const out: UseRef[] = [];
  text.split('\n').forEach((raw, i) => {
    const m = raw.match(/^\s*(?:-\s+)?uses:\s*(\S+)\s*(#.*)?$/);
    if (!m) return;
    const value = m[1];
    // Local (./path) and docker:// references are not fetched from a mutable
    // upstream git ref, so they are out of scope for this rule.
    if (value.startsWith('./') || value.startsWith('docker://')) return;
    const at = value.lastIndexOf('@');
    out.push({
      line: i + 1,
      raw: raw.trim(),
      action: at === -1 ? value : value.slice(0, at),
      ref: at === -1 ? '' : value.slice(at + 1),
      comment: (m[2] ?? '').trim(),
    });
  });
  return out;
}

describe('app-release workflow action pinning', () => {
  let uses: UseRef[];

  beforeAll(() => {
    uses = collectUses(readFileSync(WORKFLOW, 'utf8'));
  });

  test('references at least one external action (guard is actually looking at something)', () => {
    expect(uses.length).toBeGreaterThan(0);
  });

  test('pins every action to a full 40-character commit sha', () => {
    const unpinned = uses.filter(u => !SHA_REF.test(u.ref));
    expect(
      unpinned,
      `app-release.yml has actions on mutable refs (credential path):\n` +
        unpinned.map(u => `  line ${u.line}: ${u.raw}`).join('\n'),
    ).toEqual([]);
  });

  test('records the human-readable version each sha corresponds to', () => {
    const uncommented = uses.filter(u => SHA_REF.test(u.ref) && !/^#\s*v?\d/.test(u.comment));
    expect(
      uncommented,
      `app-release.yml pins shas without recording the release they came from:\n` +
        uncommented.map(u => `  line ${u.line}: ${u.raw}`).join('\n'),
    ).toEqual([]);
  });

  test('still signs with the reviewed eSigner action', () => {
    const esigner = uses.filter(u => u.action === 'SSLcom/esigner-codesign');
    expect(esigner.length).toBeGreaterThan(0);
    esigner.forEach(u => {
      expect(u.ref, `line ${u.line}: eSigner action moved off the reviewed sha`).toBe(
        'cf5f6c1d38ad10f47e3ed9aca873f429b1a8d85b',
      );
    });
  });
});
