import 'fake-indexeddb/auto';
import {describe, it, expect, beforeEach, vi} from 'vitest';

// Polyfill browser APIs unavailable in jsdom (needed by transitive imports).
// vi.hoisted runs before any import resolution.
vi.hoisted(() => {
  if(typeof globalThis.IntersectionObserver === 'undefined') {
    (globalThis as any).IntersectionObserver = class {
      constructor(_cb: any, _opts?: any) {}
      observe() {} unobserve() {} disconnect() {} takeRecords(): any[] { return []; }
    };
  }
  if(typeof globalThis.ResizeObserver === 'undefined') {
    (globalThis as any).ResizeObserver = class {
      constructor(_cb: any) {}
      observe() {} unobserve() {} disconnect() {}
    };
  }
});

// Mock heavy UI dependencies that rely on browser APIs unavailable in jsdom
vi.mock('@environment/webpSupport', () => ({default: false}));
vi.mock('@components/animationIntersector', () => ({
  default: {addAnimation: vi.fn(), removeAnimation: vi.fn(), checkAnimations: vi.fn(), setOnlyOnePlayableGroup: vi.fn(), lockGroup: vi.fn(), unlockGroup: vi.fn(), refreshGroup: vi.fn()}
}));
vi.mock('@lib/customEmoji/renderer', () => {
  const el = class extends HTMLElement {};
  return {CustomEmojiRendererElement: el, default: {}};
});
vi.mock('@lib/richTextProcessor/wrapRichText', () => ({
  default: vi.fn(),
  createCustomFiller: vi.fn().mockReturnValue(document.createTextNode('')),
  insertCustomFillers: vi.fn()
}));
vi.mock('@components/wrappers/sticker', () => ({default: vi.fn()}));

// Mock key-storage to prevent cross-test pollution from shared fake-indexeddb
const mockLoadEncrypted = vi.fn().mockResolvedValue(null);
const mockSaveEncrypted = vi.fn().mockResolvedValue(undefined);
const mockSaveBrowserKey = vi.fn().mockResolvedValue(undefined);
vi.mock('@lib/nostra/key-storage', () => ({
  loadEncryptedIdentity: (...args: any[]) => mockLoadEncrypted(...args),
  saveEncryptedIdentity: (...args: any[]) => mockSaveEncrypted(...args),
  saveBrowserKey: (...args: any[]) => mockSaveBrowserKey(...args),
  generateBrowserScopedKey: vi.fn().mockResolvedValue(new Uint8Array(32)),
  encryptKeys: vi.fn().mockResolvedValue({iv: 'mock-iv', ciphertext: 'mock-cipher'})
}));

// Mock migration to prevent cross-test pollution
const mockNeedsMigration = vi.fn().mockResolvedValue(false);
vi.mock('@lib/nostra/migration', () => ({
  needsMigration: (...args: any[]) => mockNeedsMigration(...args),
  migrateOwnIdToNpub: vi.fn().mockResolvedValue({migrated: false})
}));

// Mock MTProtoMessagePort
vi.mock('@lib/mainWorker/mainMessagePort', () => ({
  default: {
    getInstance: () => ({
      invokeVoid: () => {}
    })
  }
}));

// Mock navigator.clipboard
Object.defineProperty(navigator, 'clipboard', {
  value: {writeText: vi.fn()},
  writable: true,
  configurable: true
});

import {NostraOnboarding} from '@/pages/nostra/onboarding';

/** Helper: find a button by its text content */
function findButton(container: HTMLElement, text: string): HTMLButtonElement | null {
  const buttons = container.querySelectorAll('button');
  for(const btn of buttons) {
    if(btn.textContent === text) return btn;
  }
  return null;
}

describe('NostraOnboarding (npub-based)', () => {
  let onboarding: NostraOnboarding;

  beforeEach(() => {
    // Clean up DOM
    document.body.innerHTML = '';
    // Reset mocks to default (no existing identity, no migration)
    mockLoadEncrypted.mockResolvedValue(null);
    mockNeedsMigration.mockResolvedValue(false);
    onboarding = new NostraOnboarding();
  });

  afterEach(() => {
    onboarding.destroy();
  });

  describe('Welcome screen', () => {
    it('shows two buttons: Create New Identity and Import Seed Phrase', async() => {
      await onboarding.init();

      const createBtn = findButton(onboarding.container, 'Create New Identity');
      const importBtn = findButton(onboarding.container, 'Import Seed Phrase');

      expect(createBtn).not.toBeNull();
      expect(importBtn).not.toBeNull();
    });

    it('does not reference OwnID in the UI', async() => {
      await onboarding.init();
      const html = onboarding.container.innerHTML;
      expect(html).not.toContain('OwnID');
      expect(html).not.toContain('ownId');
      // Welcome screen references Nostr concepts (via subtitle or button text)
      expect(html).toContain('Nostr');
    });
  });

  describe('Create path', () => {
    it('displays npub (not seed phrase) after clicking Create', async() => {
      await onboarding.init();

      // Click Create
      const createBtn = findButton(onboarding.container, 'Create New Identity')!;
      createBtn.click();

      // Should show npub in the nostra-npub-value element
      const npubDisplay = onboarding.container.querySelector('.nostra-npub-value');
      expect(npubDisplay).not.toBeNull();
      expect(npubDisplay!.textContent!.startsWith('npub1')).toBe(true);

      // Should NOT show seed phrase or nsec
      const html = onboarding.container.innerHTML;
      expect(html).not.toContain('nsec1');
    });

    it('shows Continue button after Create', async() => {
      await onboarding.init();
      const createBtn = findButton(onboarding.container, 'Create New Identity')!;
      createBtn.click();

      const continueBtn = findButton(onboarding.container, 'Continue');
      expect(continueBtn).not.toBeNull();
    });
  });

  describe('Import path', () => {
    it('shows 12 input fields for seed phrase', async() => {
      await onboarding.init();

      const importBtn = findButton(onboarding.container, 'Import Seed Phrase')!;
      importBtn.click();

      const inputs = onboarding.container.querySelectorAll('.nostra-seed-input');
      expect(inputs.length).toBe(12);
    });

    it('shows Back button to return to welcome', async() => {
      await onboarding.init();

      const importBtn = findButton(onboarding.container, 'Import Seed Phrase')!;
      importBtn.click();

      const backBtn = findButton(onboarding.container, 'Back');
      expect(backBtn).not.toBeNull();

      backBtn!.click();

      // Should be back at welcome
      expect(findButton(onboarding.container, 'Create New Identity')).not.toBeNull();
    });

    it('Continue button is disabled until valid mnemonic entered', async() => {
      await onboarding.init();

      const importBtn = findButton(onboarding.container, 'Import Seed Phrase')!;
      importBtn.click();

      const continueBtn = findButton(onboarding.container, 'Continue')!;
      expect(continueBtn.disabled).toBe(true);
    });
  });

  describe('Migration', () => {
    it('runs silently before onboarding if old identity exists', async() => {
      // Mock migration to simulate existing old identity
      mockNeedsMigration.mockResolvedValueOnce(true);
      const {migrateOwnIdToNpub} = await import('@lib/nostra/migration');
      (migrateOwnIdToNpub as any).mockResolvedValueOnce({migrated: true});

      let identityCreated = false;
      onboarding.onIdentityCreated = () => { identityCreated = true; };

      await onboarding.init();

      // Should skip onboarding UI and trigger identity created
      expect(identityCreated).toBe(true);
    });
  });
});

