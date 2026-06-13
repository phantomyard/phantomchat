/*
 * Nostra.chat Onboarding — tweb auth-page style
 *
 * Uses tweb's Button, InputField, and auth-page layout pattern
 * instead of custom vanilla DOM with gradient background.
 */

import {
  generateNostrIdentity,
  importFromMnemonic,
  validateMnemonic,
  NostrIdentity
} from '@lib/nostra/nostr-identity';
import {
  generateBrowserScopedKey,
  encryptKeys,
  saveEncryptedIdentity,
  saveBrowserKey,
  loadEncryptedIdentity,
  EncryptedIdentityRecord
} from '@lib/nostra/key-storage';
import {needsMigration, migrateOwnIdToNpub} from '@lib/nostra/migration';
import rootScope from '@lib/rootScope';
import Button from '@components/button';
import InputField from '@components/inputField';
import toggleDisability from '@helpers/dom/toggleDisability';
import {putPreloader} from '@components/putPreloader';

import './onboarding.css';
import {generateDicebearAvatar} from '@helpers/generateDicebearAvatar';
import {decodePubkey} from '@lib/nostra/nostr-identity';

type OnboardingStep = 'welcome' | 'create' | 'import' | 'display-name';

export class NostraOnboarding {
  public container: HTMLElement;
  public onIdentityCreated: (() => void) | null = null;

