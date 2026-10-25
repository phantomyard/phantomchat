/*
 * Every git tag this repo creates must live in the `phantomchat-v*` namespace.
 *
 * Why this is load-bearing and not style: the desktop Preview channel sets
 * electron-updater's `allowPrerelease`, and that code path resolves "latest" by
 * taking the FIRST entry of GitHub's releases.atom feed without checking that
 * the entry has a release or assets behind it. A bare `v1.0.N` tag — which
 * deploy.yml used to push after every PWA deploy — is an atom entry with
 * neither, so Preview would fetch
 * `releases/download/v1.0.N/latest-mac.yml` and 404 until the next real
 * release published. Stable was unaffected because it resolves /releases/latest.
 *
 * So: no workflow may push a tag, and the only tag the release scripts create
 * is the namespaced one. A future "let's tag the deploy" change fails here.
 */
import {describe, it, expect} from 'vitest';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const WORKFLOW_DIR = join(process.cwd(), '.github', 'workflows');
const workflows = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

/** Strip `#` comments so prose explaining the ban doesn't trip the ban. */
function code(source: string): string {
  return source
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n');
}

describe('release tag namespace', () => {
  it('finds the workflows it is meant to police', () => {
    expect(workflows).toContain('deploy.yml');
    expect(workflows).toContain('app-release.yml');
  });

  it.each(workflows)('%s creates no git tags', (file) => {
    const source = code(readFileSync(join(WORKFLOW_DIR, file), 'utf8'));
    expect(source, `${file} runs \`git tag\``).not.toMatch(/\bgit\s+tag\b/);
    expect(source, `${file} pushes a ref to origin`).not.toMatch(/\bgit\s+push\b[^\n]*origin/);
  });

  it('PWA archive releases remain drafts outside the desktop updater feed', () => {
    const registry = readFileSync(join(process.cwd(), 'scripts/releases/registry.mjs'), 'utf8');
    expect(registry).toContain("'--draft'");
    expect(registry).not.toContain("'--draft=false'");
    expect(registry).not.toContain("'--prerelease'");
  });

  it('publish-release.sh only ever creates a namespaced tag', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'publish-release.sh'), 'utf8');
    // The tag is the caller's first argument; app-release.yml must namespace it.
    const workflow = readFileSync(join(WORKFLOW_DIR, 'app-release.yml'), 'utf8');
    expect(script).toMatch(/gh release create "\$TAG"/);
    expect(workflow).toMatch(/phantomchat-v/);
    expect(code(workflow)).not.toMatch(/TAG=["']?v\$\{?/);
  });
});
