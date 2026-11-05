/**
 * Contacts redesign (Phantom | Human | Provider): the per-contact prefs store,
 * the Human avatar, and the New Contact modal's per-type fields.
 */
import 'fake-indexeddb/auto';
import {describe, it, expect, beforeAll, beforeEach, afterEach, vi} from 'vitest';
import {
  getContactPrefs,
  setContactPrefs,
  clearContactPrefs,
  resolveContactKind,
  kindSupportsLocalTools,
  _resetContactPrefsForTests
} from '@lib/phantomchat/contact-prefs';
import {
  generateDicebearAvatar,
  generateHumanAvatarSvg,
  generatePhantomAvatarSvg,
  clearDicebearCache
} from '@helpers/generateDicebearAvatar';
import {npubEncode} from '@lib/phantomchat/nostr-identity';
import {deleteP2PContact, forgetContact} from '@lib/phantomchat/provider-contacts';
import {readFileSync} from 'node:fs';
import {LocalToolsHost} from '../../../electron/localTools/host';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const HEX = '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917';
const NPUB = npubEncode(HEX);

let blobCounter = 0;
vi.stubGlobal('URL', Object.assign(function() {} as any, {
  createObjectURL: (_blob: Blob) => `blob:mock-${++blobCounter}`,
  revokeObjectURL: (_url: string) => {}
}));

const addP2PContact = vi.fn(async(opts: any) => ({
  hexPubkey: HEX,
  peerId: 1000000000000001,
  peerIdTweb: 1000000000000001,
  displayName: opts.nickname || 'P2P User',
  isNew: true
}));
vi.mock('@lib/phantomchat/add-p2p-contact', () => ({addP2PContact: (o: any) => addP2PContact(o)}));

// openAddContactPane talks to the right sidebar; the real one needs the whole app.
const fakeSidebar = vi.hoisted(() => ({
  isTabExists: vi.fn((): boolean => false),
  createTab: vi.fn(),
  toggleSidebar: vi.fn()
}));
vi.mock('@components/sidebarRight', () => ({default: fakeSidebar}));
// The pane's InputField / Row / CheckboxField pull in the worker proxy, which jsdom cannot start.
vi.mock('@lib/apiManagerProxy', () => {
  const anyObj: any = new Proxy(function() {}, {
    get: (_t, prop) => prop === 'then' ? undefined : anyObj,
    apply: () => anyObj
  });
  return {default: anyObj};
});
// Row's import graph needs the app state store (see group-edit-pane.test.ts,
// which stubs it too). The stub keeps what the pane relies on: a label row
// that carries the checkbox field and its Enabled / Disabled subtitle.
vi.mock('@components/row', () => ({default: class {
  container = document.createElement('label');
  constructor(options: any) {
    this.container.classList.add('row');
    const subtitle = document.createElement('div');
    subtitle.className = 'row-subtitle';
    const field = options.checkboxField;
    if(field) {
      this.container.append(field.label);
      if(options.withCheckboxSubtitle) {
        field.input.addEventListener('change', () => subtitle.textContent = field.input.checked ? 'Enabled' : 'Disabled');
      }
    }
    this.container.append(subtitle);
  }
}}));

