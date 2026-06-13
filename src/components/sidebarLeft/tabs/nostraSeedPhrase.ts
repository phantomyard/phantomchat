/*
 * Nostra.chat -- Recovery Phrase UI
 *
 * Dedicated tab for viewing the 12-word BIP-39 recovery phrase.
 * Prompts for PIN/passphrase if key protection is enabled, then renders
 * a styled word grid with copy button and auto-hide countdown.
 */

import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import Button from '@components/button';
import {toast} from '@components/toast';
import useNostraIdentity from '@stores/nostraIdentity';
import {
  deriveKeyFromPin,
  deriveKeyFromPassphrase,
  decryptKeys,
  loadEncryptedIdentity,
  loadBrowserKey
} from '@lib/nostra/key-storage';

const AUTO_HIDE_MS = 60000;

export default class AppNostraSeedPhraseTab extends SliderSuperTab {
  private revealContainer: HTMLElement | null = null;
  private gridContainer: HTMLElement | null = null;
  private countdownBar: HTMLElement | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;

  public init() {
    this.container.classList.add('nostra-seed-phrase-tab');
    this.setTitle('Recovery Phrase' as any);

    // Warning banner
    const warningSection = new SettingSection({
      name: 'Recovery Phrase' as any,
      caption: 'Your 12-word BIP-39 phrase is the ONLY way to restore access if you lose this device or forget your PIN.' as any
    });

    const warningCard = document.createElement('div');
    warningCard.classList.add('seed-warning-card');
    const warningIcon = document.createElement('div');
    warningIcon.classList.add('seed-warning-card__icon');
    warningIcon.textContent = '!';
    const warningText = document.createElement('div');
    warningText.classList.add('seed-warning-card__text');
    warningText.innerHTML =
      '<strong>Never share these words.</strong> ' +
      'Anyone with your recovery phrase can read your messages and impersonate you. ' +
      'Write them down on paper and store them offline.';
    warningCard.append(warningIcon, warningText);
    warningSection.content.append(warningCard);

    // Reveal / grid container
    this.revealContainer = document.createElement('div');
    this.revealContainer.classList.add('seed-reveal-container');

    this.gridContainer = document.createElement('div');
    this.gridContainer.classList.add('seed-grid-wrapper');
    this.gridContainer.style.display = 'none';

    const revealBtn = Button('btn-primary btn-color-primary seed-reveal-btn');
    revealBtn.textContent = 'Reveal Recovery Phrase';
    attachClickEvent(revealBtn, () => {
      this.handleReveal();
    }, {listenerSetter: this.listenerSetter});

    this.revealContainer.append(revealBtn, this.gridContainer);
    warningSection.content.append(this.revealContainer);

    this.scrollable.append(warningSection.container);
  }

  public onCloseAfterTimeout() {
    super.onCloseAfterTimeout();
    this.hideSeed();
  }

