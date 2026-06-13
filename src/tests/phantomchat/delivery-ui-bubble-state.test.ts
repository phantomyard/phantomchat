// @vitest-environment jsdom

/**
 * Tests for applyBubbleState in phantomchat-delivery-ui.ts
 *
 * Locks FIND-9fa52e43 fix: 'sent' state must flip the spinner to a single
 * check icon. Previously only 'delivered'/'read' transitions cleared the
 * spinner, which left bubbles stuck on the clock indefinitely whenever the
 * delivery receipt was delayed or lost.
 */

import {describe, it, expect, beforeEach, vi} from 'vitest';

// jsdom is missing CSS.escape (it's a CSSOM browser-only API). Polyfill.
if(typeof (globalThis as any).CSS === 'undefined') {
  (globalThis as any).CSS = {
    escape: (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
  };
}

vi.mock('@components/icon', () => ({
  default: (name: string, className: string) => {
    const span = document.createElement('span');
    span.className = `tgico ${className}`;
    span.dataset.icon = name;
    return span;
  }
}));

import {applyBubbleState} from '@lib/phantomchat/phantomchat-delivery-ui';

const MID = '999000000001';

function makeBubble(initialIcon: string = 'sending'): HTMLElement {
  const b = document.createElement('div');
  b.className = 'bubble is-out is-sending';
  b.dataset.mid = MID;
  const time = document.createElement('span');
  time.className = 'time';
  const icon = document.createElement('span');
  icon.className = 'tgico time-sending-status';
  icon.dataset.icon = initialIcon;
  time.appendChild(icon);
  b.appendChild(time);
  document.body.appendChild(b);
  return b;
}

describe('applyBubbleState', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('flips clock to single check on sent', async() => {
    const b = makeBubble();
    const ok = await applyBubbleState(MID, 'sent');
    expect(ok).toBe(true);
    expect(b.classList.contains('is-sending')).toBe(false);
    expect(b.classList.contains('is-sent')).toBe(true);
    expect(b.classList.contains('is-read')).toBe(false);
    const icon = b.querySelector('.time-sending-status') as HTMLElement;
    expect(icon.dataset.icon).toBe('check');
  });

  it('flips to double checks on delivered', async() => {
    const b = makeBubble();
    await applyBubbleState(MID, 'delivered');
    expect(b.classList.contains('is-read')).toBe(true);
    expect(b.classList.contains('is-p2p-read')).toBe(false);
    const icon = b.querySelector('.time-sending-status') as HTMLElement;
    expect(icon.dataset.icon).toBe('checks');
  });

  it('adds is-p2p-read on read state for blue tint', async() => {
    const b = makeBubble();
    await applyBubbleState(MID, 'read');
    expect(b.classList.contains('is-read')).toBe(true);
    expect(b.classList.contains('is-p2p-read')).toBe(true);
    const icon = b.querySelector('.time-sending-status') as HTMLElement;
    expect(icon.dataset.icon).toBe('checks');
  });

  it('does NOT downgrade from delivered/read back to sent on late echo', async() => {
    const b = makeBubble();
    await applyBubbleState(MID, 'delivered');
    expect(b.classList.contains('is-read')).toBe(true);

    // A late 'sent' echo from a slow second-relay arrives — should be ignored
    const ok = await applyBubbleState(MID, 'sent');
    expect(ok).toBe(true);
    expect(b.classList.contains('is-read')).toBe(true);
    expect(b.classList.contains('is-sent')).toBe(false);
    const icon = b.querySelector('.time-sending-status') as HTMLElement;
    expect(icon.dataset.icon).toBe('checks');
  });

  it('returns false when bubble is not in DOM', async() => {
    const ok = await applyBubbleState('notinthedom', 'sent');
    expect(ok).toBe(false);
  });

  it('cleans up stale is-sending/is-error/is-sent classes on transition', async() => {
    const b = makeBubble();
    b.classList.add('is-error');
    await applyBubbleState(MID, 'sent');
    expect(b.classList.contains('is-error')).toBe(false);
    expect(b.classList.contains('is-sending')).toBe(false);
  });
});