async function freshDb() {
  _resetContactPrefsForTests();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('phantomchat-contact-prefs');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

describe('contact-prefs store', () => {
  beforeEach(freshDb);

  it('keeps a Provider contact\'s prefs and throws when its persona delete fails', async() => {
    await setContactPrefs(HEX, {kind: 'provider', persona: 'claude-2'});
    const failing = vi.fn(async() => ({ok: false as const, error: {code: 'failed', message: 'engine down'}}));
    await expect(forgetContact(HEX, failing)).rejects.toThrow('engine down');
    expect(failing).toHaveBeenCalledWith('personas.delete', {persona: 'claude-2'});
    _resetContactPrefsForTests();
    expect((await getContactPrefs(HEX))?.persona).toBe('claude-2');
    // No engine to ask is a failure too, never a silent forget.
    await expect(forgetContact(HEX, undefined)).rejects.toThrow();
    expect((await getContactPrefs(HEX))?.persona).toBe('claude-2');

    const ok = vi.fn(async() => ({ok: true as const, value: null as unknown}));
    await forgetContact(HEX, ok);
    expect(await getContactPrefs(HEX)).toBeUndefined();
  });

  it('deleting a Phantom contact revokes its Local tools grant, also after a host restart', async() => {
    const OWNER = 'a'.repeat(64);
    const dataDir = mkdtempSync(join(tmpdir(), 'lt-forget-'));
    const pending = new Map<string, (r: any) => void>();
    const tools = {
      run: vi.fn((runId: string, _tool: string, args: any) => args.hang ?
        new Promise<any>((resolve) => pending.set(runId, resolve)) :
        Promise.resolve({status: 'ok' as const, output: 'ran', exit: 0})),
      cancel: vi.fn(async(runId: string) => pending.get(runId)?.({status: 'error', output: 'aborted'}))
    };
    const newHost = () => {
      const host = new LocalToolsHost({dataDir, tools, confirm: async() => true, deviceName: 'pc'});
      host.setOwner(OWNER);
      return host;
    };
    const call = (host: LocalToolsHost, callId: string, args: any = {command: 'ls'}) =>
      host.handleMessage(HEX, {t: 'call', callId, deviceId: (host as any).state.deviceId, tool: 'bash', args, expiresAt: Date.now() + 60_000}, null);
    const desktop = (host: LocalToolsHost) => (window as any).phantomchatDesktop = {localTools: {
      setOwner: async() => ({enabled: host.enabled(), capability: null as unknown}),
      enabled: async() => host.enabled(),
      set: (p: string, on: boolean, name: string) => host.setLocalAccess(p, on, name),
      message: (s: string, payload: unknown, g: any) => host.handleMessage(s, payload as any, g)
    }};
    try {
      const host = newHost();
      desktop(host);
      expect((await host.setLocalAccess(HEX, true, 'Kai')).enabled).toBe(true);
      await setContactPrefs(HEX, {kind: 'phantom', localTools: true});
      const running = call(host, 'c1', {hang: true});
      await new Promise((r) => setTimeout(r, 0));

      await forgetContact(HEX, undefined);
      expect(await getContactPrefs(HEX)).toBeUndefined();
      // The running call was cancelled and a fresh one gets nothing.
      expect(tools.cancel).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(await running)).toContain('cancelled');
      expect(await call(host, 'c2')).toEqual([]);

      // A restarted host reads the same local-access.json: still revoked.
      const restarted = newHost();
      expect(restarted.enabled()).not.toContain(HEX);
      expect(await call(restarted, 'c3')).toEqual([]);
      expect(tools.run).toHaveBeenCalledTimes(1);
    } finally {
      delete (window as any).phantomchatDesktop;
      rmSync(dataDir, {recursive: true, force: true});
    }
  });

  it('keeps the contact when its Local tools revoke fails', async() => {
    await setContactPrefs(HEX, {kind: 'phantom', localTools: true});
    (window as any).phantomchatDesktop = {localTools: {message: async(): Promise<unknown[]> => [], set: async() => {
      throw new Error('main gone');
    }}};
    try {
      await expect(forgetContact(HEX, undefined)).rejects.toThrow('main gone');
      expect((await getContactPrefs(HEX))?.localTools).toBe(true);
    } finally {
      delete (window as any).phantomchatDesktop;
    }
  });

  it('deleteP2PContact revokes first and keeps the conversation when the revoke fails', async() => {
    const order: string[] = [];
    let fail = true;
    (window as any).phantomchatDesktop = {localTools: {message: async(): Promise<unknown[]> => [], set: async() => {
      order.push('revoke');
      if(fail) throw new Error('main gone');
      return {enabled: false, notify: null as unknown};
    }}};
    const chatAPI = {deleteConversation: vi.fn(async() => {
      order.push('conversation');
    })};
    try {
      await setContactPrefs(HEX, {kind: 'phantom', localTools: true});
      await expect(deleteP2PContact(HEX, chatAPI, undefined)).rejects.toThrow('main gone');
      expect(chatAPI.deleteConversation).not.toHaveBeenCalled();
      fail = false;
      order.length = 0;
      await deleteP2PContact(HEX, chatAPI, undefined);
      expect(order).toEqual(['revoke', 'conversation']);
      expect(await getContactPrefs(HEX)).toBeUndefined();
    } finally {
      delete (window as any).phantomchatDesktop;
    }
  });

  it('every P2P contact delete in the UI goes through the shared deleteContact path', () => {
    for(const file of ['src/components/sidebarRight/tabs/editContact.ts', 'src/components/sidebarLeft/tabs/contacts.ts']) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).toContain('confirmDeleteContact(peerId)');
      expect(src, file).toContain('await deleteContact(');
      expect(src.match(/deleteConversation\(/g), file).toBeNull();
      expect(src.match(/deleteP2PContact\(/g), file).toBeNull();
    }
    expect(readFileSync('src/lib/phantomchat/delete-contact.ts', 'utf8')).toContain('deleteP2PContact(pubkey, chatAPI');
  });

  it('round-trips kind and localTools, and survives a cache reset', async() => {
    await setContactPrefs(HEX, {kind: 'phantom', localTools: true});
    _resetContactPrefsForTests();
    const row = await getContactPrefs(HEX);
    expect(row?.kind).toBe('phantom');
    expect(row?.localTools).toBe(true);
  });

  it('merges a partial patch instead of wiping the other field', async() => {
    await setContactPrefs(HEX, {kind: 'provider', localTools: true});
    await setContactPrefs(HEX, {localTools: false});
    const row = await getContactPrefs(HEX);
    expect(row?.kind).toBe('provider');
    expect(row?.localTools).toBe(false);
  });

  it('rejects an unknown kind and a non-hex pubkey', async() => {
    await expect(setContactPrefs(HEX, {kind: 'robot' as any})).rejects.toThrow();
    await expect(setContactPrefs(NPUB, {kind: 'human'})).rejects.toThrow();
  });

  it('clear removes the row', async() => {
    await setContactPrefs(HEX, {kind: 'human'});
    await clearContactPrefs(HEX);
    _resetContactPrefsForTests();
    expect(await getContactPrefs(HEX)).toBeUndefined();
  });

  it('a stored kind wins; otherwise only a bot flag means phantom', () => {
    expect(resolveContactKind('human', true)).toBe('human');
    expect(resolveContactKind(undefined, true)).toBe('phantom');
    expect(resolveContactKind(undefined, false)).toBeUndefined();
  });

  it('Local tools only for Phantom and Provider', () => {
    expect(kindSupportsLocalTools('phantom')).toBe(true);
    expect(kindSupportsLocalTools('provider')).toBe(true);
    expect(kindSupportsLocalTools('human')).toBe(false);
    expect(kindSupportsLocalTools(undefined)).toBe(false);
  });
});

