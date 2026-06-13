/**
 * E2E regression: User Info pane shows partner's kind 0 metadata fields.
 *
 * Bug: peerProfile.tsx renders Bio / Website / Lightning / NIP-05 rows
 * gated on `usePeerNostraProfile()` returning a non-empty signal. The
 * signal is seeded from `peer-profile-cache.ts` — but the cache is NEVER
 * pre-populated for partner peers. `add-p2p-contact.ts:kickOffKind0Fetch`
 * fetches kind 0 to upgrade the displayName, then THROWS AWAY the rest
 * of the profile (about / website / lud16 / nip05). The first time the
 * user opens a partner's User Info pane, the rows stay hidden until
 * `refreshPeerProfileFromRelays` lands (1-5 s) — or forever if relays
 * don't have the peer's kind 0.
 *
 * Fix (separate commit): kickOffKind0Fetch always writes the fetched
 * kind 0 to the peer profile cache via `saveCachedPeerProfile` and
 * dispatches `nostra_peer_profile_updated` so the rows render on first
 * open without waiting for an on-mount relay round-trip.
 *
 * Scenario:
 *   1. Alice creates identity and publishes kind 0 with about / website /
 *      lud16 / nip05 to LocalRelay.
 *   2. Bob creates identity and adds Alice as contact (nickname supplied).
 *   3. Within 5 s of `addP2PContact` returning, Bob's localStorage MUST
 *      contain `nostra-peer-profile-cache:<aliceHex>` with all four fields.
 *   4. After Bob opens chat with Alice and toggles the right sidebar, the
 *      User Info pane MUST contain each of those four values in the DOM
 *      within 2 s (no relay round-trip allowed).
 *
 * Run: pnpm start in another terminal, then
 *      npx tsx src/tests/e2e/e2e-user-info-kind0.ts
 */
// @ts-nocheck
import {chromium, type Page} from 'playwright';
import {launchOptions} from './helpers/launch-options';
import {LocalRelay} from './helpers/local-relay';
import {dismissOverlays} from './helpers/dismiss-overlays';

const APP_URL = process.env.E2E_APP_URL || 'http://localhost:8080';

const ALICE_PROFILE = {
  display_name: 'Alice Profile',
  about: 'Alice has a fully-detailed Nostr profile',
  website: 'https://alice.example.com',
  lud16: 'alice@getalby.example',
  nip05: 'alice@nostra.chat'
} as const;

async function createIdentity(page: Page, displayName: string): Promise<string> {
  await page.goto(APP_URL, {waitUntil: 'load', timeout: 60000});
  await page.waitForTimeout(5000);
  await page.reload({waitUntil: 'load', timeout: 60000});
  await page.waitForTimeout(15000);
  await dismissOverlays(page);

  await page.getByRole('button', {name: 'Create New Identity'}).waitFor({state: 'visible', timeout: 30000});
  await page.getByRole('button', {name: 'Create New Identity'}).click();
  await page.waitForTimeout(2000);

  const npub = await page.evaluate(() => {
    for(const e of document.querySelectorAll('*')) {
      if(e.children.length === 0 && e.textContent?.includes('npub1')) return e.textContent.trim();
    }
    return '';
  });

  await page.getByRole('button', {name: 'Continue'}).click();
  await page.waitForTimeout(2000);
  const nameInput = page.getByRole('textbox');
  if(await nameInput.isVisible()) {
    await nameInput.fill(displayName);
    await page.getByRole('button', {name: 'Get Started'}).click();
  }
  await page.waitForTimeout(8000);
  return npub;
}

/**
 * Publish a fully-populated kind 0 from the page. Polls for activeRelay
 * (set when the global relay pool finishes connecting) so we don't race
 * onboarding's own kind 0 publish.
 */
async function publishAliceProfile(page: Page): Promise<void> {
  const result = await page.evaluate(async(profile) => {
    const {publishKind0Metadata} = await import('/src/lib/nostra/nostr-relay.ts');
    const deadline = Date.now() + 15000;
    let lastErr: any = null;
    while(Date.now() < deadline) {
      try {
        const id = await publishKind0Metadata({
          name: profile.display_name,
          display_name: profile.display_name,
          about: profile.about,
          website: profile.website,
          lud16: profile.lud16,
          nip05: profile.nip05
        });
        return {ok: true, id};
      } catch(err: any) {
        lastErr = err?.message || String(err);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return {ok: false, err: lastErr};
  }, ALICE_PROFILE);
  if(!result.ok) throw new Error('Alice publishKind0Metadata never succeeded: ' + result.err);
}

async function addPeerAsContact(page: Page, peerNpub: string, peerName: string): Promise<void> {
  await page.evaluate(async({pk, nm}) => {
    if(typeof (0 as any).toPeerId !== 'function') {
      // eslint-disable-next-line no-extend-native
      (Number.prototype as any).toPeerId = function(isChat?: boolean) {
        return isChat === undefined ? +this : (isChat ? -Math.abs(+this) : +this);
      };
      (Number.prototype as any).toChatId = function() { return Math.abs(+this); };
      (Number.prototype as any).isPeerId = function() { return true; };
    }
    const {addP2PContact} = await import('/src/lib/nostra/add-p2p-contact.ts');
    await addP2PContact({pubkey: pk, nickname: nm, source: 'e2e-user-info-kind0'});
  }, {pk: peerNpub, nm: peerName});
}

async function readFirstP2PPeerId(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const proxy = (window as any).apiManagerProxy;
    const peers = proxy?.mirrors?.peers || {};
    for(const pid of Object.keys(peers)) {
      if(Number(pid) >= 1e15) return Number(pid);
    }
    return 0;
  });
}

