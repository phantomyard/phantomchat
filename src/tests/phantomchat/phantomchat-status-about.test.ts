/*
 * Tests for the Status tab "About / App version" section and the
 * Italian → English translation of the Status + Relay settings menus.
 *
 * Background: the Status menu and Relay settings tab shipped with several
 * hardcoded Italian strings (Impostazioni, Preferenze, Aggiungi, connessi…),
 * and there was no in-app way to see the running version. The Status tab now
 * shows a read-only Version row only. The old "Check for updates" row was
 * removed (#165 follow-up): on desktop it duplicated the Settings → Desktop
 * updater, and on the PWA it was redundant — the app updates on reload and
 * already surfaces an update banner via the update-checker.
 */
import {describe, it, expect} from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../..');

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), 'utf-8');
}

// Distinctive Italian tokens that must no longer appear in the UI strings.
const ITALIAN_TOKENS = [
  'Impostazioni',
  'Preferenze',
  'Aggiungi',
  'Gestisci',
  'Abilita',
  'Ripristina',
  'connessi',
  'Nessun relay',
  'predefinit',
  'I tuoi relay',
  'Usa solo'
];

describe('phantomchatStatus tab — About / version section', () => {
  const statusSrc = readFile('components/sidebarLeft/tabs/phantomchatStatus.ts');

  it('renders an About section with the app version', () => {
    expect(statusSrc).toMatch(/name:\s*'About'/);
    expect(statusSrc).toMatch(/PhantomChat \$\{currentVersion\}/);
    expect(statusSrc).toMatch(/App\.versionFull/);
  });

  it('has no manual update row (PWA banner + desktop Settings own updates)', () => {
    // Guard against the row drifting back: the PWA updates on reload with a
    // banner, desktop updates live in Settings → Desktop.
    expect(statusSrc).not.toMatch(/Check for updates/);
    expect(statusSrc).not.toMatch(/Update now/);
    expect(statusSrc).not.toMatch(/fetch\('version'/);
    expect(statusSrc).not.toMatch(/appNavigationController/);
  });

  it('appends the About section to the scrollable', () => {
    expect(statusSrc).toMatch(/aboutSection\.container/);
  });

  it('contains no Italian UI strings', () => {
    for(const token of ITALIAN_TOKENS) {
      expect(statusSrc).not.toContain(token);
    }
  });
});

describe('phantomchatRelaySettings tab — English strings', () => {
  const relaySrc = readFile('components/sidebarLeft/tabs/phantomchatRelaySettings.ts');

  it('contains no Italian UI strings', () => {
    for(const token of ITALIAN_TOKENS) {
      expect(relaySrc).not.toContain(token);
    }
  });

  it('uses the translated English labels', () => {
    expect(relaySrc).toMatch(/name:\s*'Preferences'/);
    expect(relaySrc).toMatch(/title:\s*'Use only my relays'/);
    expect(relaySrc).toMatch(/name:\s*'Add relay'/);
    expect(relaySrc).toMatch(/connected`/);
  });
});
