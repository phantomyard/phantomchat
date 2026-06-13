// @ts-nocheck
import {test, expect} from '@playwright/test';
import {launchOptions} from '../e2e/helpers/launch-options';
import {LocalRelay} from '../e2e/helpers/local-relay';
import {dismissOverlays} from '../e2e/helpers/dismiss-overlays';

test.describe('NIP-25 reactions end-to-end', () => {
  test('A reacts on B message → B sees reaction; A removes → B loses it', async({browser}) => {
    const relay = new LocalRelay();
    await relay.start();

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await ctxA.addInitScript((url) => { (window as any).__nostraTestRelays = [{url, read: true, write: true}]; }, relay.url);
    await ctxB.addInitScript((url) => { (window as any).__nostraTestRelays = [{url, read: true, write: true}]; }, relay.url);

    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    for(const p of [pageA, pageB]) {
      await p.goto('http://localhost:8080', {waitUntil: 'load', timeout: 60000});
      await p.waitForTimeout(5000);
      await p.reload({waitUntil: 'load', timeout: 60000});
      await p.waitForTimeout(15000);
      await dismissOverlays(p);
      await p.getByRole('button', {name: 'Create New Identity'}).click();
      await p.waitForTimeout(2000);
      await p.getByRole('button', {name: 'Continue'}).click();
      await p.waitForTimeout(2000);
      await p.getByRole('textbox').fill(p === pageA ? 'Alice' : 'Bob');
      await p.getByRole('button', {name: 'Get Started'}).click();
      await p.waitForTimeout(8000);
    }

    const [npubA, npubB] = await Promise.all([
      pageA.evaluate(() => {
        for(const e of document.querySelectorAll('*')) {
          if(e.children.length === 0 && e.textContent?.includes('npub1')) return e.textContent.trim();
        }
        return '';
      }),
      pageB.evaluate(() => {
        for(const e of document.querySelectorAll('*')) {
          if(e.children.length === 0 && e.textContent?.includes('npub1')) return e.textContent.trim();
        }
        return '';
      })
    ]);

    for(const {page, otherNpub, otherName} of [
      {page: pageA, otherNpub: npubB, otherName: 'Bob'},
      {page: pageB, otherNpub: npubA, otherName: 'Alice'}
    ]) {
      await page.evaluate(async({pk, nm}) => {
        const {addP2PContact} = await import('/src/lib/nostra/add-p2p-contact.ts');
        await addP2PContact({pubkey: pk, nickname: nm, source: 'e2e-reactions-test'});
      }, {pk: otherNpub, nm: otherName});
    }

    // B sends a message to A.
    const peerIdBOnA = await pageA.evaluate(async() => {
      const rs = (window as any).rootScope;
      const proxy = (window as any).apiManagerProxy;
      const peers = proxy?.mirrors?.peers || {};
      for(const [pid, p] of Object.entries<any>(peers)) {
        if(Number(pid) >= 1e15) return Number(pid);
      }
      return 0;
    });
    const peerIdAOnB = await pageB.evaluate(async() => {
      const proxy = (window as any).apiManagerProxy;
      const peers = proxy?.mirrors?.peers || {};
      for(const [pid, p] of Object.entries<any>(peers)) {
        if(Number(pid) >= 1e15) return Number(pid);
      }
      return 0;
    });

    await pageB.evaluate(async(peerId) => {
      const rs = (window as any).rootScope;
      (window as any).appImManager?.setPeer?.({peerId});
      await new Promise((r) => setTimeout(r, 500));
      const input = document.querySelector('.chat-input [contenteditable="true"]') as HTMLElement;
      input.focus();
      document.execCommand('insertText', false, 'hello from B');
      (document.querySelector('.chat-input button.btn-send') as HTMLElement).click();
    }, peerIdAOnB);
    await pageB.waitForTimeout(2000);

    // A opens chat and reacts with 👍.
    await pageA.evaluate(async(peerId) => {
      (window as any).appImManager?.setPeer?.({peerId});
    }, peerIdBOnA);
    await pageA.waitForTimeout(1000);

    const targetMidOnA = await pageA.evaluate(() => {
      const b = document.querySelector('.bubbles-inner .bubble[data-mid].is-in') as HTMLElement;
      return b ? Number(b.dataset.mid) : 0;
    });
    expect(targetMidOnA).toBeGreaterThan(0);

    await pageA.evaluate(async(mid) => {
      const rs = (window as any).rootScope;
      const peerId = (window as any).appImManager?.chat?.peerId;
      await rs.managers.appReactionsManager.sendReaction({
        message: {peerId, mid},
        reaction: {_: 'reactionEmoji', emoticon: '👍'}
      });
    }, targetMidOnA);
    await pageA.waitForTimeout(3000);

    // B sees the reaction.
    const bSees = await pageB.evaluate(() => {
      const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble.is-out'));
      for(const b of bubbles) {
        const rt = b.querySelector('.reactions');
        if(rt && rt.textContent?.includes('👍')) return true;
      }
      return false;
    });
    expect(bSees).toBe(true);

    // A removes the reaction (click same emoji again, which in tweb toggles off).
    await pageA.evaluate(async(mid) => {
      const rs = (window as any).rootScope;
      const peerId = (window as any).appImManager?.chat?.peerId;
      // Remove: invoke unpublish directly on the store-adjacent helper.
      const rows = await (window as any).__nostraReactionsStore.getAll();
      const ownRow = rows.find((r: any) => r.fromPubkey !== 'x' && r.targetMid === mid);
      if(ownRow) await (window as any).__nostraReactionsPublish.unpublish(ownRow.reactionEventId);
    }, targetMidOnA);
    await pageA.waitForTimeout(3000);

    const bNoLonger = await pageB.evaluate(() => {
      const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble.is-out'));
      for(const b of bubbles) {
        const rt = b.querySelector('.reactions');
        if(rt && rt.textContent?.includes('👍')) return false;
      }
      return true;
    });
    expect(bNoLonger).toBe(true);

    await ctxA.close();
    await ctxB.close();
    await relay.stop();
  });
});
