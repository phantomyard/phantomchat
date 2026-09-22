/*
 * Desktop-entry Exec token escaping (issue #150 PR#1 review).
 *
 * The AppImage path lands raw in the Exec= field of the generated
 * .desktop file — verify the escaping survives spaces, quotes, backticks,
 * dollars and percent (field-code) characters, per the Desktop Entry
 * Specification.
 */
import {describe, it, expect} from 'vitest';
import {execTokenForDesktopEntry} from './desktopIntegration';

describe('execTokenForDesktopEntry', () => {
  it('quotes paths with spaces as a single argument', () => {
    expect(execTokenForDesktopEntry('/home/u/Applications/PhantomChat Preview.AppImage'))
      .toBe('"/home/u/Applications/PhantomChat Preview.AppImage"');
  });

  it('escapes backslash, double quote, backtick and dollar inside the quotes', () => {
    expect(execTokenForDesktopEntry('/tmp/a"b\\c`d$e.AppImage'))
      .toBe('"/tmp/a\\"b\\\\c\\`d\\$e.AppImage"');
  });

  it('doubles % so it is never parsed as a desktop-entry field code', () => {
    expect(execTokenForDesktopEntry('/tmp/100%f.AppImage'))
      .toBe('"/tmp/100%%f.AppImage"');
  });

  it('leaves a plain path unchanged apart from the wrapping quotes', () => {
    expect(execTokenForDesktopEntry('/opt/PhantomChat.AppImage'))
      .toBe('"/opt/PhantomChat.AppImage"');
  });
});
