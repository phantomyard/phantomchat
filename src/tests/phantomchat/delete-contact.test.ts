/**
 * The one delete path behind every contact delete button (delete-contact.ts):
 * order of steps, what counts as "deleted", the synced-delete cleanup, and the
 * leftover sweep that must never wipe a contact re-added after the delete.
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';

const calls: string[] = [];
vi.mock('@lib/phantomchat/provider-contacts', () => ({
  deleteP2PContact: vi.fn(async(pubkey: string, chatAPI: any) => {
    calls.push('forget:' + pubkey);
    await chatAPI.deleteConversation(pubkey);
  }),
  forgetContact: vi.fn(async(pubkey: string) => {
    calls.push('forget:' + pubkey);
  })
}));

import {deleteContact, forgetSyncedDelete, sweepDeletedContactLeftovers} from '@lib/phantomchat/delete-contact';
import * as provider from '@lib/phantomchat/provider-contacts';

const PK = 'a'.repeat(64);

function deps(over: Partial<Parameters<typeof deleteContact>[1]> = {}) {
  return {
    getPubkey: async() => PK,
    chatAPI: () => ({deleteConversation: async(pk: string) => { calls.push('conversation:' + pk); }}),
    bridgeCall: (): undefined => undefined,
    dropFromContactList: async(peerId: number) => { calls.push('drop:' + peerId); },
    publishContacts: () => { calls.push('publish'); },
    dropDialog: (peerId: number) => { calls.push('dialog:' + peerId); },
    ...over
  } as any;
}

beforeEach(() => {
  calls.length = 0;
  vi.mocked(provider.deleteP2PContact).mockClear();
  vi.mocked(provider.forgetContact).mockClear();
});

describe('deleteContact', () => {
  it('forgets locally, drops from the list, publishes to sync, then drops the dialog', async() => {
    expect(await deleteContact(42, deps())).toBe('deleted');
    expect(calls).toEqual(['forget:' + PK, 'conversation:' + PK, 'drop:42', 'publish', 'dialog:42']);
  });

  it('reports nothing deleted and publishes nothing when the local wipe fails', async() => {
    vi.mocked(provider.deleteP2PContact).mockRejectedValueOnce(new Error('engine down'));
    await expect(deleteContact(42, deps())).rejects.toThrow('engine down');
    expect(calls).not.toContain('publish');
    expect(calls).not.toContain('drop:42');
  });

  it('still publishes the delete when only the cached-list drop fails', async() => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps({dropFromContactList: async() => { throw new Error('worker gone'); }});
    expect(await deleteContact(42, d)).toBe('deleted');
    expect(calls).toContain('publish');
    warn.mockRestore();
  });

  it('is unresolved without a pubkey and not_ready without a chat API', async() => {
    expect(await deleteContact(42, deps({getPubkey: async() => null}))).toBe('unresolved');
    expect(await deleteContact(42, deps({chatAPI: () => null}))).toBe('not_ready');
    expect(provider.deleteP2PContact).not.toHaveBeenCalled();
  });
});

describe('forgetSyncedDelete', () => {
  it('wipes locally and drops from the list; a wipe failure does not stop the list drop', async() => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(provider.forgetContact).mockRejectedValueOnce(new Error('engine down'));
    await forgetSyncedDelete(PK, 7, deps());
    expect(calls).toEqual(['drop:7']);
    await forgetSyncedDelete(PK, 7, deps());
    expect(calls).toEqual(['drop:7', 'forget:' + PK, 'drop:7']);
    warn.mockRestore();
  });
});

describe('sweepDeletedContactLeftovers', () => {
  const deletedAt = 1_700_000_000;

  function sweepDeps(prefs: {updatedAt?: number} | undefined, mapped = false) {
    const forgotten: string[] = [];
    return {
      forgotten,
      deps: {
        listDeletedPeers: async() => [{pubkey: PK, deletedAt}],
        hasMapping: async() => mapped,
        getPrefs: async() => prefs,
        forget: async(pk: string) => { forgotten.push(pk); }
      }
    };
  }

  it('finishes the wipe for prefs left behind by a failed cleanup', async() => {
    const s = sweepDeps({updatedAt: deletedAt * 1000 - 1});
    expect(await sweepDeletedContactLeftovers(s.deps)).toBe(1);
    expect(s.forgotten).toEqual([PK]);
  });

  it('never wipes a contact re-added after the delete', async() => {
    const s = sweepDeps({updatedAt: deletedAt * 1000 + 1});
    expect(await sweepDeletedContactLeftovers(s.deps)).toBe(0);
    expect(s.forgotten).toEqual([]);
  });

  it('skips a pubkey that is mapped again, or has no prefs', async() => {
    const mapped = sweepDeps({updatedAt: 0}, true);
    expect(await sweepDeletedContactLeftovers(mapped.deps)).toBe(0);
    const none = sweepDeps(undefined);
    expect(await sweepDeletedContactLeftovers(none.deps)).toBe(0);
  });
});
