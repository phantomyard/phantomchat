// @vitest-environment jsdom
import {describe, it, expect} from 'vitest';

/**
 * Regression for FIND-3c99f5a3 — multi-codepoint emoji sendText.
 *
 * Root cause (primary): Playwright's `page.keyboard.type()` iterates a string
 * by UTF-16 code unit and presses each unit as a separate key. Emoji in the
 * supplementary plane (e.g. U+1F525 🔥) are two code units (surrogate pair);
 * typing them one-half-at-a-time produces empty/garbage input on a
 * contenteditable. The fuzz action now uses `keyboard.insertText()`, which
 * inserts the full string atomically.
 *
 * Root cause (secondary — defensive): tweb may render emoji as `<img alt="🔥">`
 * in some configurations (native-emoji off, custom emoji pack). The
 * `POST-sendText-bubble-appears` postcondition used only `clone.textContent`,
 * which ignores `alt=`. It now falls back to concatenating `alt=` attributes
 * so the needle match succeeds regardless of rendering mode.
 *
 * This test validates the extraction logic in isolation. We don't run the
 * fuzzer here — that path is covered by `pnpm fuzz --replay=FIND-3c99f5a3`.
 */

/**
 * Reference implementation mirroring the production postcondition's
 * extraction logic (concat textContent + all img[alt] contents).
 */
function extractBubbleFullText(bubble: HTMLElement): string {
  const clone = bubble.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.time, .time-inner, .reactions, .bubble-pin').forEach((e) => e.remove());
  const imgAlt = Array.from(clone.querySelectorAll('img[alt]'))
    .map((i) => i.getAttribute('alt') || '').join('');
  return (clone.textContent || '') + imgAlt;
}

describe('emoji-send regression — bubble text extraction', () => {
  it('concatenates alt= attributes so img-rendered emoji are matchable', () => {
    const bubble = document.createElement('div');
    bubble.classList.add('bubble');
    // Simulate tweb rendering "🔥🔥🔥" as three <img alt="🔥"> elements.
    for(let i = 0; i < 3; i++) {
      const img = document.createElement('img');
      img.setAttribute('alt', '🔥');
      img.classList.add('emoji');
      bubble.appendChild(img);
    }

    const text = extractBubbleFullText(bubble);
    expect(text).toContain('🔥🔥🔥');
  });

  it('handles mixed text + emoji imgs', () => {
    const bubble = document.createElement('div');
    bubble.classList.add('bubble');

    const pre = document.createTextNode('hello ');
    bubble.appendChild(pre);

    const img = document.createElement('img');
    img.setAttribute('alt', '🔥');
    bubble.appendChild(img);

    const post = document.createTextNode(' world');
    bubble.appendChild(post);

    const text = extractBubbleFullText(bubble);
    // textContent gives "hello  world", imgAlt contributes "🔥".
    expect(text).toContain('🔥');
    expect(text).toContain('hello');
    expect(text).toContain('world');
  });

  it('still matches plain-text emoji (native-emoji on)', () => {
    // When tweb renders native emoji, the character goes directly into the
    // DOM text. textContent handles this case without the alt fallback.
    const bubble = document.createElement('div');
    bubble.classList.add('bubble');
    bubble.textContent = '🔥🔥🔥';

    const text = extractBubbleFullText(bubble);
    expect(text).toContain('🔥🔥🔥');
  });

  it('ignores alt= on non-img elements (extraction scoped to img[alt])', () => {
    const bubble = document.createElement('div');
    bubble.classList.add('bubble');

    const div = document.createElement('div');
    div.setAttribute('alt', 'fakeAlt');
    bubble.appendChild(div);

    const text = extractBubbleFullText(bubble);
    expect(text).not.toContain('fakeAlt');
  });

  it('strips .time/.reactions/.bubble-pin before extracting', () => {
    const bubble = document.createElement('div');
    bubble.classList.add('bubble');

    const body = document.createElement('span');
    body.textContent = 'hi';
    bubble.appendChild(body);

    const time = document.createElement('span');
    time.classList.add('time');
    time.textContent = '12:34';
    bubble.appendChild(time);

    const reactions = document.createElement('div');
    reactions.classList.add('reactions');
    reactions.textContent = '👍';
    bubble.appendChild(reactions);

    const text = extractBubbleFullText(bubble);
    expect(text).toContain('hi');
    expect(text).not.toContain('12:34');
    expect(text).not.toContain('👍');
  });
});
