// @ts-nocheck
/*
 * Profile actions — editName, editBio, uploadAvatar, setNip05.
 *
 * Each action drives AppEditProfileTab programmatically:
 *   1. Create the tab via `rootScope.managers`-adjacent slider API.
 *   2. Fill the named InputField value + dispatch 'input' so `isChanged` flips.
 *   3. Click the save button (`.btn-corner`) which triggers the tab's save()
 *      which calls saveOwnProfileLocal() + publishKind0Metadata().
 *
 * uploadAvatar is special: the real DOM path requires a file-picker, so we
 * bypass it by calling saveOwnProfileLocal + publishKind0Metadata directly
 * with a `https://blossom.fuzz/...` URL. The harness Blossom mock still
 * catches any real fetch path the real code might take (defense-in-depth).
 */
import type {ActionSpec, Action, FuzzContext} from '../types';
import * as fc from 'fast-check';

const NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Gus', 'Hank'];
const BIOS = ['Hello world', 'Just a peer', 'Nostr enjoyer', 'Decentralize!', 'Hodl'];
const NIP05_USERS = ['alice', 'bob', 'carol', 'dave'];
const NIP05_DOMAINS = ['example.com', 'nostra.chat', 'test.org'];

/**
 * Open AppEditProfileTab via the slider and wait for the input-wrapper to
 * render. Returns true on success, false if anything is not ready.
 */
async function openEditProfileTab(page: any): Promise<boolean> {
  // Resolve and open the tab from inside the page so we reuse the app's own
  // appSidebarLeft slider. This is more reliable than driving the hamburger
  // menu through fragile bounding-rect taps.
  const opened = await page.evaluate(async () => {
    try{
      const mod = await import('/src/components/sidebarLeft/tabs/editProfile/index.ts');
      const AppEditProfileTab = mod.default;
      const sidebar = (window as any).appSidebarLeft;
      if(!sidebar || !AppEditProfileTab) return false;
      const tab = sidebar.createTab(AppEditProfileTab);
      if(!tab) return false;
      await tab.open();
      return true;
    } catch{
      return false;
    }
  });
  if(!opened) return false;
  try{
    await page.locator('.edit-profile-container').first().waitFor({state: 'visible', timeout: 5000});
    // Inputs render async; give the basic-info section a moment.
    await page.waitForTimeout(400);
  } catch{
    return false;
  }
  return true;
}

async function closeEditProfileTab(page: any): Promise<void> {
  // Saving calls tab.close() internally — but if save is skipped we want
  // to leave no dangling tab open. Send ESC as a best-effort.
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
}

/**
 * Fill the InputField identified by `name` with `value` via the real
 * contenteditable/input element under `.edit-profile-container`. Returns
 * true if fill succeeded.
 */
async function fillInputField(page: any, name: string, value: string): Promise<boolean> {
  return page.evaluate(({name, value}: any) => {
    const root = document.querySelector('.edit-profile-container');
    if(!root) return false;
    // InputField renders either <input name=""> or a contenteditable div
    // with data-name. Handle both.
    const input = root.querySelector(`input[name="${name}"]`) as HTMLInputElement | null;
    if(input) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if(setter) setter.call(input, value);
      else input.value = value;
      input.dispatchEvent(new Event('input', {bubbles: true}));
      input.dispatchEvent(new Event('change', {bubbles: true}));
      return true;
    }
    const div = root.querySelector(`[data-name="${name}"], .input-field-input[data-name="${name}"]`) as HTMLElement | null;
    if(div) {
      div.textContent = value;
      div.dispatchEvent(new InputEvent('input', {bubbles: true}));
      return true;
    }
    // Fallback: the first visible contenteditable .input-field-input whose
    // parent label contains the field name case-insensitively.
    const fields = root.querySelectorAll('.input-field');
    for(const f of Array.from(fields)) {
      const label = f.querySelector('.input-field-label-group, label, .input-field-label');
      if(label && (label.textContent || '').toLowerCase().includes(name.replace('-', ' '))) {
        const editable = f.querySelector('[contenteditable], input') as HTMLElement | null;
        if(editable) {
          if(editable instanceof HTMLInputElement) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if(setter) setter.call(editable, value);
            else editable.value = value;
          } else {
            editable.textContent = value;
          }
          editable.dispatchEvent(new Event('input', {bubbles: true}));
          return true;
        }
      }
    }
    return false;
  }, {name, value});
}

