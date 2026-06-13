// @ts-nocheck
/**
 * Fuzzer harness — spawns LocalRelay, 2 browser contexts, onboards both users,
 * establishes mutual contact. Exposes UserHandle objects the fuzzer drives.
 *
 * Onboarding is deterministic setup, not part of the fuzzed action space.
 */

import {chromium, type Browser} from 'playwright';
import {nip19} from 'nostr-tools';
import {launchOptions} from '../e2e/helpers/launch-options';
import {LocalRelay} from '../e2e/helpers/local-relay';
import {dismissOverlays} from '../e2e/helpers/dismiss-overlays';
import type {FuzzContext, UserHandle, UserId} from './types';

const APP_URL = process.env.FUZZ_APP_URL || 'http://localhost:8080';
const CONSOLE_BUFFER_MAX = 5000;

export interface HarnessOptions {
  /** How many console lines to retain per user (ring buffer). Default 5000. */
  consoleBufferMax?: number;
  /** Launch visible browsers instead of headless. Overrides E2E_HEADED env. */
  headed?: boolean;
  /** Slow down Playwright actions by N ms (useful with headed). Overrides E2E_SLOWMO env. */
  slowMo?: number;
}

const log = (m: string) => console.log(`[harness] ${m}`);

export async function bootHarness(opts: HarnessOptions = {}): Promise<{
  browser: Browser;
  relay: LocalRelay;
  ctx: FuzzContext;
  teardown: () => Promise<void>;
}> {
  const t0 = Date.now();
  log('boot: LocalRelay + 2 contexts + onboarding');
  const relay = new LocalRelay();
  await relay.start();
  const launch = {
    ...launchOptions,
    ...(opts.headed !== undefined && {headless: !opts.headed}),
    ...(opts.slowMo ? {slowMo: opts.slowMo} : {})
  };
  const browser = await chromium.launch(launch);

  const userA = await createUser(browser, 'userA', 'Alice-Fuzz', relay, opts);
  const userB = await createUser(browser, 'userB', 'Bob-Fuzz', relay, opts);

  await linkContacts(userA, userB);
  await warmupHandshake(userA, userB);
  await warmupGroupsHandshake(userA, userB);
  log(`boot done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const ctx: FuzzContext = {
    users: {userA, userB},
    relay,
    snapshots: new Map(),
    actionIndex: 0
  };

  const teardown = async () => {
    await userA.context.close().catch(() => {});
    await userB.context.close().catch(() => {});
    await browser.close().catch(() => {});
    await relay.stop().catch(() => {});
  };

  return {browser, relay, ctx, teardown};
}

async function createUser(
  browser: Browser,
  id: UserId,
  displayName: string,
  relay: LocalRelay,
  opts: HarnessOptions
): Promise<UserHandle> {
  const context = await browser.newContext();
  // injectInto sets __phantomchatTestRelays AND disables Tor — the latter is
  // critical: with mode='when-available' the headless webtor bootstrap
  // stalls, gating initGlobalSubscription on a promise that never resolves.
  // The receiver's relay pool then never connects and B→A delivery
  // silently fails (warmup step 1, all bidirectional fuzz scenarios).
  await relay.injectInto(context);

  // Blossom mock: intercept PUT/POST to upload/media endpoints, hash body,
  // stash bytes under window.__fuzzBlossomUploads, and return a fake
  // `https://blossom.fuzz/<sha>.png` URL. Profile actions use this so
  // real Blossom servers are never hit.
  await context.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    (window as any).__fuzzBlossomUploads = new Map<string, Uint8Array>();
    window.fetch = async function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input as Request).url);
      const method = (init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
      if(url && /^https?:\/\/[^/]+\/(upload|media)(\/|\?|$)/.test(url) && (method === 'PUT' || method === 'POST')) {
        const bodyAny = init?.body as any;
        let body: Uint8Array;
        try{
          if(bodyAny instanceof Uint8Array) body = bodyAny;
          else if(typeof Blob !== 'undefined' && bodyAny instanceof Blob) body = new Uint8Array(await bodyAny.arrayBuffer());
          else if(bodyAny instanceof ArrayBuffer) body = new Uint8Array(bodyAny);
          else if(typeof bodyAny === 'string') body = new TextEncoder().encode(bodyAny);
          else body = new Uint8Array();
        } catch{
          body = new Uint8Array();
        }
        const hash = await crypto.subtle.digest('SHA-256', body);
        const sha = Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
        (window as any).__fuzzBlossomUploads.set(sha, body);
        return new Response(JSON.stringify({
          url: `https://blossom.fuzz/${sha}.png`,
          sha256: sha,
          size: body.byteLength,
          uploaded: Math.floor(Date.now() / 1000)
        }), {status: 200, headers: {'content-type': 'application/json'}});
      }
      return originalFetch(input as any, init);
    } as typeof window.fetch;
  });

  const page = await context.newPage();

  const consoleLog: string[] = [];
  const max = opts.consoleBufferMax ?? CONSOLE_BUFFER_MAX;
  page.on('console', (msg) => {
    consoleLog.push(`[${msg.type()}] ${msg.text()}`);
    if(consoleLog.length > max) consoleLog.shift();
  });
  page.on('pageerror', (err) => {
    consoleLog.push(`[pageerror] ${err.message}\n${err.stack || ''}`);
    if(consoleLog.length > max) consoleLog.shift();
  });

  // Standard Vite-HMR-friendly boot sequence from e2e-bug-regression.ts.
  await page.goto(APP_URL, {waitUntil: 'load', timeout: 60000});
  await page.waitForTimeout(5000);
  await page.reload({waitUntil: 'load', timeout: 60000});
  await page.waitForTimeout(15000);
  await dismissOverlays(page);

  // First-install info popup ("Got it") can intercept onboarding clicks. Dismiss
  // it if present before driving the auth flow.
  const gotIt = page.getByRole('button', {name: 'Got it'});
  if(await gotIt.isVisible().catch(() => false)) {
    await gotIt.click({force: true});
    await page.waitForTimeout(500);
  }

  await page.getByRole('button', {name: 'Create New Identity'}).waitFor({state: 'visible', timeout: 30000});
  await page.getByRole('button', {name: 'Create New Identity'}).click({force: true});
  await page.waitForTimeout(2000);

  const npub = await page.evaluate(() => {
    for(const e of document.querySelectorAll('*')) {
      if(e.children.length === 0 && e.textContent?.includes('npub1')) {
        return e.textContent.trim();
      }
    }
    return '';
  });

  await dismissOverlays(page);
  await page.getByRole('button', {name: 'Continue'}).click({force: true});
  await page.waitForTimeout(2000);
  const nameInput = page.getByRole('textbox');
  if(await nameInput.isVisible()) {
    await nameInput.fill(displayName);
    await dismissOverlays(page);
    await page.getByRole('button', {name: 'Get Started'}).click({force: true});
  }
  await page.waitForTimeout(8000);
  log(`${id} onboarded (${npub.slice(0, 14)}…)`);

  const reloadTimes: number[] = [Date.now()];
  page.on('load', () => reloadTimes.push(Date.now()));

  // Decode npub → hex once at boot so actions can use hex pubkeys without
  // re-decoding on every call. GroupAPI takes hex pubkeys. Decode runs in
  // the Node harness, not in page.evaluate — the browser can't resolve the
  // bare 'nostr-tools' module specifier (only Vite-served /src/... paths
  // work in page.evaluate dynamic imports).
  let pubkeyHex = '';
  try {
    const decoded = nip19.decode(npub);
    if(decoded.type === 'npub') pubkeyHex = decoded.data as string;
  } catch(err) {
    log(`${id}: failed to decode npub — pubkeyHex left empty (${err instanceof Error ? err.message : String(err)})`);
  }

  return {
    id,
    context,
    page,
    displayName,
    npub,
    pubkeyHex,
    remotePeerId: 0, // set later in linkContacts
    consoleLog,
    reloadTimes
  };
}

