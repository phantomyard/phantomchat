/*
 * Third side of the release asset contract (issue #169).
 *
 * publishReleaseScript.test.ts already pins publish-release.sh against
 * promote-release.sh. Both are scripts, and both were correct-looking while
 * 1.0.274 still shipped a macOS release nobody could update from: the WORKFLOW
 * never produced latest-mac.yml in the first place, so there was nothing for
 * the scripts to disagree about.
 *
 * This file closes that hole by asserting the third side of the triangle —
 * what app-release.yml checksums must be exactly what publish-release.sh
 * uploads. That equivalence is load-bearing beyond hygiene: promote-release.sh
 * fails a release whose asset list differs from SHA256SUMS.txt, so a drift
 * here breaks promotion outright.
 */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const WORKFLOW = readFileSync(join(process.cwd(), '.github', 'workflows', 'app-release.yml'), 'utf8');
const PUBLISH_SCRIPT = readFileSync(join(process.cwd(), 'scripts', 'publish-release.sh'), 'utf8');

/** Quoted "..." arguments of a backslash-continued shell arg list. */
function quotedArgs(block: string): string[] {
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** The files app-release.yml hashes into SHA256SUMS.txt. */
function checksummedAssets(): string[] {
  const m = WORKFLOW.match(/sha256sum \\\n([\s\S]*?)> SHA256SUMS\.txt/);
  expect(m, 'could not find the sha256sum block in app-release.yml').not.toBeNull();
  return quotedArgs(m![1]);
}

/** The files publish-release.sh uploads, minus SHA256SUMS.txt itself. */
function publishedAssets(): string[] {
  const createIdx = PUBLISH_SCRIPT.indexOf('gh release create');
  expect(createIdx).toBeGreaterThan(-1);
  const assets: string[] = [];
  for(const m of PUBLISH_SCRIPT.slice(createIdx).matchAll(/^\s+"([^"]+)"\s*\\?\s*$/gm)) {
    const name = m[1];
    if(name.startsWith('$')) continue; // "${NOTES_ARGS[@]}" and friends
    assets.push(name);
  }
  return assets.filter((a) => a !== 'SHA256SUMS.txt');
}

describe('app-release.yml <-> publish-release.sh asset drift guard', () => {
  it('checksums exactly the assets publication uploads', () => {
    // Compared as sorted sets so the failure message names the offender
    // rather than just "not equal".
    expect(checksummedAssets().slice().sort()).toEqual(publishedAssets().slice().sort());
  });

  it('builds and stages a per-architecture update feed on every platform', () => {
    // Each platform job must assert its own feed exists. A missing assertion
    // is how latest-mac.yml went unnoticed: electron-builder writes it or it
    // does not, and only the job that packaged can tell.
    expect(WORKFLOW).toContain('latest-linux.yml missing');
    expect(WORKFLOW).toContain('latest-mac.yml missing');
    expect(WORKFLOW).toContain('latest.yml missing');
  });

  it('merges both per-architecture macOS feeds into one latest-mac.yml', () => {
    // Two runners each write a latest-mac.yml describing only their own
    // architecture; publishing either one alone offers every Mac the wrong
    // build. merge-update-feed.mjs is what makes one feed serve both.
    expect(WORKFLOW).toMatch(
      /merge-update-feed\.mjs latest-mac\.yml latest-mac-x64\.yml latest-mac-arm64\.yml/
    );
  });

  it('re-stamps the macOS feed after stapling and re-zipping', () => {
    // Stapling rewrites the DMG and the zip is rebuilt from the stapled app,
    // so the hashes electron-builder wrote describe bytes that no longer
    // exist. electron-updater refuses to install on a sha512 mismatch.
    expect(WORKFLOW).toMatch(/restamp-update-feed\.mjs "release\/\$\{VERSION\}\/latest-mac\.yml"/);
  });
});