  private currentStep: OnboardingStep = 'welcome';
  private identity: NostrIdentity | null = null;

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'nostra-onboarding';
  }

  public async init(): Promise<void> {
    try {
      if(await needsMigration()) {
        const result = await migrateOwnIdToNpub();
        if(result.migrated) {
          this.notifyIdentityCreated();
          return;
        }
      }
    } catch{}

    try {
      const existing = await loadEncryptedIdentity();
      if(existing) {
        this.notifyIdentityCreated();
        return;
      }
    } catch{}

    this.showWelcome();
  }

  private notifyIdentityCreated(): void {
    window.dispatchEvent(new CustomEvent('nostra-identity-created', {
      detail: {timestamp: Date.now()}
    }));
    if(this.onIdentityCreated) {
      this.onIdentityCreated();
    }
  }

  public navigateToChat(): void {
    this.notifyIdentityCreated();
  }

  // ─── Step 1: Welcome ────────────────────────────────────────────────

  private showWelcome(): void {
    this.currentStep = 'welcome';
    this.container.innerHTML = '';

    const hero = document.createElement('div');
    hero.classList.add('nostra-welcome-hero');

    const logo = document.createElement('img');
    logo.classList.add('nostra-welcome-logo');
    logo.src = 'assets/img/logo_filled_rounded.png?v=jw3mK7G9Ry';
    logo.alt = '';
    logo.width = 88;
    logo.height = 88;

    const title = document.createElement('h1');
    title.classList.add('nostra-welcome-title');
    const accent = document.createElement('span');
    accent.textContent = '.chat';
    title.append(document.createTextNode('Welcome to Nostra'), accent);

    const description = document.createElement('p');
    description.classList.add('nostra-welcome-description');
    description.textContent = 'Private messaging over Nostr. Your keys, your data. No phone number or email required.';

    const divider = document.createElement('div');
    divider.classList.add('nostra-welcome-divider');
    divider.setAttribute('aria-hidden', 'true');

    hero.append(logo, title, description, divider);

    const inputWrapper = document.createElement('div');
    inputWrapper.classList.add('input-wrapper');

    const btnCreate = Button('btn-primary btn-color-primary');
    btnCreate.textContent = 'Create New Identity';
    btnCreate.addEventListener('click', () => this.handleCreate());

    const btnImport = Button('btn-primary btn-secondary btn-primary-transparent primary');
    btnImport.textContent = 'Import Seed Phrase';
    btnImport.addEventListener('click', () => this.showImport());

    inputWrapper.append(btnCreate, btnImport);
    this.container.append(hero, inputWrapper);
  }

  // ─── Step 2a: Create ────────────────────────────────────────────────

  private handleCreate(): void {
    this.identity = generateNostrIdentity();
    this.showCreateResult();
  }

  private showCreateResult(): void {
    this.currentStep = 'create';
    this.container.innerHTML = '';
    const npub = this.identity!.npub;

    const h4 = document.createElement('h4');
    h4.classList.add('text-center');
    h4.textContent = 'Your Identity';

    const subtitle = document.createElement('div');
    subtitle.classList.add('subtitle', 'text-center');
    subtitle.textContent = 'Share your npub with friends to start messaging';

    const npubBox = document.createElement('div');
    npubBox.classList.add('nostra-npub-box');

    const npubLabel = document.createElement('div');
    npubLabel.classList.add('nostra-npub-label');
    npubLabel.textContent = 'YOUR PUBLIC KEY';

    const npubValue = document.createElement('div');
    npubValue.classList.add('nostra-npub-value');
    npubValue.textContent = npub;

    const btnCopy = Button('btn-primary btn-secondary btn-primary-transparent primary');
    btnCopy.textContent = 'Copy npub';
    btnCopy.addEventListener('click', () => {
      navigator.clipboard.writeText(npub);
      btnCopy.textContent = 'Copied!';
      setTimeout(() => {
        btnCopy.textContent = 'Copy npub';
      }, 2000);
    });

    npubBox.append(npubLabel, npubValue, btnCopy);

    const inputWrapper = document.createElement('div');
    inputWrapper.classList.add('input-wrapper');

    const btnNext = Button('btn-primary btn-color-primary');
    btnNext.textContent = 'Continue';
    btnNext.addEventListener('click', () => this.showDisplayName());

    inputWrapper.append(btnNext);
    this.container.append(h4, subtitle, npubBox, inputWrapper);
  }

  // ─── Step 2b: Import ───────────────────────────────────────────────

  private showImport(): void {
    this.currentStep = 'import';
    this.container.innerHTML = '';

    const h4 = document.createElement('h4');
    h4.classList.add('text-center');
    h4.textContent = 'Import Seed Phrase';

    const subtitle = document.createElement('div');
    subtitle.classList.add('subtitle', 'text-center');
    subtitle.textContent = 'Enter your 12-word recovery phrase';

    const grid = document.createElement('div');
    grid.classList.add('nostra-seed-grid');

    const inputs: HTMLInputElement[] = [];
    const fields: HTMLDivElement[] = [];
    const words: string[] = Array(12).fill('');

    for(let i = 0; i < 12; i++) {
      const field = document.createElement('div');
      field.classList.add('nostra-seed-field');

      const label = document.createElement('span');
      label.classList.add('nostra-seed-num');
      label.textContent = String(i + 1);

      const input = document.createElement('input');
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('autocapitalize', 'none');
      input.setAttribute('autocorrect', 'off');
      input.classList.add('nostra-seed-input');

      field.append(label, input);
      grid.append(field);
      inputs.push(input);
      fields.push(field);
    }

    const errorEl = document.createElement('div');
    errorEl.classList.add('nostra-error');

    const inputWrapper = document.createElement('div');
    inputWrapper.classList.add('input-wrapper');

    const btnContinue = Button('btn-primary btn-color-primary');
    btnContinue.textContent = 'Continue';
    btnContinue.disabled = true;

    const btnBack = Button('btn-primary btn-secondary btn-primary-transparent primary');
    btnBack.textContent = 'Back';
    btnBack.addEventListener('click', () => this.showWelcome());

    const updateValidation = () => {
      const mnemonic = words.join(' ').trim();
      const allFilled = words.every(w => w.length > 0);
      const valid = allFilled && validateMnemonic(mnemonic);
      btnContinue.disabled = !valid;
      for(let i = 0; i < 12; i++) {
        fields[i].classList.toggle('is-filled', words[i].length > 0);
      }
      if(allFilled && !valid) {
        errorEl.textContent = 'Invalid seed phrase. Please check your words.';
      } else {
        errorEl.textContent = '';
      }
    };

    inputs.forEach((input, i) => {
      input.addEventListener('input', () => {
        const value = input.value.trim().toLowerCase();
        const pastedWords = value.split(/\s+/);
        if(pastedWords.length === 12 && i === 0) {
          pastedWords.forEach((w, idx) => {
            words[idx] = w;
            inputs[idx].value = w;
          });
          inputs[11].focus();
          updateValidation();
          return;
        }
        if(value.includes(' ')) {
          const word = value.split(' ')[0];
          words[i] = word;
          input.value = word;
          if(i < 11) inputs[i + 1].focus();
          updateValidation();
          return;
        }
        words[i] = value;
        updateValidation();
      });

      input.addEventListener('keydown', (e) => {
        if(e.key === ' ' && words[i].length > 0) {
          e.preventDefault();
          if(i < 11) inputs[i + 1].focus();
        }
        if(e.key === 'Backspace' && words[i] === '' && i > 0) {
          e.preventDefault();
          inputs[i - 1].focus();
        }
      });
    });

    btnContinue.addEventListener('click', () => {
      const mnemonic = words.join(' ').trim();
      try {
        this.identity = importFromMnemonic(mnemonic);
        this.showDisplayName();
      } catch(err) {
        errorEl.textContent = 'Failed to import: ' + (err as Error).message;
      }
    });

    inputWrapper.append(btnContinue, btnBack);
    this.container.append(h4, subtitle, grid, errorEl, inputWrapper);
  }

  // ─── Step 3: Display name ─────────────────────────────────────────

  private showDisplayName(): void {
    this.currentStep = 'display-name';
    this.container.innerHTML = '';

    const hero = document.createElement('div');
    hero.classList.add('nostra-welcome-hero');

    const avatarPreview = document.createElement('div');
    avatarPreview.classList.add('nostra-avatar-preview');

    const avatarImg = document.createElement('img');
    avatarImg.classList.add('nostra-avatar-img');
    avatarPreview.append(avatarImg);

    if(this.identity?.npub) {
      const hex = decodePubkey(this.identity.npub);
      generateDicebearAvatar(hex).then((url) => {
        avatarImg.src = url;
      });
    }

    const title = document.createElement('h1');
    title.classList.add('nostra-welcome-title');
    title.textContent = 'You\'re all set';

    const description = document.createElement('p');
    description.classList.add('nostra-welcome-description');
    description.textContent = 'Pick how others will see you';

    hero.append(avatarPreview, title, description);

    const nameField = new InputField({
      label: 'Display Name' as any,
      name: 'display-name',
      maxLength: 50,
      plainText: true
    });

    const inputWrapper = document.createElement('div');
    inputWrapper.classList.add('input-wrapper');

    const btnFinish = Button('btn-primary btn-color-primary');
    btnFinish.textContent = 'Get Started';
    btnFinish.addEventListener('click', async() => {
      const displayName = nameField.value.trim() || undefined;
      await this.completeOnboarding(displayName, btnFinish);
    });

    const btnSkip = Button('btn-primary btn-secondary btn-primary-transparent primary');
    btnSkip.textContent = 'Skip';
    btnSkip.addEventListener('click', async() => {
      await this.completeOnboarding(undefined, btnSkip);
    });

    inputWrapper.append(nameField.container, btnFinish, btnSkip);
    this.container.append(hero, inputWrapper);
    setTimeout(() => nameField.input.focus(), 100);
  }

  // ─── Completion ────────────────────────────────────────────────────

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    return Promise.race([promise, new Promise<undefined>(r => setTimeout(() => r(undefined), ms))]);
  }

  private async completeOnboarding(displayName?: string, clickedBtn?: HTMLButtonElement): Promise<void> {
    if(!this.identity) return;

    const buttons = this.container.querySelectorAll('button');
    toggleDisability([...buttons] as HTMLButtonElement[], true);
    if(clickedBtn) {
      clickedBtn.textContent = '';
      putPreloader(clickedBtn);
    }

    try {
      const browserKey = await generateBrowserScopedKey();
      const {iv, ciphertext} = await encryptKeys(
        {seed: this.identity.mnemonic, nsec: this.identity.nsec},
        browserKey
      );

      const record: EncryptedIdentityRecord = {
        id: 'current',
        npub: this.identity.npub,
        displayName,
        protectionType: 'none',
        iv,
        encryptedKeys: ciphertext,
        createdAt: Date.now()
      };

      await this.withTimeout(saveEncryptedIdentity(record), 5000);
      await this.withTimeout(saveBrowserKey(browserKey), 5000);

      try {
        rootScope.dispatchEvent('nostra_identity_loaded', {
          npub: this.identity.npub,
          displayName,
          nip05: undefined,
          protectionType: 'none'
        });
      } catch{}

      this.notifyIdentityCreated();
    } catch(err) {
      console.error('[Onboarding] Failed to save identity:', err);
      this.notifyIdentityCreated();
    }
  }

  public destroy(): void {
    if(this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.onIdentityCreated = null;
    this.identity = null;
  }
}