async function linkContacts(a: UserHandle, b: UserHandle): Promise<void> {
  a.remotePeerId = await injectContact(a, b);
  b.remotePeerId = await injectContact(b, a);
}

async function injectContact(self: UserHandle, other: UserHandle): Promise<number> {
  // Delegate to the canonical addP2PContact helper. It handles pubkey decoding,
  // peerId derivation (SHA-256 → VIRTUAL_PEER_BASE + % VIRTUAL_PEER_RANGE),
  // virtualPeersDB storeMapping, appUsersManager.injectP2PUser, mirror sync,
  // ChatAPI.connect, and dialog dispatch in one fully-consistent pass. This is
  // the same path the UI's Add Contact flow uses.
  return self.page.evaluate(async ({otherNpub, otherName}) => {
    const {addP2PContact} = await import('/src/lib/phantomchat/add-p2p-contact.ts');
    const result = await addP2PContact({
      pubkey: otherNpub,
      nickname: otherName,
      source: 'fuzzer-harness'
    });
    return result.peerId;
  }, {otherNpub: other.npub, otherName: other.displayName});
}

/**
 * Deterministic multi-kind warmup handshake. Exercises kinds 1059 (text),
 * 7 (reaction), and 5 (delete) bidirectionally via the real UI/manager paths
 * and awaits DOM confirmation at each step, so the first fuzz action no longer
 * races a not-yet-warm relay subscription.
 *
 * Closes FIND-cold-deleteWhileSending, FIND-cold-reactPeerSeesEmoji.
 */
