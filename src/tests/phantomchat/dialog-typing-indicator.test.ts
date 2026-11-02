// @vitest-environment jsdom
import {describe, it, expect, vi} from 'vitest';
import paintDialogTyping, {
  DIALOG_TYPING_CONTAINER_CLASS,
  DIALOG_TYPING_ROW_CLASS
} from '@lib/phantomchat/dialog-typing-indicator';

const PEER_ID = 4242 as any;

function typingContainer(text = 'Robbie is working') {
  const container = document.createElement('span');
  container.classList.add('online', DIALOG_TYPING_CONTAINER_CLASS);
  container.textContent = text;
  return container;
}

function makeDom(subtitle?: string) {
  const lastMessageSpan = document.createElement('span');
  if(subtitle) lastMessageSpan.textContent = subtitle;
  return {lastMessageSpan};
}

describe('paintDialogTyping', () => {
  it('paints the indicator into a row whose last message was not resolvable', async() => {
    const dom = makeDom();
    const getPeerTyping = vi.fn(async() => typingContainer());

    const painted = await paintDialogTyping({dom, peerId: PEER_ID, getPeerTyping});

    expect(painted).toBe(true);
    expect(dom.lastMessageSpan.classList.contains(DIALOG_TYPING_ROW_CLASS)).toBe(true);
    expect(dom.lastMessageSpan.querySelector('.' + DIALOG_TYPING_CONTAINER_CLASS)).not.toBeNull();
    expect(dom.lastMessageSpan.textContent).toBe('Robbie is working');
  });

  it('re-derives from live state after a dialog update overwrote the subtitle', async() => {
    const dom = makeDom('Done — #379 is merge-ready pending review');

    // setLastMessageN wrote the last message over the previously painted
    // indicator; the store still says the peer is working.
    await paintDialogTyping({dom, peerId: PEER_ID, getPeerTyping: async() => typingContainer('Robbie is working')});

    expect(dom.lastMessageSpan.textContent).toBe('Robbie is working');
    expect(dom.lastMessageSpan.classList.contains(DIALOG_TYPING_ROW_CLASS)).toBe(true);
  });

  it('leaves the subtitle untouched and clears the marker when nobody is typing', async() => {
    const dom = makeDom('last message text');
    dom.lastMessageSpan.classList.add(DIALOG_TYPING_ROW_CLASS);

    const painted = await paintDialogTyping({dom, peerId: PEER_ID, getPeerTyping: async() => undefined});

    expect(painted).toBe(false);
    expect(dom.lastMessageSpan.textContent).toBe('last message text');
    expect(dom.lastMessageSpan.classList.contains(DIALOG_TYPING_ROW_CLASS)).toBe(false);
  });

  it('drops the paint when a newer repaint superseded it while awaiting', async() => {
    const dom = makeDom();

    const painted = await paintDialogTyping({
      dom,
      peerId: PEER_ID,
      getPeerTyping: async() => typingContainer(),
      isStillValid: () => false
    });

    expect(painted).toBe(false);
    expect(dom.lastMessageSpan.textContent).toBe('');
    expect(dom.lastMessageSpan.classList.contains(DIALOG_TYPING_ROW_CLASS)).toBe(false);
  });

  it('updates an existing container in place rather than stacking a second one', async() => {
    const dom = makeDom();
    const existing = typingContainer('Robbie is working');
    dom.lastMessageSpan.append(existing);

    const getPeerTyping = vi.fn(async(_peerId, container?: HTMLElement) => {
      // Mirrors appImManager.getPeerTyping: mutates the container it is given.
      const target = container || typingContainer();
      target.textContent = 'Robbie is sending a photo';
      return target;
    });

    await paintDialogTyping({dom, peerId: PEER_ID, getPeerTyping});

    expect(getPeerTyping).toHaveBeenCalledWith(PEER_ID, existing, undefined);
    expect(dom.lastMessageSpan.querySelectorAll('.' + DIALOG_TYPING_CONTAINER_CLASS).length).toBe(1);
    expect(dom.lastMessageSpan.textContent).toBe('Robbie is sending a photo');
  });

  it('passes the forum-topic threadId through to the store lookup', async() => {
    const dom = makeDom();
    const getPeerTyping = vi.fn(async() => typingContainer());

    await paintDialogTyping({dom, peerId: PEER_ID, threadId: 987, getPeerTyping});

    expect(getPeerTyping).toHaveBeenCalledWith(PEER_ID, undefined, 987);
  });
});