/** Click the floating corner save button. */
async function clickSave(page: any): Promise<boolean> {
  try{
    const btn = page.locator('.edit-profile-container .btn-corner, .btn-corner.is-visible').first();
    await btn.waitFor({state: 'visible', timeout: 3000});
    await btn.click({timeout: 3000});
    // Save is async (upload → cache → publish → close). Give it time.
    await page.waitForTimeout(1200);
    return true;
  } catch{
    return false;
  }
}

export const editNameAction: ActionSpec = {
  name: 'editName',
  weight: 3,
  generateArgs: () => fc.record({
    user: fc.constantFrom('userA', 'userB'),
    // Pick a base name + a 3-char suffix for uniqueness across invocations.
    newName: fc.tuple(fc.constantFrom(...NAMES), fc.string({minLength: 3, maxLength: 5}))
      .map(([a, b]) => `${a}-${b.replace(/[^A-Za-z0-9]/g, 'x').slice(0, 3)}`)
  }),
  async drive(ctx: FuzzContext, action: Action) {
    const u = ctx.users[action.args.user as 'userA' | 'userB'];
    if(!(await openEditProfileTab(u.page))) {action.skipped = true; return action;}
    const filled = await fillInputField(u.page, 'display-name', action.args.newName);
    if(!filled) {await closeEditProfileTab(u.page); action.skipped = true; return action;}
    if(!(await clickSave(u.page))) {await closeEditProfileTab(u.page); action.skipped = true; return action;}
    action.meta = {user: action.args.user, newName: action.args.newName, editedAt: Date.now()};
    return action;
  }
};

export const editBioAction: ActionSpec = {
  name: 'editBio',
  weight: 2,
  generateArgs: () => fc.record({
    user: fc.constantFrom('userA', 'userB'),
    newBio: fc.tuple(fc.constantFrom(...BIOS), fc.string({minLength: 0, maxLength: 20}))
      .map(([a, b]) => `${a} ${b}`.trim().slice(0, 70))
  }),
  async drive(ctx: FuzzContext, action: Action) {
    const u = ctx.users[action.args.user as 'userA' | 'userB'];
    if(!(await openEditProfileTab(u.page))) {action.skipped = true; return action;}
    const filled = await fillInputField(u.page, 'bio', action.args.newBio);
    if(!filled) {await closeEditProfileTab(u.page); action.skipped = true; return action;}
    if(!(await clickSave(u.page))) {await closeEditProfileTab(u.page); action.skipped = true; return action;}
    action.meta = {user: action.args.user, newBio: action.args.newBio, editedAt: Date.now()};
    return action;
  }
};

/**
 * Avatar upload — the real UI path requires a <input type=file> picker we
 * can't drive headlessly without a fixture. Instead, we generate bytes,
 * POST them to the Blossom mock through the browser's fetch (exercising
 * the mock path) to get a deterministic sha-based URL, then call
 * saveOwnProfileLocal + publishKind0Metadata from inside the page. This
 * produces a real kind-0 event with `picture: https://blossom.fuzz/...`
 * and a real entry in window.__fuzzBlossomUploads.
 */