async function warmupHandshake(a: UserHandle, b: UserHandle): Promise<void> {
  // Best-effort warmup. Failures are logged but non-fatal: the fuzz run still
  // proceeds so that cold-start flakes (if any) surface as findings rather
  // than aborting the entire iteration at boot.
  //
  // Each step has its own try/catch so a failure in one does NOT cancel the
  // later steps. Prior version wrapped all three steps in a single try block
  // and let step-1 DOM timeouts abort step-2 (kind-7 priming) and step-3
  // (kind-5 priming) — leading to a cold kind-7 subscription when the first
  // real fuzz action was reactViaUI (FIND-4e18d35d regression-watch, firing
  // repeatedly in Phase 2b.5 baseline-emit runs).
  log('warmup: A→B text → B→A react → A→B delete → drain');
  const warmupText = `__warmup_${Date.now()}__`;
  let mid: string | null = null;

  try {
    await sendTextViaUI(a, warmupText);
    mid = await waitForBubbleOnPeer(b, warmupText, 15000);
    log('warmup: step 1 (text) ack');
  } catch(err) {
    log(`warmup: step 1 (text) non-fatal — ${err instanceof Error ? err.message : String(err)}`);
    // Recovery: pull the mid from B's `phantomchat-messages` IDB directly. The
    // message was published to the relay even if B's DOM hasn't rendered it
    // yet (chat not open → render is deferred until setPeer). Step 2 needs
    // the mid to publish the kind-7 reaction, which primes A's kind-7
    // subscription before the first fuzz action. Use raw IDB (not the
    // `getMessageStore()` facade) because the facade only exposes
    // per-conversation accessors and we don't know the conversationId.
    try {
      mid = await b.page.evaluate(async(needle: string) => {
        const req = indexedDB.open('phantomchat-messages');
        const db: IDBDatabase = await new Promise((resolve, reject) => {
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const tx = db.transaction('messages', 'readonly');
        const store = tx.objectStore('messages');
        const all: any[] = await new Promise((resolve, reject) => {
          const r = store.getAll();
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        db.close();
        const row = all.find((r: any) => typeof r.content === 'string' && r.content.includes(needle));
        return row?.mid != null ? String(row.mid) : null;
      }, warmupText);
      if(mid) log('warmup: step 1 recovery — mid resolved from B IDB');
    } catch(recErr) {
      log(`warmup: step 1 recovery failed — ${recErr instanceof Error ? recErr.message : String(recErr)}`);
    }
  }

  if(mid) {
    try {
      await reactToBubbleViaManager(b, mid, '👍');
      await waitForReactionOnPeer(a, warmupText, '👍', 15000);
      log('warmup: step 2 (react) ack');
    } catch(err) {
      log(`warmup: step 2 (react) non-fatal — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    await deleteBubbleViaManager(a, warmupText);
    await waitForBubbleAbsenceOnPeer(b, warmupText, 15000);
    log('warmup: step 3 (delete) ack');
  } catch(err) {
    log(`warmup: step 3 (delete) non-fatal — ${err instanceof Error ? err.message : String(err)}`);
  }

  await a.page.waitForTimeout(500);
  log('warmup: drain complete');
}

/**
 * Deterministic group handshake: A creates a 2-member group (A + B), sends
 * one text into it, then B (non-admin) leaves. Surfaces cold-start races on
 * the group control/message pipeline so the first real fuzz action isn't
 * the first exercise of the group code path. Non-fatal on failure —
 * consistent with warmupHandshake policy.
 *
 * Why B leaves, not A: A is admin. If A left, B would process group_leave
 * and remove A from members[], BUT adminPubkey would still point to the
 * departed admin — an orphan admin state that fails
 * INV-group-admin-is-member. The auto-admin-transfer behaviour is a
 * design decision that belongs to a future phase, not the warmup. See
 * FUZZ-FINDINGS.md "admin-orphan on admin leave" for the tracked finding.
 */
async function warmupGroupsHandshake(a: UserHandle, b: UserHandle): Promise<void> {
  log('warmup/groups: A creates group → A sends → B leaves');
  const warmupText = `__warmupG_${Date.now()}__`;
  try {
    const groupId = await a.page.evaluate(async (otherHex: string) => {
      const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
      return getGroupAPI().createGroup('Warmup', [otherHex]);
    }, b.pubkeyHex);
    // Wait for B to receive the group-create control message.
    await waitForGroupOnUser(b, groupId, 10000);
    log('warmup/groups: step 1 (create) ack');

    await a.page.evaluate(async ({gid, txt}: any) => {
      const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
      await getGroupAPI().sendMessage(gid, txt);
    }, {gid: groupId, txt: warmupText});
    await a.page.waitForTimeout(500);
    log('warmup/groups: step 2 (send) fired');

    // B (non-admin) leaves — avoids admin-orphan state on A.
    await b.page.evaluate(async (gid: string) => {
      const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
      await getGroupAPI().leaveGroup(gid);
    }, groupId);
    log('warmup/groups: step 3 (leave) ack');
  } catch(err) {
    log(`warmup/groups: non-fatal error — ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function waitForGroupOnUser(user: UserHandle, groupId: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while(Date.now() - start < timeoutMs) {
    const has = await user.page.evaluate(async (gid: string) => {
      try {
        const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
        return !!(await getGroupStore().get(gid));
      } catch {
        return false;
      }
    }, groupId);
    if(has) return;
    await user.page.waitForTimeout(250);
  }
  throw new Error(`warmup/groups: peer never received group ${groupId.slice(0, 8)} within ${timeoutMs}ms`);
}

async function sendTextViaUI(self: UserHandle, text: string): Promise<void> {
  // Open the chat to the remote peer using the same setPeer path actions use.
  await self.page.evaluate((peerId: number) => {
    (window as any).appImManager?.setPeer?.({peerId});
  }, self.remotePeerId);
  await self.page.waitForTimeout(500);

  // Selectors match actions/messaging.ts sendText exactly.
  const input = self.page.locator('.chat-input [contenteditable="true"]').first();
  await input.waitFor({state: 'visible', timeout: 10000});
  await input.focus();
  await self.page.keyboard.press('Control+A');
  await self.page.keyboard.press('Backspace');
  // insertText preserves surrogate pairs — see FIND-3c99f5a3.
  await self.page.keyboard.insertText(text);
  const sendBtn = self.page.locator('.chat-input button.btn-send').first();
  await sendBtn.click();
}

async function reactToBubbleViaManager(
  self: UserHandle,
  mid: string,
  emoji: string
): Promise<void> {
  // Ensure the peer chat is open so sendReaction can resolve peerId.
  await self.page.evaluate((peerId: number) => {
    (window as any).appImManager?.setPeer?.({peerId});
  }, self.remotePeerId);
  await self.page.waitForTimeout(300);

  const ok = await self.page.evaluate(async ({targetMid, em}: any) => {
    const rs = (window as any).rootScope;
    const peerId = (window as any).appImManager?.chat?.peerId;
    const mgr = rs?.managers?.appReactionsManager;
    if(!mgr?.sendReaction || !peerId) return false;
    try {
      await mgr.sendReaction({
        message: {peerId, mid: Number(targetMid)},
        reaction: {_: 'reactionEmoji', emoticon: em}
      });
      return true;
    } catch { return false; }
  }, {targetMid: mid, em: emoji});
  if(!ok) throw new Error(`warmup: reactToBubbleViaManager failed on mid=${mid}`);
}

async function deleteBubbleViaManager(self: UserHandle, bubbleText: string): Promise<void> {
  const mid = await self.page.evaluate((needle: string) => {
    const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
    for(const b of bubbles) {
      if((b.textContent || '').includes(needle)) return (b as HTMLElement).dataset.mid || null;
    }
    return null;
  }, bubbleText);
  if(!mid) throw new Error(`warmup: deleteBubbleViaManager could not find bubble "${bubbleText}"`);

  const done = await self.page.evaluate(async (targetMid: string) => {
    const rs = (window as any).rootScope;
    const peerId = (window as any).appImManager?.chat?.peerId;
    if(!rs?.managers?.appMessagesManager || !peerId) return false;
    try {
      await rs.managers.appMessagesManager.deleteMessages(peerId, [Number(targetMid)], true);
      return true;
    } catch { return false; }
  }, mid);
  if(!done) throw new Error(`warmup: deleteMessages failed on mid=${mid}`);
}

async function waitForBubbleOnPeer(
  peer: UserHandle,
  text: string,
  timeoutMs: number
): Promise<string> {
  // Ensure peer has the chat open so bubbles render.
  await peer.page.evaluate((peerId: number) => {
    (window as any).appImManager?.setPeer?.({peerId});
  }, peer.remotePeerId);

  const start = Date.now();
  while(Date.now() - start < timeoutMs) {
    const mid = await peer.page.evaluate((needle: string) => {
      const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
      for(const b of bubbles) {
        if((b.textContent || '').includes(needle)) {
          const el = b as HTMLElement;
          if(el.classList.contains('is-sending') || el.classList.contains('is-outgoing')) continue;
          return el.dataset.mid || null;
        }
      }
      return null;
    }, text);
    if(mid) return mid;
    await peer.page.waitForTimeout(250);
  }
  throw new Error(`warmup: bubble "${text}" never appeared on peer within ${timeoutMs}ms`);
}

async function waitForBubbleAbsenceOnPeer(
  peer: UserHandle,
  text: string,
  timeoutMs: number
): Promise<void> {
  const start = Date.now();
  while(Date.now() - start < timeoutMs) {
    const present = await peer.page.evaluate((needle: string) => {
      const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
      return bubbles.some((b) => (b.textContent || '').includes(needle));
    }, text);
    if(!present) return;
    await peer.page.waitForTimeout(250);
  }
  throw new Error(`warmup: bubble "${text}" still visible on peer after ${timeoutMs}ms`);
}

async function waitForReactionOnPeer(
  peer: UserHandle,
  bubbleText: string,
  emoji: string,
  timeoutMs: number
): Promise<void> {
  const start = Date.now();
  while(Date.now() - start < timeoutMs) {
    const seen = await peer.page.evaluate(({needle, em}: {needle: string; em: string}) => {
      const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
      for(const b of bubbles) {
        if(!(b.textContent || '').includes(needle)) continue;
        const rt = b.querySelector('.reactions');
        if(rt && (rt.textContent || '').includes(em)) return true;
      }
      return false;
    }, {needle: bubbleText, em: emoji});
    if(seen) return;
    await peer.page.waitForTimeout(250);
  }
  throw new Error(`warmup: reaction ${emoji} never appeared on peer bubble "${bubbleText}" within ${timeoutMs}ms`);
}
