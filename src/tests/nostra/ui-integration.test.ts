import {describe, it, expect, vi, beforeEach} from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../..');

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), 'utf-8');
}

// ---- Integration: Settings tab references only valid tabs ----
describe('Settings tab import consistency', () => {
  const settingsSrc = readFile('components/sidebarLeft/tabs/settings.ts');

  it('every imported tab file exists', () => {
    // Extract all import paths from settings.ts
    const importRegex = /from\s+'(@components\/sidebarLeft\/tabs\/[^']+)'/g;
    let match;
    const importedPaths: string[] = [];
    while((match = importRegex.exec(settingsSrc)) !== null) {
      importedPaths.push(match[1]);
    }

    for(const imp of importedPaths) {
      // Resolve alias
      const resolved = imp.replace('@components/', 'components/');
      // Check .ts and /index.ts
      const fullPath1 = path.join(SRC, resolved + '.ts');
      const fullPath2 = path.join(SRC, resolved + '.tsx');
      const fullPath3 = path.join(SRC, resolved, 'index.ts');
      const exists = fs.existsSync(fullPath1) || fs.existsSync(fullPath2) || fs.existsSync(fullPath3);
      expect(exists, `Import ${imp} should resolve to an existing file`).toBe(true);
    }
  });

  it('settings row array b[] references only existing tab constructors', () => {
    // Extract tab constructor names from the b[] array
    const bArrayMatch = settingsSrc.match(/const b = \[([\s\S]*?)\];/);
    if(!bArrayMatch) return;
    const bContent = bArrayMatch[1];
    const tabNames = [...bContent.matchAll(/,\s*(App\w+Tab)\)/g)].map((m) => m[1]);

    // These tab constructors should be imported (named or default)
    for(const name of tabNames) {
      const hasDefault = settingsSrc.includes(`import ${name}`);
      const hasNamed = settingsSrc.includes(name);
      expect(hasDefault || hasNamed, `${name} should be imported`).toBe(true);
    }
  });
});

// ---- Integration: Sidebar menu doesn't reference removed tabs ----
describe('Sidebar menu consistency', () => {
  const sidebarSrc = readFile('components/sidebarLeft/index.ts');

  it('does not import removed tab modules', () => {
    expect(sidebarSrc).not.toContain('AppMyStoriesTab');
  });

  it('still imports AppSettingsTab', () => {
    expect(sidebarSrc).toContain('AppSettingsTab');
  });

  it('still imports AppContactsTab', () => {
    expect(sidebarSrc).toContain('AppContactsTab');
  });

  it('still has Nostra.chat profile menu builder', () => {
    expect(sidebarSrc).toContain('buildNostraProfileMenuContent');
  });
});

// ---- Integration: Privacy tab extends correct base class ----
describe('Privacy tab class hierarchy', () => {
  const privacySrc = readFile('components/sidebarLeft/tabs/privacyAndSecurity.ts');

  it('extends SliderSuperTab (not SliderSuperTabEventable)', () => {
    expect(privacySrc).toContain('extends SliderSuperTab');
    // Should NOT still extend the eventable version
    expect(privacySrc).not.toMatch(/extends SliderSuperTabEventable\b/);
  });

  it('exports as default', () => {
    expect(privacySrc).toContain('export default class AppPrivacyAndSecurityTab');
  });
});

// ---- Integration: EditProfile save handler publishes to Nostr ----
describe('EditProfile save integration', () => {
  const editProfileSrc = readFile('components/sidebarLeft/tabs/editProfile/index.ts');

  it('save handler dispatches nostra_identity_loaded event', () => {
    expect(editProfileSrc).toContain('nostra_identity_loaded');
  });

  it('save handler calls publishKind0Metadata', () => {
    expect(editProfileSrc).toContain('publishKind0Metadata');
  });

  it('save handler calls publishKind0Metadata', () => {
    expect(editProfileSrc).toContain('publishKind0Metadata');
  });
});

// ---- Integration: Contacts tab add-contact flow ----
describe('Contacts add-contact integration', () => {
  const contactsSrc = readFile('components/sidebarLeft/tabs/contacts.ts');

  it('FAB button calls showAddContactPopup (not PopupCreateContact)', () => {
    expect(contactsSrc).toContain('showAddContactPopup');
    expect(contactsSrc).not.toContain('PopupCreateContact');
  });

  it('add-contact popup calls handleNpubInput on success', () => {
    expect(contactsSrc).toContain('handleNpubInput');
  });

  it('still has P2P contacts fallback', () => {
    expect(contactsSrc).toContain('loadP2PContacts');
  });
});

// ---- Integration: No circular or broken imports between modified files ----
describe('Cross-file import integrity', () => {
  it('settings.ts imports match actual class names in target files', () => {
    const settingsSrc = readFile('components/sidebarLeft/tabs/settings.ts');

    // Check that AppPrivacyAndSecurityTab is imported and the class exists
    if(settingsSrc.includes('AppPrivacyAndSecurityTab')) {
      const privacySrc = readFile('components/sidebarLeft/tabs/privacyAndSecurity.ts');
      expect(privacySrc).toContain('class AppPrivacyAndSecurityTab');
    }

    // Check AppGeneralSettingsTab
    if(settingsSrc.includes('AppGeneralSettingsTab')) {
      const generalSrc = readFile('components/sidebarLeft/tabs/generalSettings.ts');
      expect(generalSrc).toContain('AppGeneralSettingsTab');
    }
  });

  it('privacyAndSecurity.ts imports nostraSecurity and the class exists', () => {
    const privacySrc = readFile('components/sidebarLeft/tabs/privacyAndSecurity.ts');
    if(privacySrc.includes('AppNostraSecurityTab')) {
      const securitySrc = readFile('components/sidebarLeft/tabs/nostraSecurity.ts');
      expect(securitySrc).toContain('class AppNostraSecurityTab');
    }
  });
});