describe('Human avatar', () => {
  beforeEach(() => clearDicebearCache());

  it('is deterministic and different from the phantom sigil', () => {
    const a = generateHumanAvatarSvg(HEX);
    expect(generateHumanAvatarSvg(HEX)).toBe(a);
    expect(a).not.toBe(generatePhantomAvatarSvg(HEX));
    expect(a).toContain('Shoulders');
  });

  it('is cached separately from the phantom avatar for the same key', async() => {
    const phantom = await generateDicebearAvatar(HEX);
    const human = await generateDicebearAvatar(HEX, false, true);
    expect(human).not.toBe(phantom);
    expect(await generateDicebearAvatar(HEX, false, true)).toBe(human);
    // A group never renders as a human.
    expect(await generateDicebearAvatar(HEX, true, true)).toBe(await generateDicebearAvatar(HEX, true));
  });
});

function desktopLocalTools(allow: boolean) {
  return {
    setOwner: vi.fn(async() => ({enabled: [] as string[], capability: null as unknown})),
    enabled: vi.fn(async() => [] as string[]),
    set: vi.fn(async(_pubkey: string, on: boolean) => ({enabled: allow && on, notify: null as unknown})),
    message: vi.fn(async() => [] as unknown[])
  };
}

describe('New Contact pane', () => {
  // The pane module's component graph is slow to transform on a cold run.
  beforeAll(async() => {
    await import('@components/sidebarRight/tabs/addContact');
  }, 60000);

  const managers: any = {appMessagesManager: {togglePeerMute: vi.fn(async() => {})}};
  const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  const visible = (id: string) => !!q(id) && (q(id).closest('[data-testid$="-row"]') as HTMLElement || q(id)).style.display !== 'none';

  beforeEach(async() => {
    await freshDb();
    addP2PContact.mockClear();
    managers.appMessagesManager.togglePeerMute.mockClear();
    delete (window as any).phantomchatDesktop;
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  // The pane is a right-sidebar tab; its form is mounted here on its own so
  // the test does not need the sidebar. onDone is the pane's close.
  let done: ReturnType<typeof vi.fn>;
  async function open(npub?: string) {
    const {createAddContactForm} = await import('@components/sidebarRight/tabs/addContact');
    const added = vi.fn();
    done = vi.fn();
    const form = createAddContactForm({managers, npub, onContactAdded: added, onDone: done, isAlive: () => true});
    document.body.append(form.section, form.submitBtn);
    await new Promise((r) => setTimeout(r, 0));
    return added;
  }

  it('offers Phantom and Human in the browser, never Provider or Scan', async() => {
    await open();
    expect(q('add-contact-kind-phantom')).toBeTruthy();
    expect(q('add-contact-kind-human')).toBeTruthy();
    expect(q('add-contact-kind-provider')).toBeNull();
    expect(q('add-contact-scan-local').style.display).toBe('none');
  });

  it('Phantom shows Local tools only with the desktop gate; Human never', async() => {
    await open();
    expect(visible('add-contact-local-tools')).toBe(false);
    document.body.innerHTML = '';
    (window as any).phantomchatDesktop = {localTools: desktopLocalTools(true)};
    await open();
    expect(visible('add-contact-local-tools')).toBe(true);
    q('add-contact-kind-human').click();
    expect(visible('add-contact-local-tools')).toBe(false);
    expect(visible('add-contact-notifications')).toBe(true);
  });

  it('draws QR and Scan as icon buttons inside the npub field', async() => {
    (window as any).phantomchatDesktop = {localPersonas: {list: vi.fn(async() => ({ok: true, value: [] as unknown[]})), allow: vi.fn()}};
    await open();
    const npub = q('add-contact-npub');
    const field = npub.parentElement;
    const qr = q('add-contact-scan-qr');
    const scan = q('add-contact-scan-local');
    expect(qr.parentElement).toBe(field);
    expect(scan.parentElement).toBe(field);
    expect(qr.textContent).not.toContain('QR'); // an icon glyph, not the word "QR"
    expect(qr.querySelector('.tgico')).toBeTruthy();
    expect(scan.querySelector('.tgico')).toBeTruthy();
    expect(scan.getAttribute('aria-label')).toBeTruthy();
    expect(scan.style.display).toBe('flex');
  });

  it('never reuses the app-wide block button inside the form', async() => {
    await open();
    const dialog = q('add-contact-dialog');
    // .btn-primary is width:100%/height:54px, so a control carrying it blows the
    // row past the pane width and adds a horizontal scrollbar.
    expect(dialog.querySelectorAll('.btn-primary, .btn-transparent').length).toBe(0);
  });

  it('is built from the Edit pane parts: input fields, checkbox Rows, corner check button', async() => {
    await open();
    expect(q('add-contact-name').closest('.input-field')).toBeTruthy();
    expect(q('add-contact-npub').closest('.input-field')).toBeTruthy();
    expect(q('add-contact-name').closest('.input-wrapper')).toBeTruthy();
    for(const id of ['add-contact-notifications', 'add-contact-local-tools']) {
      expect(q(id).closest('.checkbox-field')).toBeTruthy();
      expect(q(id).closest('.row')).toBe(q(id + '-row'));
    }
    const submit = q('add-contact-submit');
    expect(submit.classList.contains('btn-corner')).toBe(true);
    expect(submit.classList.contains('is-visible')).toBe(true);
    // Only the user's own profile picture is editable — the New Contact pane
    // shows a display-only avatar.
    expect(q('add-contact-avatar').closest('.avatar-edit')).toBeNull();
  });

  it('shows the Edit pane\'s Enabled / Disabled subtitle from the start', async() => {
    await open();
    expect(q('add-contact-notifications-row').querySelector('.row-subtitle')?.textContent).toBeTruthy();
  });

  it('flips a toggle when its row is clicked', async() => {
    await open();
    const input = q('add-contact-notifications') as HTMLInputElement;
    expect(input.checked).toBe(true);
    q('add-contact-notifications-row').click();
    expect(input.checked).toBe(false);
    q('add-contact-notifications-row').click();
    expect(input.checked).toBe(true);
  });

  it('closes the pane after a successful add, and only then', async() => {
    const added = await open('npub1nope');
    q('add-contact-submit').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(done).not.toHaveBeenCalled();
    (q('add-contact-npub') as HTMLInputElement).value = NPUB;
    q('add-contact-submit').click();
    await vi.waitFor(() => expect(added).toHaveBeenCalled());
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('keeps the pane open with an error when the add fails', async() => {
    addP2PContact.mockImplementationOnce(async() => { throw new Error('relay down'); });
    await open(NPUB);
    q('add-contact-submit').click();
    await vi.waitFor(() => expect(q('add-contact-error').textContent).toBe('Failed to add contact'));
    expect(done).not.toHaveBeenCalled();
    expect((q('add-contact-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('adds once when the button and Enter are both pressed', async() => {
    let release!: () => void;
    addP2PContact.mockImplementationOnce(async(opts: any) => {
      await new Promise<void>((r) => release = r);
      return {hexPubkey: HEX, peerId: 1, peerIdTweb: 1, displayName: opts.nickname, isNew: true};
    });
    const added = await open(NPUB);
    q('add-contact-submit').click();
    // Enter does not go through the (now disabled) button.
    q('add-contact-npub').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    await vi.waitFor(() => expect(addP2PContact).toHaveBeenCalled());
    release();
    await vi.waitFor(() => expect(added).toHaveBeenCalled());
    expect(addP2PContact).toHaveBeenCalledTimes(1);
  });

  it('Enter in the npub field adds', async() => {
    const added = await open(NPUB);
    q('add-contact-npub').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    await vi.waitFor(() => expect(added).toHaveBeenCalled());
  });

  it('has no last-name or notes field', async() => {
    await open();
    const dialog = q('add-contact-dialog');
    expect(dialog.querySelectorAll('input[type="text"]').length).toBe(2); // name + npub
  });

  it('adding a Human saves the kind before the add and never stores Local tools', async() => {
    const added = await open(NPUB);
    q('add-contact-kind-human').click();
    (q('add-contact-name') as HTMLInputElement).value = 'Corinne';
    let kindAtAdd: string | undefined;
    addP2PContact.mockImplementationOnce(async(opts: any) => {
      kindAtAdd = (await getContactPrefs(HEX))?.kind;
      return {hexPubkey: HEX, peerId: 1, peerIdTweb: 1, displayName: opts.nickname, isNew: true};
    });
    q('add-contact-submit').click();
    await vi.waitFor(() => expect(added).toHaveBeenCalled());
    expect(kindAtAdd).toBe('human');
    expect(addP2PContact.mock.calls[0][0]).toMatchObject({pubkey: NPUB, nickname: 'Corinne', deliberate: true});
    expect((await getContactPrefs(HEX))?.localTools).toBe(false);
    expect(managers.appMessagesManager.togglePeerMute).not.toHaveBeenCalled();
  });

  it('Phantom with Local tools on and Notifications off is stored, allowed by main, and muted', async() => {
    const localTools = desktopLocalTools(true);
    (window as any).phantomchatDesktop = {localTools};
    const added = await open(NPUB);
    (q('add-contact-local-tools') as HTMLInputElement).checked = true;
    (q('add-contact-notifications') as HTMLInputElement).checked = false;
    q('add-contact-submit').click();
    await vi.waitFor(() => expect(added).toHaveBeenCalled());
    await vi.waitFor(() => expect(managers.appMessagesManager.togglePeerMute).toHaveBeenCalledWith({peerId: 1000000000000001, mute: true}));
    expect(localTools.set).toHaveBeenCalledWith(HEX, true, expect.any(String));
    expect(await getContactPrefs(HEX)).toMatchObject({kind: 'phantom', localTools: true});
  });

  it('a Cancel in main\'s Allow dialog leaves Local tools off; the contact is still added', async() => {
    (window as any).phantomchatDesktop = {localTools: desktopLocalTools(false)};
    const added = await open(NPUB);
    (q('add-contact-local-tools') as HTMLInputElement).checked = true;
    q('add-contact-submit').click();
    await vi.waitFor(() => expect(added).toHaveBeenCalled());
    await vi.waitFor(async() => expect((await getContactPrefs(HEX))?.localTools).toBe(false));
    expect(addP2PContact).toHaveBeenCalled();
  });

  it('a failed add puts an existing contact\'s prefs back', async() => {
    await setContactPrefs(HEX, {kind: 'phantom', localTools: true});
    const before = await getContactPrefs(HEX);
    addP2PContact.mockImplementationOnce(async() => { throw new Error('relay down'); });
    const {addTypedContact} = await import('@components/sidebarRight/tabs/addContact');
    await expect(addTypedContact(managers, {
      npub: NPUB, nickname: 'X', kind: 'human', localTools: false, notifications: true
    })).rejects.toThrow('relay down');
    expect(await getContactPrefs(HEX)).toEqual(before);
    _resetContactPrefsForTests();
    expect(await getContactPrefs(HEX)).toEqual(before);
  });

  it('a failed add of a new npub leaves no prefs row behind', async() => {
    addP2PContact.mockImplementationOnce(async() => { throw new Error('relay down'); });
    const {addTypedContact} = await import('@components/sidebarRight/tabs/addContact');
    await expect(addTypedContact(managers, {
      npub: NPUB, nickname: 'X', kind: 'phantom', localTools: true, notifications: true
    })).rejects.toThrow('relay down');
    expect(await getContactPrefs(HEX)).toBeUndefined();
    _resetContactPrefsForTests();
    expect(await getContactPrefs(HEX)).toBeUndefined();
  });

  it('a prefs store that cannot write never blocks the add', async() => {
    _resetContactPrefsForTests();
    const openSpy = vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    try {
      const {addTypedContact} = await import('@components/sidebarRight/tabs/addContact');
      const result = await addTypedContact(managers, {
        npub: NPUB, nickname: 'Corinne', kind: 'human', localTools: false, notifications: true
      } as any);
      expect(result.hexPubkey).toBe(HEX);
      expect(addP2PContact).toHaveBeenCalledTimes(1);
    } finally {
      openSpy.mockRestore();
      _resetContactPrefsForTests();
    }
  });

  it('rejects a bad npub without adding', async() => {
    await open('npub1nope');
    q('add-contact-submit').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(q('add-contact-error').textContent).toBe('Invalid npub format');
    expect(addP2PContact).not.toHaveBeenCalled();
  });

  it('opens one pane at a time, and opens it before showing the sidebar', async() => {
    const {openAddContactPane, default: AppAddContactTab} = await import('@components/sidebarRight/tabs/addContact');
    const order: string[] = [];
    const tabs: any[] = [];
    fakeSidebar.isTabExists.mockImplementation(() => tabs.length > 0);
    fakeSidebar.createTab.mockImplementation((ctor: any) => {
      expect(ctor).toBe(AppAddContactTab);
      const tab = {open: vi.fn(async() => { order.push('open'); }), options: undefined as any};
      tabs.push(tab);
      return tab;
    });
    fakeSidebar.toggleSidebar.mockImplementation(() => { order.push('show'); });
    await openAddContactPane({managers, npub: NPUB});
    await openAddContactPane({managers, npub: NPUB});
    expect(tabs.length).toBe(1);
    expect(tabs[0].options).toMatchObject({npub: NPUB});
    expect(order.slice(0, 2)).toEqual(['open', 'show']);
  });

  it('Provider: no Validate button; save checks the token, names the persona from the contact name and allows my npub', async() => {
    // A real session: loadIdentity() is null, the own pubkey is only on window.
    (window as any).__phantomchatOwnPubkey = HEX;
    const OWN = NPUB;
    const PROVIDER_NPUB = npubEncode('a'.repeat(64));
    const calls: Array<[string, any]> = [];
    const call = vi.fn(async(method: string, params?: any) => {
      calls.push([method, params]);
      switch(method) {
        case 'providers.list': return {ok: true, value: [{id: 'phantomops', label: 'PhantomOps', checkable: true, autoModel: true, defaultModel: 'auto'}]};
        case 'providers.check': return {ok: true, value: {status: 'verified', models: [] as unknown[]}};
        case 'personas.list': return {ok: true, value: ['phantomops']};
        case 'persona.phantomchat.start': return {ok: true, value: {npub: PROVIDER_NPUB, state: 'running'}};
        default: return {ok: true, value: {}};
      }
    });
    (window as any).phantomchatDesktop = {phantombot: {call}};
    try {
      const added = await open();
      await vi.waitFor(() => expect(q('add-contact-kind-provider')).toBeTruthy());
      q('add-contact-kind-provider').click();
      await vi.waitFor(() => expect(q('add-contact-provider-select-value').textContent).toBe('PhantomOps'));
      expect(q('add-contact-provider-validate')).toBeNull();
      (q('add-contact-name') as HTMLInputElement).value = 'Phantom Ops!';
      (q('add-contact-provider-token') as HTMLInputElement).value = 'pok_test';
      addP2PContact.mockImplementationOnce(async(opts: any) => ({hexPubkey: 'a'.repeat(64), peerId: 2, peerIdTweb: 2, displayName: opts.nickname, isNew: true}));
      q('add-contact-submit').click();
      await vi.waitFor(() => expect(added).toHaveBeenCalled());
      expect(q('add-contact-error').textContent).toBe('');
      const methods = calls.map(([m]) => m);
      expect(methods.indexOf('providers.check')).toBeLessThan(methods.indexOf('personas.create'));
      expect(calls.find(([m]) => m === 'personas.create')?.[1]).toMatchObject({persona: 'phantomops-2'});
      expect(calls.find(([m]) => m === 'persona.phantomchat.allow')?.[1]).toMatchObject({npub: OWN});
    } finally {
      delete (window as any).__phantomchatOwnPubkey;
    }
  });

  it('Provider: a rejected token stops the save before any persona exists', async() => {
    (window as any).__phantomchatOwnPubkey = HEX;
    const call = vi.fn(async(method: string) => {
      if(method === 'providers.list') return {ok: true, value: [{id: 'phantomops', label: 'PhantomOps', checkable: true, autoModel: true, defaultModel: 'auto'}]};
      if(method === 'providers.check') return {ok: true, value: {status: 'invalid', detail: '401', models: [] as unknown[]}};
      return {ok: true, value: {}};
    });
    (window as any).phantomchatDesktop = {phantombot: {call}};
    try {
      await open();
      await vi.waitFor(() => expect(q('add-contact-kind-provider')).toBeTruthy());
      q('add-contact-kind-provider').click();
      await vi.waitFor(() => expect(q('add-contact-provider-select-value').textContent).toBe('PhantomOps'));
      (q('add-contact-provider-token') as HTMLInputElement).value = 'pok_bad';
      q('add-contact-submit').click();
      await vi.waitFor(() => expect(q('add-contact-error').textContent).toBe('The provider rejected this token'));
      expect(call.mock.calls.map(([m]) => m)).not.toContain('personas.create');
    } finally {
      delete (window as any).__phantomchatOwnPubkey;
    }
  });

  it('Provider: the picker is a searchable sheet, PhantomOps pinned first, no native select', async() => {
    const call = vi.fn(async(method: string) => {
      if(method === 'providers.list') return {ok: true, value: [
        {id: 'cloudflare-ai-gateway', label: 'Cloudflare AI Gateway'},
        {id: 'xai', label: 'xAI'},
        {id: 'anthropic', label: 'Anthropic'},
        {id: 'phantomops', label: 'PhantomOps', autoModel: true, defaultModel: 'auto'}
      ]};
      return {ok: true, value: {}};
    });
    (window as any).phantomchatDesktop = {phantombot: {call}};
    await open();
    await vi.waitFor(() => expect(q('add-contact-kind-provider')).toBeTruthy());
    q('add-contact-kind-provider').click();
    await vi.waitFor(() => expect(q('add-contact-provider-select-value').textContent).toBe('PhantomOps'));
    // A native <select> on a phone is a full-screen OS wheel with no search;
    // the pane renders its own sheet instead.
    expect(q('add-contact-provider-select').tagName).toBe('BUTTON');
    expect(document.querySelector('select')).toBeNull();

    q('add-contact-provider-select').click();
    const rows = Array.from(document.querySelectorAll('[data-testid^="add-contact-provider-select-option-"]'));
    expect(rows.map((row) => row.getAttribute('data-testid')!.replace('add-contact-provider-select-option-', '')))
    .toEqual(['phantomops', 'anthropic', 'cloudflare-ai-gateway', 'xai']);
  });

  it('Provider: a provider that needs a model shows the model picker before the token, and the token loads its models', async() => {
    (window as any).__phantomchatOwnPubkey = HEX;
    const calls: Array<[string, any]> = [];
    const call = vi.fn(async(method: string, params?: any) => {
      calls.push([method, params]);
      switch(method) {
        case 'providers.list': return {ok: true, value: [
          {id: 'phantomops', label: 'PhantomOps', autoModel: true, defaultModel: 'auto'},
          {id: 'anthropic', label: 'Anthropic'}
        ]};
        case 'providers.check': return {ok: true, value: {status: 'verified', models: [{id: 'claude-haiku'}, {id: 'claude-sonnet'}]}};
        case 'personas.list': return {ok: true, value: [] as string[]};
        case 'persona.phantomchat.start': return {ok: true, value: {npub: npubEncode('a'.repeat(64)), state: 'running'}};
        default: return {ok: true, value: {}};
      }
    });
    (window as any).phantomchatDesktop = {phantombot: {call}};
    try {
      const added = await open();
      await vi.waitFor(() => expect(q('add-contact-kind-provider')).toBeTruthy());
      q('add-contact-kind-provider').click();
      await vi.waitFor(() => expect(q('add-contact-provider-select-value').textContent).toBe('PhantomOps'));
      // PhantomOps picks its own model: no model picker.
      expect(q('add-contact-provider-model-field').style.display).toBe('none');

      q('add-contact-provider-select').click();
      q('add-contact-provider-select-option-anthropic').click();

      // The picker is there the moment the provider is picked, and says what
      // it waits for instead of turning up after a save.
      expect(q('add-contact-provider-model-field').style.display).toBe('flex');
      expect(q('add-contact-provider-model-value').textContent).toBe('Enter your token to load models');
      expect((q('add-contact-provider-model') as HTMLButtonElement).disabled).toBe(true);
      expect(calls.some(([m]) => m === 'providers.check')).toBe(false);

      const token = q('add-contact-provider-token') as HTMLInputElement;
      token.value = 'sk-ant';
      token.dispatchEvent(new Event('input'));
      token.dispatchEvent(new FocusEvent('blur'));
      await vi.waitFor(() => expect(q('add-contact-provider-model-value').textContent).toBe('claude-haiku'));
      expect((q('add-contact-provider-model') as HTMLButtonElement).disabled).toBe(false);

      // The list is the provider's own, and the user's pick wins over the first.
      q('add-contact-provider-model').click();
      q('add-contact-provider-model-option-claude-sonnet').click();
      expect(q('add-contact-provider-model-value').textContent).toBe('claude-sonnet');

      q('add-contact-submit').click();
      await vi.waitFor(() => expect(added).toHaveBeenCalled());
      expect(calls.find(([m]) => m === 'persona.configure')?.[1].config.brain.native)
      .toMatchObject({provider: 'anthropic', model: 'claude-sonnet'});
      // The blur's check is reused: saving does not ask the provider again.
      expect(calls.filter(([m]) => m === 'providers.check').length).toBe(1);
    } finally {
      delete (window as any).__phantomchatOwnPubkey;
    }
  });

  // A pane harness whose providers.check promises the test settles by hand, so
  // it can let a check for the previous provider land after a switch. Every
  // generation guard in the pane is load-bearing and each one is mutated below.
  async function openWithDeferredChecks() {
    const pending: Array<{resolve: (v: any) => void; reject: (e: any) => void}> = [];
    const calls: Array<[string, any]> = [];
    const call = vi.fn(async(method: string, params?: any) => {
      calls.push([method, params]);
      switch(method) {
        case 'providers.list': return {ok: true, value: [
          {id: 'phantomops', label: 'PhantomOps', autoModel: true, defaultModel: 'auto'},
          {id: 'anthropic', label: 'Anthropic'},
          {id: 'xai', label: 'xAI'}
        ]};
        case 'providers.check': return new Promise((resolve, reject) => { pending.push({resolve, reject}); });
        case 'personas.list': return {ok: true, value: [] as string[]};
        case 'persona.phantomchat.start': return {ok: true, value: {npub: npubEncode('a'.repeat(64)), state: 'running'}};
        default: return {ok: true, value: {}};
      }
    });
    (window as any).phantomchatDesktop = {phantombot: {call}};
    const added = await open();
    await vi.waitFor(() => expect(q('add-contact-kind-provider')).toBeTruthy());
    q('add-contact-kind-provider').click();
    await vi.waitFor(() => expect(q('add-contact-provider-select-value').textContent).toBe('PhantomOps'));
    return {pending, calls, added};
  }

  const pickProvider = (id: string) => {
    q('add-contact-provider-select').click();
    q(`add-contact-provider-select-option-${id}`).click();
  };

  it('Provider: a check for the provider the user switched away from never speaks for the new one', async() => {
    // The status line and the model list are part of the provider/token pair:
    // a stale verdict that lands tells the user xAI rejected a key it never saw,
    // and fills xAI's model picker with Anthropic's models.
    const {pending} = await openWithDeferredChecks();
    pickProvider('anthropic');
    const token = q('add-contact-provider-token') as HTMLInputElement;
    token.value = 'sk-bad';
    token.dispatchEvent(new Event('input'));
    token.dispatchEvent(new FocusEvent('blur'));
    await vi.waitFor(() => expect(pending.length).toBe(1));
    expect(q('add-contact-provider-status').textContent).toBe('Checking token...');

    // Switch provider while Anthropic's check is still in flight.
    pickProvider('xai');
    await vi.waitFor(() => expect(pending.length).toBe(2));
    expect(q('add-contact-provider-status').textContent).toBe('Checking token...');

    // The stale verdict belongs to Anthropic: it must not land on xAI.
    pending[0].resolve({ok: true, value: {status: 'verified', models: [{id: 'claude-sonnet'}]}});
    await new Promise((r) => setTimeout(r, 0));
    expect(q('add-contact-provider-status').textContent).toBe('Checking token...');
    expect(q('add-contact-provider-model-value').textContent).toBe('Enter your token to load models');
    expect((q('add-contact-provider-model') as HTMLButtonElement).disabled).toBe(true);

    // The check for the pair on screen still lands normally.
    pending[1].resolve({ok: true, value: {status: 'verified', models: [{id: 'grok-4'}]}});
    await vi.waitFor(() => expect(q('add-contact-provider-status').textContent).toBe('Token verified'));
    await vi.waitFor(() => expect(q('add-contact-provider-model-value').textContent).toBe('grok-4'));
  });

  it('Provider: a check that fails after the provider changed reports nothing', async() => {
    // A rejection is the same stale write: 'network down' on xAI's status line
    // would be Anthropic's failure.
    const {pending} = await openWithDeferredChecks();
    pickProvider('anthropic');
    const token = q('add-contact-provider-token') as HTMLInputElement;
    token.value = 'sk-a';
    token.dispatchEvent(new Event('input'));
    token.dispatchEvent(new FocusEvent('blur'));
    await vi.waitFor(() => expect(pending.length).toBe(1));
    pickProvider('xai');
    await vi.waitFor(() => expect(pending.length).toBe(2));

    pending[0].reject(new Error('network down'));
    await new Promise((r) => setTimeout(r, 0));
    expect(q('add-contact-provider-status').textContent).toBe('Checking token...');
  });

  it('Provider: a save whose check is overtaken by a provider switch never creates the old provider', async() => {
    const {pending, calls, added} = await openWithDeferredChecks();
    pickProvider('anthropic');
    const token = q('add-contact-provider-token') as HTMLInputElement;
    token.value = 'sk-a';
    token.dispatchEvent(new Event('input'));
    q('add-contact-submit').click();
    await vi.waitFor(() => expect(pending.length).toBe(1));

    // The user switches provider while the save's own check is in flight.
    pickProvider('xai');
    await vi.waitFor(() => expect(pending.length).toBe(2));
    pending[0].resolve({ok: true, value: {status: 'verified', models: [{id: 'claude-sonnet'}]}});
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.map(([m]) => m)).not.toContain('personas.create');
    expect(added).not.toHaveBeenCalled();
    expect(q('add-contact-provider-status').textContent).toBe('Checking token...');
    expect(q('add-contact-provider-model-value').textContent).toBe('Enter your token to load models');

    pending[1].resolve({ok: true, value: {status: 'verified', models: [{id: 'grok-4'}]}});
    await vi.waitFor(() => expect(q('add-contact-provider-model-value').textContent).toBe('grok-4'));
  });

  it('Provider: a save whose check fails after a provider switch reports no error', async() => {
    const {pending, calls} = await openWithDeferredChecks();
    pickProvider('anthropic');
    const token = q('add-contact-provider-token') as HTMLInputElement;
    token.value = 'sk-a';
    token.dispatchEvent(new Event('input'));
    q('add-contact-submit').click();
    await vi.waitFor(() => expect(pending.length).toBe(1));
    pickProvider('xai');
    await vi.waitFor(() => expect(pending.length).toBe(2));

    pending[0].reject(new Error('network down'));
    await new Promise((r) => setTimeout(r, 0));
    expect(q('add-contact-error').textContent).toBe('');
    expect(calls.map(([m]) => m)).not.toContain('personas.create');
  });

  it('shows Provider only when the desktop engine can list providers', async() => {
    (window as any).phantomchatDesktop = {phantombot: {call: vi.fn(async() => ({ok: false, error: {code: 'unknown_method'}}))}};
    await open();
    await new Promise((r) => setTimeout(r, 0));
    expect(q('add-contact-kind-provider')).toBeNull();
    document.body.innerHTML = '';
    (window as any).phantomchatDesktop = {phantombot: {call: vi.fn(async() => ({ok: true, value: [] as unknown[]}))}};
    await open();
    await vi.waitFor(() => expect(q('add-contact-kind-provider')).toBeTruthy());
  });
});
