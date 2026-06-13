/*
 * Regression test for the "Privacy and Security → PIN / Passphrase" empty-tab bug.
 *
 * Before the fix, AppNostraSecurityTab.init() constructed Row with
 *   checkboxField: {round: true, name: ..., checked: ...}
 * Row expects `checkboxField` to be a real CheckboxField instance and reads
 * `.label.classList.contains(...)` on it (row.ts:146), throwing a TypeError.
 * The error was swallowed by SliderSuperTab.open()'s try/catch (sliderTab.ts:95),
 * so the tab opened with only its header — "non si visualizza nulla".
 *
 * The correct key is `checkboxFieldOptions`, which Row auto-wraps into a real
 * CheckboxField instance (row.ts:99-104).
 */
import {describe, it, expect} from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../..');

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), 'utf-8');
}

describe('nostraSecurity tab — Row construction for protection picker', () => {
  const nostraSecuritySrc = readFile('components/sidebarLeft/tabs/nostraSecurity.ts');
  const rowSrc = readFile('components/row.ts');

  it('Row accesses .label.classList on checkboxField, so a plain object would throw', () => {
    // Establish the precondition that makes the bug repro real:
    // if Row receives `checkboxField: {plain object}`, it crashes on this line.
    expect(rowSrc).toMatch(/options\.checkboxField\.label\.classList\.contains/);
  });

  it('Row auto-wraps `checkboxFieldOptions` into a real CheckboxField instance', () => {
    // This is the code path the fix relies on.
    expect(rowSrc).toMatch(/options\.checkboxFieldOptions[\s\S]{0,80}new CheckboxField/);
  });

  it('(bug repro) nostraSecurity.ts must NOT pass a plain options object as `checkboxField`', () => {
    // Before the fix this matches line ~61 and Row throws at runtime.
    expect(nostraSecuritySrc).not.toMatch(/checkboxField:\s*\{\s*round:\s*true/);
  });

  it('(fix) nostraSecurity.ts passes the protection picker options as `checkboxFieldOptions`', () => {
    expect(nostraSecuritySrc).toMatch(/checkboxFieldOptions:\s*\{\s*round:\s*true/);
  });

  it('init() still appends all sections so the tab is not empty', () => {
    // Guard against future regressions where init() throws mid-way and the
    // final scrollable.append(...) is never reached.
    expect(nostraSecuritySrc).toMatch(
      /this\.scrollable\.append\(\s*protectionSection\.container,\s*recoverySection\.container\s*\)/
    );
  });
});
