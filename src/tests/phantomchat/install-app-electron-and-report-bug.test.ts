import {describe, it, expect} from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../..');

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), 'utf-8');
}

// Install App must stay hidden inside the packaged Electron app, where it has
// no meaning (the PWA install prompt only exists in a browser).
describe('Install App is hidden on the Electron desktop app', () => {
  const sidebarSrc = readFile('components/sidebarLeft/index.ts');

  it('imports isDesktopApp from the desktop-api', () => {
    expect(sidebarSrc).toContain("import {isDesktopApp} from '@lib/phantomchat/desktop-api'");
  });

  it('guards the PWA.Install menu item with both !IS_STANDALONE and !isDesktopApp()', () => {
    expect(sidebarSrc).toContain('verify: () => !IS_STANDALONE && !isDesktopApp()');
  });
});

// The report-bug popup linked to a repo that 404s, and shipped a dead
// "Reporter npub" diagnostic that read localStorage (identity lives in IDB).
describe('Report Bug popup links to the live repo and drops the dead npub diagnostic', () => {
  const reportBugSrc = readFile('components/popups/reportBug.ts');

  it('points the public GitHub issue link at phantomyard/phantomchat', () => {
    expect(reportBugSrc).toContain('https://github.com/phantomyard/phantomchat/issues/new');
  });

  it('does not reference the dead phantomchat-chat/phantomchat-chat repo', () => {
    expect(reportBugSrc).not.toContain('phantomchat-chat/phantomchat-chat');
  });

  it('does not collect a Reporter npub diagnostic', () => {
    expect(reportBugSrc).not.toContain('Reporter npub');
    expect(reportBugSrc).not.toContain('phantomchat_identity');
  });
});

// The dead URL was referenced from several user-facing surfaces; none should
// still point users at the 404 repo.
describe('dead phantomchat-chat repo URL is gone from user-facing sources', () => {
  const files = [
    'components/sidebarLeft/index.ts',
    'components/popups/reportBug.ts',
    'lang.ts',
    'scripts/out/langPack.strings'
  ];

  for(const file of files) {
    it(`${file} no longer references phantomchat-chat/phantomchat-chat`, () => {
      expect(readFile(file)).not.toContain('phantomchat-chat/phantomchat-chat');
    });
  }

  it('the release-notes footer link points at phantomyard/phantomchat', () => {
    expect(readFile('components/sidebarLeft/index.ts'))
    .toContain('https://github.com/phantomyard/phantomchat/releases/tag/');
  });
});