export const uploadAvatarAction: ActionSpec = {
  name: 'uploadAvatar',
  weight: 1,
  generateArgs: () => fc.record({
    user: fc.constantFrom('userA', 'userB'),
    size: fc.integer({min: 16, max: 128})
  }),
  async drive(ctx: FuzzContext, action: Action) {
    const u = ctx.users[action.args.user as 'userA' | 'userB'];
    const res = await u.page.evaluate(async ({size}: any) => {
      try{
        // Build a minimal PNG-like payload (signature + fill). Size param
        // controls deterministic length for reproducibility.
        const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        const bytes = new Uint8Array(sig.length + size);
        for(let i = 0; i < sig.length; i++) bytes[i] = sig[i];
        for(let i = 0; i < size; i++) bytes[sig.length + i] = (i * 7) & 0xff;

        // Hit the Blossom mock (any upload-matching URL). This will be
        // intercepted by harness addInitScript and return a blossom.fuzz URL.
        const res = await fetch('https://fuzz-blossom.local/upload', {
          method: 'PUT',
          body: bytes
        });
        const json = await res.json();
        const url: string = json.url;

        const nowSec = Math.floor(Date.now() / 1000);
        const {saveOwnProfileLocal} = await import('/src/lib/nostra/own-profile-sync.ts');
        const {publishKind0Metadata} = await import('/src/lib/nostra/nostr-relay.ts');

        // Read current profile to merge with new picture field.
        const rawCache = localStorage.getItem('nostra-profile-cache');
        let existing: any = {};
        try{ existing = rawCache ? (JSON.parse(rawCache).profile || {}) : {}; } catch{}

        const profile = {
          ...existing,
          picture: url
        };

        saveOwnProfileLocal(profile, nowSec);
        try{
          await publishKind0Metadata(profile);
        } catch{ /* publish may fail if relay pool not ready — harmless */ }

        return {ok: true, url};
      } catch(err: any) {
        return {ok: false, error: String(err && err.message || err)};
      }
    }, {size: action.args.size});
    if(!res?.ok) {action.skipped = true; return action;}
    action.meta = {user: action.args.user, avatarUrl: res.url, editedAt: Date.now()};
    return action;
  }
};

export const setNip05Action: ActionSpec = {
  name: 'setNip05',
  weight: 1,
  generateArgs: () => fc.record({
    user: fc.constantFrom('userA', 'userB'),
    nip05: fc.tuple(
      fc.constantFrom(...NIP05_USERS),
      fc.constantFrom(...NIP05_DOMAINS)
    ).map(([u, d]) => `${u}@${d}`)
  }),
  async drive(ctx: FuzzContext, action: Action) {
    const u = ctx.users[action.args.user as 'userA' | 'userB'];
    if(!(await openEditProfileTab(u.page))) {action.skipped = true; return action;}
    const filled = await fillInputField(u.page, 'nip05-alias', action.args.nip05);
    if(!filled) {await closeEditProfileTab(u.page); action.skipped = true; return action;}
    // The NIP-05 section has its own async verify flow gated by DNS. Rather
    // than click Verify (which would hit the network), stamp the identity
    // field directly via the saveOwnProfileLocal path so the cache reflects
    // it. This exercises the kind-0 nip05 propagation path without depending
    // on verify() roundtripping.
    const ok = await u.page.evaluate(async ({nip05}: any) => {
      try{
        const nowSec = Math.floor(Date.now() / 1000);
        const {saveOwnProfileLocal} = await import('/src/lib/nostra/own-profile-sync.ts');
        const {publishKind0Metadata} = await import('/src/lib/nostra/nostr-relay.ts');
        const rawCache = localStorage.getItem('nostra-profile-cache');
        let existing: any = {};
        try{ existing = rawCache ? (JSON.parse(rawCache).profile || {}) : {}; } catch{}
        const profile = {...existing, nip05};
        saveOwnProfileLocal(profile, nowSec);
        try{ await publishKind0Metadata(profile); } catch{}
        return true;
      } catch{ return false; }
    }, {nip05: action.args.nip05});
    await closeEditProfileTab(u.page);
    if(!ok) {action.skipped = true; return action;}
    action.meta = {user: action.args.user, nip05: action.args.nip05, editedAt: Date.now()};
    return action;
  }
};
