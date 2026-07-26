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

  it('settings.ts still imports PhantomChat.chat tabs', () => {
    expect(settingsSrc).toContain('AppPhantomChatRelaySettingsTab');
    expect(settingsSrc).toContain('AppEditProfileTab');
  });

  it('sidebar does not have MyStories menu item', () => {
    expect(sidebarSrc).not.toContain("'MyStories.Title'");
  });

  it('sidebar does not have Switch to A menu item', () => {
    expect(sidebarSrc).not.toContain('ChatList.Menu.SwitchTo.A');
  });

  it('sidebar does not have TelegramFeatures link', () => {
    expect(sidebarSrc).not.toContain('PhantomChatFeatures');
  });

  it('sidebar report bug uses showReportBugPopup (URL in reportBug.ts)', () => {
    expect(sidebarSrc).toContain('showReportBugPopup');
    expect(sidebarSrc).not.toContain('bugs.telegram.org');
  });
});

// ---- Basic search + Add Folder UX ----
describe('sidebar search is stripped to basics', () => {
  const sidebarSrc = readFile('components/sidebarLeft/index.ts');

  it('does not mount the relay/connection status icons in the search bar', () => {
    expect(sidebarSrc).not.toContain('mountStatusIcons');
    expect(sidebarSrc).not.toContain('SearchBarStatusIcons');
  });

  it('does not use the chat-type (all/private/groups) search submenu', () => {
    expect(sidebarSrc).not.toContain('ChatTypeMenu');
    expect(sidebarSrc).not.toContain('chatTypeMenu');
  });

  it('search has only the single chats tab (no media/links/files/music/voice tabs)', () => {
    expect(sidebarSrc).toContain('inputMessagesFilterEmpty');
    expect(sidebarSrc).not.toContain('inputMessagesFilterPhotoVideo');
    expect(sidebarSrc).not.toContain('inputMessagesFilterUrl');
    expect(sidebarSrc).not.toContain('inputMessagesFilterDocument');
    expect(sidebarSrc).not.toContain('inputMessagesFilterMusic');
    expect(sidebarSrc).not.toContain('inputMessagesFilterRoundVoice');
  });
});

describe('sidebar add-menu has an Add Folder option', () => {
  const sidebarSrc = readFile('components/sidebarLeft/index.ts');

  it('wires a New Folder item to the edit-folder tab', () => {
    expect(sidebarSrc).toContain("text: 'FilterNew'");
    expect(sidebarSrc).toContain('this.createTab(AppEditFolderTab).open()');
  });
});

// ---- Local entity search (Chats/Contacts/Groups/Folders/Settings) ----
describe('sidebar search is local-entity search, not message search', () => {
  const sidebarSrc = readFile('components/sidebarLeft/index.ts');
  const superSrc = readFile('components/appSearchSuper.ts');

  it('sidebar disables message-content search', () => {
    expect(sidebarSrc).toContain('disableMessageSearch: true');
  });

  it('sidebar no longer has message / global-directory search groups', () => {
    expect(sidebarSrc).not.toContain('SearchMessages');
    expect(sidebarSrc).not.toContain('GlobalSearch');
    expect(sidebarSrc).not.toContain('EmptySearchPlaceholder');
  });

  it('sidebar groups results into chats/contacts/groups/folders/settings', () => {
    for(const key of ['chats:', 'contacts:', 'groups:', 'folders:', 'settings:']) {
      expect(sidebarSrc).toContain(key);
    }
  });

  it('sidebar hides the single-tab nav (removes the Chats tab)', () => {
    expect(sidebarSrc).toContain("searchSuper.nav.classList.add('hide')");
  });

  it('sidebar supplies settings entries and a navigate-and-close callback', () => {
    expect(sidebarSrc).toContain('SearchSettingsEntry');
    expect(sidebarSrc).toContain('settingsEntries');
    expect(sidebarSrc).toContain('onResultNavigate: close');
  });

  it('appSearchSuper skips message search when disableMessageSearch is set', () => {
    expect(superSrc).toContain('this.disableMessageSearch');
  });

  it('appSearchSuper renders folder and settings results', () => {
    expect(superSrc).toContain('renderFolderResults');
    expect(superSrc).toContain('renderSettingsResults');
  });

  it('folder result navigates via the folder-switch event', () => {
    expect(superSrc).toContain("'changing_folder_from_sidebar'");
  });
});

// ---- WS-B: Identity integrated into EditProfile ----
describe('WS-B: Identity in EditProfile', () => {
  const editProfileSrc = readFile('components/sidebarLeft/tabs/editProfile/index.ts');

  it('imports usePhantomChatIdentity', () => {
    expect(editProfileSrc).toContain('usePhantomChatIdentity');
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
describe('WS-D: Privacy & Security for PhantomChat.chat', () => {
  const privacySrc = readFile('components/sidebarLeft/tabs/privacyAndSecurity.ts');

  it('does not import MTProto privacy tabs', () => {
    expect(privacySrc).not.toContain('AppPrivacyPhoneNumberTab');
    expect(privacySrc).not.toContain('AppPrivacyLastSeenTab');
    expect(privacySrc).not.toContain('AppTwoStepVerificationTab');
    expect(privacySrc).not.toContain('AppPrivacyCallsTab');
  });

  it('imports PhantomChat.chat security tab', () => {
    expect(privacySrc).toContain('AppPhantomChatSecurityTab');
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


// ---- Onboarding uses tweb components ----
describe('Onboarding uses tweb components', () => {
  const onboardingSrc = readFile('pages/phantomchat/onboarding.ts');
  const onboardingCss = readFile('pages/phantomchat/onboarding.css');

  it('imports tweb Button component', () => {
    expect(onboardingSrc).toContain("from '@components/button'");
  });

  it('imports tweb InputField component', () => {
    expect(onboardingSrc).toContain("from '@components/inputField'");
  });

  it('does not use phantomchat-onboarding-wrapper class', () => {
    expect(onboardingSrc).not.toContain('phantomchat-onboarding-wrapper');
  });

  it('uses phantomchat-onboarding class (no wrapper)', () => {
    expect(onboardingSrc).toContain("'phantomchat-onboarding'");
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

// ---- Integration: PHANTOMCHAT_STATIC has notification stub ----
describe('Integration: apiManager PHANTOMCHAT_STATIC', () => {
  const apiManagerSrc = readFile('lib/appManagers/apiManager.ts');

  it('has PHANTOMCHAT_STATIC map in apiManager', () => {
    expect(apiManagerSrc).toContain('PHANTOMCHAT_STATIC');
  });

  it('has account.getPrivacy in PHANTOMCHAT_STATIC', () => {
    expect(apiManagerSrc).toContain('account.getPrivacy');
  });
});

// ---- WS-F: Delete Account performs a full local wipe ----
describe('WS-F: Delete Account', () => {
  const privacySrc = readFile('components/sidebarLeft/tabs/privacyAndSecurity.ts');
  const resetSrc = readFile('components/popups/resetLocalData.ts');

  it('routes through showDeleteAccountPopup, not a naive single-DB delete', () => {
    expect(privacySrc).toContain('showDeleteAccountPopup');
    // Regression: the old handler did an un-awaited delete of only the identity DB,
    // which was blocked by the SharedWorker's open connections and raced by reload.
    expect(privacySrc).not.toContain("indexedDB.deleteDatabase('PhantomChat.chat')");
  });

  it('deletes the identity via logOut (worker context) with keepPhantomChatIdentity:false', () => {
    expect(resetSrc).toContain('showDeleteAccountPopup');
    expect(resetSrc).toContain('keepPhantomChatIdentity: false');
  });
});