  private async handleReveal(): Promise<void> {
    try {
      const record = await loadEncryptedIdentity();
      if(!record) {
        toast('No identity found');
        return;
      }

      const protectionType = useNostraIdentity().protectionType();
      let decryptedData: {seed: string; nsec: string};

      if(protectionType === 'none') {
        const browserKey = await loadBrowserKey();
        if(!browserKey) {
          toast('Browser key not found');
          return;
        }
        decryptedData = await decryptKeys(record.iv, record.encryptedKeys, browserKey);
      } else {
        const secret = await this.promptForSecret(protectionType);
        if(!secret) return;

        const key = protectionType === 'pin' ?
          await deriveKeyFromPin(secret, record.salt!) :
          await deriveKeyFromPassphrase(secret, record.salt!);

        try {
          decryptedData = await decryptKeys(record.iv, record.encryptedKeys, key);
        } catch{
          toast('Incorrect ' + (protectionType === 'pin' ? 'PIN' : 'passphrase'));
          return;
        }
      }

      this.showSeed(decryptedData.seed);
    } catch(err) {
      toast('Failed to decrypt: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  private showSeed(seed: string): void {
    if(!this.gridContainer || !this.revealContainer) return;

    const words = seed.split(' ');
    this.gridContainer.innerHTML = '';
    this.gridContainer.style.display = 'block';

    // Hide the reveal button while grid is visible
    const revealBtn = this.revealContainer.querySelector('.seed-reveal-btn') as HTMLElement | null;
    if(revealBtn) revealBtn.style.display = 'none';

    const grid = document.createElement('div');
    grid.classList.add('seed-word-grid');

    for(let i = 0; i < words.length; i++) {
      const chip = document.createElement('div');
      chip.classList.add('seed-word-chip');

      const num = document.createElement('span');
      num.classList.add('seed-word-chip__num');
      num.textContent = String(i + 1);

      const word = document.createElement('span');
      word.classList.add('seed-word-chip__word');
      word.textContent = words[i];

      chip.append(num, word);
      grid.append(chip);
    }

    // Action row: copy + hide
    const actions = document.createElement('div');
    actions.classList.add('seed-actions');

    const copyBtn = Button('btn-primary btn-color-primary seed-copy-btn');
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(seed).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        toast('Recovery phrase copied');
      });
    });

    const hideBtn = Button('btn-primary btn-transparent seed-hide-btn');
    hideBtn.textContent = 'Hide';
    hideBtn.addEventListener('click', () => this.hideSeed());

    actions.append(hideBtn, copyBtn);

    // Countdown bar (visual auto-hide timer)
    const countdownWrap = document.createElement('div');
    countdownWrap.classList.add('seed-countdown');
    const countdownLabel = document.createElement('div');
    countdownLabel.classList.add('seed-countdown__label');
    countdownLabel.textContent = 'Auto-hides in 60s';
    this.countdownBar = document.createElement('div');
    this.countdownBar.classList.add('seed-countdown__bar');
    const barFill = document.createElement('div');
    barFill.classList.add('seed-countdown__fill');
    this.countdownBar.append(barFill);
    countdownWrap.append(countdownLabel, this.countdownBar);

    this.gridContainer.append(grid, countdownWrap, actions);

    // Start auto-hide
    const startedAt = Date.now();
    this.hideTimer = setTimeout(() => this.hideSeed(), AUTO_HIDE_MS);
    this.countdownInterval = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, AUTO_HIDE_MS - elapsed);
      const pct = (remaining / AUTO_HIDE_MS) * 100;
      barFill.style.width = pct + '%';
      countdownLabel.textContent = `Auto-hides in ${Math.ceil(remaining / 1000)}s`;
      if(remaining <= 0 && this.countdownInterval) {
        clearInterval(this.countdownInterval);
        this.countdownInterval = null;
      }
    }, 250);
  }

  private hideSeed(): void {
    if(this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if(this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    if(this.gridContainer) {
      this.gridContainer.innerHTML = '';
      this.gridContainer.style.display = 'none';
    }
    if(this.revealContainer) {
      const revealBtn = this.revealContainer.querySelector('.seed-reveal-btn') as HTMLElement | null;
      if(revealBtn) revealBtn.style.display = '';
    }
  }

  private promptForSecret(type: string): Promise<string | null> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.classList.add('prompt-overlay');

      const dialog = document.createElement('div');
      dialog.classList.add('prompt-dialog');

      const label = document.createElement('label');
      label.textContent = type === 'pin' ? 'Enter your PIN:' : 'Enter your passphrase:';

      const input = document.createElement('input');
      input.type = type === 'pin' ? 'tel' : 'password';
      input.classList.add('input-clear');
      if(type === 'pin') {
        input.pattern = '[0-9]*';
        input.maxLength = 6;
      }

      const btnRow = document.createElement('div');
      btnRow.classList.add('prompt-buttons');

      const cancelBtn = Button('btn-primary btn-transparent');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => {
        overlay.remove();
        resolve(null);
      });

      const confirmBtn = Button('btn-primary btn-color-primary');
      confirmBtn.textContent = 'Unlock';
      confirmBtn.addEventListener('click', () => {
        const val = input.value.trim();
        overlay.remove();
        resolve(val || null);
      });

      input.addEventListener('keydown', (e) => {
        if(e.key === 'Enter') confirmBtn.click();
      });

      btnRow.append(cancelBtn, confirmBtn);
      dialog.append(label, input, btnRow);
      overlay.append(dialog);
      document.body.append(overlay);
      input.focus();
    });
  }
}
