/*
 * Tests for the Status tab "About / App version" section and the
 * Italian → English translation of the Status + Relay settings menus.
 *
 * Background: the Status menu and Relay settings tab shipped with several
 * hardcoded Italian strings (Impostazioni, Preferenze, Aggiungi, connessi…),
 * and there was no in-app way to see the running version or trigger an
 * update on demand — the only update affordance was a hidden floating button
 * that polled every 30 min. This adds an explicit version + "Check for
 * updates" row that polls `version` immediately on tap and reloads when a
 * newer build is found.
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

  it('has a "Check for updates" row that polls version on tap', () => {
    expect(statusSrc).toMatch(/Check for updates/);
    // Immediate poll of the version endpoint inside the click handler.
    expect(statusSrc).toMatch(/fetch\('version',\s*\{cache:\s*'no-cache'\}\)/);
  });

  it('reloads the app when a newer version is found', () => {
    // The row flips to "Update now" and reload is wired to the nav controller.
    expect(statusSrc).toMatch(/Update now/);
    expect(statusSrc).toMatch(/appNavigationController\.reload\(\)/);
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