/**
 * Poll Bob's localStorage for the peer profile cache entry written by
 * kickOffKind0Fetch. Returns the parsed cache record or null on timeout.
 */
async function waitForPeerProfileCache(page: Page, peerNpub: string, timeoutMs = 8000): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  while(Date.now() < deadline) {
    const cached = await page.evaluate(async(npub) => {
      const {decodePubkey} = await import('/src/lib/nostra/nostr-identity.ts');
      const hex = decodePubkey(npub);
      const raw = localStorage.getItem('nostra-peer-profile-cache:' + hex);
      return raw ? JSON.parse(raw) : null;
    }, peerNpub);
    if(cached) return cached;
    await page.waitForTimeout(250);
  }
  return null;
}

async function openChat(page: Page, peerId: number): Promise<void> {
  await page.evaluate(async(pid) => {
    (window as any).appImManager?.setPeer?.({peerId: pid});
  }, peerId);
  await page.waitForTimeout(800);
}

async function openRightSidebar(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sidebarRight = (window as any).appSidebarRight;
    sidebarRight?.toggleSidebar?.(true);
  });
}

async function rightSidebarHasText(page: Page, text: string, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while(Date.now() - start < timeoutMs) {
    const found = await page.evaluate((needle) => {
      const sidebar = document.querySelector('#column-right');
      return sidebar ? sidebar.textContent?.includes(needle) ?? false : false;
    }, text);
    if(found) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

async function main() {
  const relay = new LocalRelay();
  await relay.start();
  console.log('[e2e] local relay up at', relay.url);

  const browser = await chromium.launch(launchOptions);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  await relay.injectInto(ctxA);
  await relay.injectInto(ctxB);

  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  console.log('[e2e] creating identities');
  const [npubA, npubB] = await Promise.all([
    createIdentity(pageA, 'Alice'),
    createIdentity(pageB, 'Bob')
  ]);
  console.log('[e2e] Alice npub:', npubA.slice(0, 20) + '...');
  console.log('[e2e]   Bob npub:', npubB.slice(0, 20) + '...');

  console.log('[e2e] Alice publishes full kind 0');
  await publishAliceProfile(pageA);
  // Let strfry stream the event before Bob queries.
  await pageA.waitForTimeout(2000);

  // Sanity check: relay actually has Alice's full kind 0 (filter by her pubkey
  // and pick the newest, since onboarding also publishes a name-only kind 0).
  const aliceHex = await pageA.evaluate(async(npub) => {
    const {decodePubkey} = await import('/src/lib/nostra/nostr-identity.ts');
    return decodePubkey(npub);
  }, npubA);
  const allEvents = await relay.getAllEvents();
  const aliceKind0s = allEvents
    .filter((e: any) => e.kind === 0 && e.pubkey === aliceHex)
    .sort((a: any, b: any) => b.created_at - a.created_at);
  if(aliceKind0s.length === 0) throw new Error('LocalRelay never received Alice kind 0');
  const content = JSON.parse((aliceKind0s[0] as any).content);
  if(content.about !== ALICE_PROFILE.about) {
    throw new Error('Alice newest kind 0 missing/wrong about: ' + JSON.stringify(content));
  }

  console.log('[e2e] Bob adds Alice as contact');
  await addPeerAsContact(pageB, npubA, 'Alice');

  // PRIMARY ASSERTION: peer profile cache is populated by kickOffKind0Fetch.
  // Without the fix, kickOff fetches kind 0 then discards everything except
  // displayName, leaving the cache empty.
  console.log('[e2e] waiting for Bob to cache Alice kind 0...');
  const cached = await waitForPeerProfileCache(pageB, npubA, 8000);
  if(!cached) {
    throw new Error(
      'PRIMARY: peer profile cache entry missing for Alice — ' +
      'kickOffKind0Fetch fetched kind 0 but never wrote it to ' +
      'nostra-peer-profile-cache:* (User Info rows will stay hidden ' +
      'until on-mount relay round-trip lands)'
    );
  }
  console.log('[e2e] cached:', JSON.stringify(cached.profile));
  const expectedFields: Array<[string, string]> = [
    ['about',   ALICE_PROFILE.about],
    ['website', ALICE_PROFILE.website],
    ['lud16',   ALICE_PROFILE.lud16],
    ['nip05',   ALICE_PROFILE.nip05]
  ];
  for(const [field, expected] of expectedFields) {
    if(cached.profile?.[field] !== expected) {
      throw new Error(
        `PRIMARY: cache.profile.${field} = ${JSON.stringify(cached.profile?.[field])}, expected ${JSON.stringify(expected)}`
      );
    }
  }

  // SECONDARY: open the chat + right sidebar; the rows must already be
  // visible from the cache (no relay round-trip allowed).
  const aliceOnB = await readFirstP2PPeerId(pageB);
  if(!aliceOnB) throw new Error('Alice not in Bob mirrors after contact add');

  console.log('[e2e] Bob opens chat with Alice');
  await openChat(pageB, aliceOnB);

  console.log('[e2e] Bob opens right sidebar (User Info)');
  await openRightSidebar(pageB);

  const missing: string[] = [];
  for(const [, value] of expectedFields) {
    const ok = await rightSidebarHasText(pageB, value, 2000);
    console.log(`[e2e] User Info contains "${value}": ${ok ? 'OK' : 'MISSING'}`);
    if(!ok) missing.push(value);
  }
  if(missing.length > 0) {
    throw new Error('SECONDARY: User Info pane missing values: ' + missing.join(', '));
  }

  console.log('[e2e] PASS — User Info shows all kind 0 fields on first open');

  await ctxA.close();
  await ctxB.close();
  await browser.close();
  await relay.stop();
}

main().catch(async(err) => {
  console.error('[e2e] FAIL:', err?.stack || err);
  process.exit(1);
});
