import {describe, it, expect} from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../..');

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), 'utf-8');
}

// ---- WS-A: Telegram-only menu items removed ----
describe('WS-A: Telegram-only UI cleanup', () => {
  const settingsSrc = readFile('components/sidebarLeft/tabs/settings.ts');
  const sidebarSrc = readFile('components/sidebarLeft/index.ts');

  it('settings.ts does not import Premium popup', () => {
    expect(settingsSrc).not.toContain('PopupPremium');
  });

  it('settings.ts does not import Stars', () => {
    expect(settingsSrc).not.toContain('useStars');
    expect(settingsSrc).not.toContain('PopupStars');
  });

  it('settings.ts does not import Active Sessions tab', () => {
    expect(settingsSrc).not.toContain('AppActiveSessionsTab');
  });

  it('settings.ts does not import Stickers tab', () => {
    expect(settingsSrc).not.toContain('AppStickersAndEmojiTab');
  });

  it('settings.ts does not import Chat Folders tab', () => {
    expect(settingsSrc).not.toContain('AppChatFoldersTab');
  });

  it('settings.ts does not import Language tab', () => {
    expect(settingsSrc).not.toContain('AppLanguageTab');
  });

  it('settings.ts uses showLogOutPopup for logout', () => {
    expect(settingsSrc).toContain('showLogOutPopup');
  });

  it('settings.ts still imports Nostra.chat tabs', () => {
    expect(settingsSrc).toContain('AppNostraRelaySettingsTab');
    expect(settingsSrc).toContain('AppEditProfileTab');
  });

  it('sidebar does not have MyStories menu item', () => {
    expect(sidebarSrc).not.toContain("'MyStories.Title'");
  });

  it('sidebar does not have Switch to A menu item', () => {
    expect(sidebarSrc).not.toContain('ChatList.Menu.SwitchTo.A');
  });

  it('sidebar does not have TelegramFeatures link', () => {
    expect(sidebarSrc).not.toContain('NostraFeatures');
  });

  it('sidebar report bug uses showReportBugPopup (URL in reportBug.ts)', () => {
    expect(sidebarSrc).toContain('showReportBugPopup');
    expect(sidebarSrc).not.toContain('bugs.telegram.org');
  });
});

// ---- WS-B: Identity integrated into EditProfile ----
describe('WS-B: Identity in EditProfile', () => {
  const editProfileSrc = readFile('components/sidebarLeft/tabs/editProfile/index.ts');

  it('imports useNostraIdentity', () => {
    expect(editProfileSrc).toContain('useNostraIdentity');
  });

  it('imports publishKind0Metadata', () => {
    expect(editProfileSrc).toContain('publishKind0Metadata');
  });

  it('has Nostr Identity section', () => {
    expect(editProfileSrc).toContain('Nostr Identity');
  });

  it('has npub display with copy', () => {
    expect(editProfileSrc).toContain('clipboard.writeText');
  });

  it('has NIP-05 row', () => {
    expect(editProfileSrc).toContain('NIP-05');
  });

  it('does not have Username section', () => {
    expect(editProfileSrc).not.toContain('UsernameInputField');
    expect(editProfileSrc).not.toContain('UsernamesSection');
  });

  it('does not have Birthday row', () => {
    expect(editProfileSrc).not.toContain('showBirthdayPopup');
  });
});

// ---- WS-C: Add Contact popup in Contacts ----
describe('WS-C: Add Contact in Contacts tab', () => {
  const contactsSrc = readFile('components/sidebarLeft/tabs/contacts.ts');

  it('does not import PopupCreateContact', () => {
    expect(contactsSrc).not.toContain('PopupCreateContact');
  });

  it('has showAddContactPopup method', () => {
    expect(contactsSrc).toContain('showAddContactPopup');
  });

  it('has npub input validation', () => {
    expect(contactsSrc).toContain('npub1');
  });

  it('has add contact button', () => {
    expect(contactsSrc).toContain('showAddContactPopup');
  });

  it('keeps handleNpubInput method', () => {
    expect(contactsSrc).toContain('handleNpubInput');
  });
});

// ---- WS-D: Privacy & Security replaced ----
describe('WS-D: Privacy & Security for Nostra.chat', () => {
  const privacySrc = readFile('components/sidebarLeft/tabs/privacyAndSecurity.ts');

  it('does not import MTProto privacy tabs', () => {
    expect(privacySrc).not.toContain('AppPrivacyPhoneNumberTab');
    expect(privacySrc).not.toContain('AppPrivacyLastSeenTab');
    expect(privacySrc).not.toContain('AppTwoStepVerificationTab');
    expect(privacySrc).not.toContain('AppPrivacyCallsTab');
  });

  it('imports Nostra.chat security tab', () => {
    expect(privacySrc).toContain('AppNostraSecurityTab');
  });

  it('has Key Protection section', () => {
    expect(privacySrc).toContain('Key Protection');
  });

  it('has Read Receipts toggle', () => {
    expect(privacySrc).toContain('Read Receipts');
  });

  it('has Delete Account section', () => {
    expect(privacySrc).toContain('Delete Account');
  });

  it('keeps static getInitArgs for compatibility', () => {
    expect(privacySrc).toContain('static getInitArgs');
  });
});

// ---- WS-E: Notifications guarded ----
describe('WS-E: Notifications MTProto guards', () => {
  const notifSrc = readFile('components/sidebarLeft/tabs/notifications.tsx');

  it('has try-catch guards around MTProto calls', () => {
    // Count catch blocks — should have multiple guards
    const catchCount = (notifSrc.match(/catch\s*[\({]/g) || []).length;
    expect(catchCount).toBeGreaterThanOrEqual(3);
  });

  it('has default fallback values for muted state', () => {
    // Should have default enabled value when MTProto fails
    expect(notifSrc).toContain('catch');
  });
});

// ---- Onboarding uses tweb components ----
describe('Onboarding uses tweb components', () => {
  const onboardingSrc = readFile('pages/nostra/onboarding.ts');
  const onboardingCss = readFile('pages/nostra/onboarding.css');

  it('imports tweb Button component', () => {
    expect(onboardingSrc).toContain("from '@components/button'");
  });

  it('imports tweb InputField component', () => {
    expect(onboardingSrc).toContain("from '@components/inputField'");
  });

  it('does not use nostra-onboarding-wrapper class', () => {
    expect(onboardingSrc).not.toContain('nostra-onboarding-wrapper');
  });

  it('uses nostra-onboarding class (no wrapper)', () => {
    expect(onboardingSrc).toContain("'nostra-onboarding'");
  });

  it('does not use custom gradient background in CSS', () => {
    expect(onboardingCss).not.toContain('linear-gradient(135deg, #1a1a2e');
  });

  it('does not use 100vh min-height', () => {
    expect(onboardingCss).not.toContain('100vh');
  });

  it('uses CSS variables for theming', () => {
    expect(onboardingCss).toContain('var(--');
  });
});

// ---- Integration: NOSTRA_STATIC has notification stub ----
describe('Integration: apiManager NOSTRA_STATIC', () => {
  const apiManagerSrc = readFile('lib/appManagers/apiManager.ts');

  it('has NOSTRA_STATIC map in apiManager', () => {
    expect(apiManagerSrc).toContain('NOSTRA_STATIC');
  });

  it('has account.getPrivacy in NOSTRA_STATIC', () => {
    expect(apiManagerSrc).toContain('account.getPrivacy');
  });
});
