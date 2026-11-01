/**
 * #291 item 2: the two channel smokes must resolve the release-channel row the
 * same way.
 *
 * `openChannelSettings` is the shared helper both smokes call. It used to find
 * the row by DOM depth (`locator('../..')`) while `electron-smoke.mjs` derived
 * it with `ancestor::label[... " row "]`, so a change to how the `Row` factory
 * wraps the radio input broke one smoke while the other kept passing —
 * silently, because neither smoke runs in `ci.yml` (#286).
 *
 * The fix centralises the three lookups in `runtime-identity.mjs`. These
 * assertions are source-text, deliberately: the alternative is booting
 * Playwright for every PR, which is the exposure #286 tracks, not this issue.
 * They pin the contract the smokes rely on — no depth-derived locator survives,
 * and every row click goes through the shared ancestor query.
 */

import '../setup';
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'fs';
import {resolve} from 'path';

const REPO = resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8');

/** Executable lines only — the helper's own doc comment names the pattern it bans. */
const codeOf = (src: string) => src
  .split('\n')
  .filter(line => {
    const t = line.trim();
    return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

const SMOKES = [
  'scripts/channels/runtime-identity.mjs',
  'scripts/channels/browser-smoke.mjs',
  'scripts/channels/electron-smoke.mjs'
];

describe('#291: release-channel row locator is shared and depth-independent', () => {
  it('no smoke resolves the channel row by DOM depth', () => {
    for(const rel of SMOKES) {
      // A `../..` locator depends on how many elements `Row` happens to wrap
      // the zero-size radio input in — that is not part of any contract.
      expect(codeOf(read(rel)), `${rel} must not locate by parent depth`).not.toMatch(/locator\(\s*['"]\.\.\/\.\.['"]\s*\)/);
    }
  });

  it('the shared helper derives the row from an ancestor label, not a parent hop', () => {
    const src = read('scripts/channels/runtime-identity.mjs');
    expect(src).toContain('export const releaseChannelRow');
    expect(src).toContain(
      '.locator(\'xpath=ancestor::label[contains(concat(" ", normalize-space(@class), " "), " row ")][1]\');'
    );
  });

  it('openChannelSettings waits on the shared row helper', () => {
    const src = read('scripts/channels/runtime-identity.mjs');
    const fn = src.slice(src.indexOf('export async function openChannelSettings'));
    expect(fn).toContain("await releaseChannelRow(page, 'Stable').waitFor();");
  });

  it('both smokes click the row through the shared helper', () => {
    const browser = read('scripts/channels/browser-smoke.mjs');
    const electron = read('scripts/channels/electron-smoke.mjs');
    // browser-smoke had two raw `../..` clicks of its own.
    expect(browser).toContain("releaseChannelRow(page, 'Preview').click()");
    expect(browser).toContain("releaseChannelRow(page, 'Stable').click()");
    // electron-smoke keeps local aliases, but they must come from the helper.
    expect(electron).toContain('const channelRow = (name) => releaseChannelRow(page, name);');
    expect(electron).toContain('const radioIn = (name) => releaseChannelRadio(page, name);');
  });
});
