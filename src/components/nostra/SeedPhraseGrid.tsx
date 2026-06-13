/*
 * Nostra.chat -- Seed Phrase Grid
 *
 * 12 numbered input fields in a grid layout for importing
 * an existing BIP-39 mnemonic phrase. Supports auto-advance
 * focus, paste detection, and validation.
 */

import {JSX, createSignal, For, createMemo} from 'solid-js';
import {validateMnemonic} from '@lib/nostra/nostr-identity';

interface SeedPhraseGridProps {
  onComplete: (mnemonic: string) => void;
  onBack: () => void;
}

export default function SeedPhraseGrid(props: SeedPhraseGridProps): JSX.Element {
  const [words, setWords] = createSignal<string[]>(Array(12).fill(''));
  const inputRefs: HTMLInputElement[] = [];

  const mnemonic = createMemo(() => words().join(' ').trim());
  const isValid = createMemo(() => {
    const m = mnemonic();
    const filled = words().every(w => w.length > 0);
    return filled && validateMnemonic(m);
  });

  function handleInput(index: number, value: string) {
    const trimmed = value.trim().toLowerCase();

    // Detect paste of full 12-word mnemonic
    const pastedWords = trimmed.split(/\s+/);
    if(pastedWords.length === 12 && index === 0) {
      setWords(pastedWords);
      pastedWords.forEach((w, i) => {
        if(inputRefs[i]) inputRefs[i].value = w;
      });
      inputRefs[11]?.focus();
      return;
    }

    // Handle space to auto-advance
    if(trimmed.includes(' ')) {
      const word = trimmed.split(' ')[0];
      const updated = [...words()];
      updated[index] = word;
      setWords(updated);
      if(inputRefs[index]) inputRefs[index].value = word;
      if(index < 11) {
        inputRefs[index + 1]?.focus();
      }
      return;
    }

    const updated = [...words()];
    updated[index] = trimmed;
    setWords(updated);
  }

  function handleKeyDown(index: number, e: KeyboardEvent) {
    if(e.key === ' ' && words()[index].length > 0) {
      e.preventDefault();
      if(index < 11) {
        inputRefs[index + 1]?.focus();
      }
    }
    if(e.key === 'Backspace' && words()[index] === '' && index > 0) {
      e.preventDefault();
      inputRefs[index - 1]?.focus();
    }
  }

  function handleSubmit() {
    if(isValid()) {
      props.onComplete(mnemonic());
    }
  }

  return (
    <div class="seed-phrase-grid-container">
      <h2 class="seed-phrase-grid-title">Import Seed Phrase</h2>
      <p class="seed-phrase-grid-subtitle">Enter your 12-word recovery phrase</p>

      <div class="seed-phrase-grid">
        <For each={Array.from({length: 12}, (_, i) => i)}>
          {(index) => (
            <div class="seed-phrase-field">
              <label class="seed-phrase-label">{index + 1}</label>
              <input
                ref={(el) => { inputRefs[index] = el; }}
                type="text"
                autocomplete="off"
                autocapitalize="none"
                spellcheck={false}
                class="seed-phrase-input"
                value={words()[index]}
                onInput={(e) => handleInput(index, e.currentTarget.value)}
                onKeyDown={(e) => handleKeyDown(index, e)}
              />
            </div>
          )}
        </For>
      </div>

      <div class="seed-phrase-actions">
        <button
          class="btn-primary"
          disabled={!isValid()}
          onClick={handleSubmit}
        >
          Continue
        </button>
        <button
          class="btn-secondary"
          onClick={() => props.onBack()}
        >
          Back
        </button>
      </div>
    </div>
  );
}
