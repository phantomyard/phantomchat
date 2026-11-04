/**
 * Contacts redesign (Phantom | Human | Provider): the per-contact prefs store,
 * the Human avatar, and the New Contact modal's per-type fields.
 */
import 'fake-indexeddb/auto';
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
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

  it('every P2P contact delete in the UI goes through deleteP2PContact', () => {
    for(const file of ['src/components/sidebarRight/tabs/editContact.ts', 'src/components/sidebarLeft/tabs/contacts.ts']) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).toContain('deleteP2PContact(pubkey, chatAPI');
      expect(src.match(/deleteConversation\(/g), file).toBeNull();
    }
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

describe('New Contact modal', () => {
  const managers: any = {appMessagesManager: {togglePeerMute: vi.fn(async() => {})}};
  const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  const visible = (id: string) => !!q(id) && (q(id).closest('label') || q(id)).style.display !== 'none';

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

  async function open(npub?: string) {
    const {showAddContactPopup} = await import('@components/popups/addContact');
    const added = vi.fn();
    showAddContactPopup({managers, npub, onContactAdded: added});
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
    document.querySelector('.popup-add-contact-overlay')?.remove();
    (window as any).phantomchatDesktop = {localTools: desktopLocalTools(true)};
    await open();
    expect(visible('add-contact-local-tools')).toBe(true);
    q('add-contact-kind-human').click();
    expect(visible('add-contact-local-tools')).toBe(false);
    expect(visible('add-contact-notifications')).toBe(true);
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
    const {addTypedContact} = await import('@components/popups/addContact');
    await expect(addTypedContact(managers, {
      npub: NPUB, nickname: 'X', kind: 'human', localTools: false, notifications: true
    })).rejects.toThrow('relay down');
    expect(await getContactPrefs(HEX)).toEqual(before);
    _resetContactPrefsForTests();
    expect(await getContactPrefs(HEX)).toEqual(before);
  });

  it('a failed add of a new npub leaves no prefs row behind', async() => {
    addP2PContact.mockImplementationOnce(async() => { throw new Error('relay down'); });
    const {addTypedContact} = await import('@components/popups/addContact');
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
      const {addTypedContact} = await import('@components/popups/addContact');
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

  it('opens only one modal at a time', async() => {
    await open();
    await open();
    expect(document.querySelectorAll('.popup-add-contact-overlay').length).toBe(1);
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
