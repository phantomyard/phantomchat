/**
 * Local phantoms: the embedded engine's personas are adopted into whichever
 * account is signed in on this PC — so a new account (after Delete Account)
 * gets its local phantoms back instead of leaving them orphaned.
 */
import {describe, it, expect, beforeEach} from 'vitest';
import {adoptLocalPhantoms, localPhantomDisplayName, type AdoptDeps} from '@lib/phantomchat/local-phantoms';
import {isLocalPhantom, resetSenderGateForTests} from '@lib/phantomchat/sender-gate';

const OWN = 'npub1own';
const OLD = 'npub1oldaccount';
const hexOf = (npub: string) => (npub === 'npub1cora' ? 'c' : npub === 'npub1barry' ? 'b' : 'd').repeat(64);

interface Persona {npub: string | null; allowed: string[]; started?: boolean}

function harness(personas: Record<string, Persona>, opts: {contacts?: string[]; deleted?: string[]; prefs?: Record<string, string>} = {}) {
  const calls: Array<[string, any]> = [];
  const contacts = new Set(opts.contacts ?? []);
  const prefs = new Map(Object.entries(opts.prefs ?? {}));
  const added: Array<[string, string]> = [];
  const deps: AdoptDeps = {
    ownNpub: OWN,
    call: async(method, params: any = {}) => {
      calls.push([method, params]);
      const p = personas[params.persona];
      switch(method) {
        case 'personas.list': return {ok: true, value: Object.keys(personas)} as any;
        case 'persona.phantomchat.info': return {ok: true, value: {npub: p.npub, configured: p.allowed.length > 0, allowedNpubs: [...p.allowed]}} as any;
        case 'persona.phantomchat.allow': p.allowed.push(params.npub); return {ok: true, value: {npub: params.npub, added: true, restart: 'restarted'}} as any;
        case 'persona.phantomchat.start': p.started = true; return {ok: true, value: {state: 'running', npub: p.npub}} as any;
      }
      return {ok: false, error: {code: 'unknown', message: method}} as any;
    },
    decode: hexOf,
    hasContact: async(hex) => contacts.has(hex),
    deletedAt: async(hex) => (opts.deleted ?? []).includes(hex) ? 1700000000 : 0,
    recordedPersona: async(hex) => prefs.get(hex),
    recordPersona: async(hex, persona) => { prefs.set(hex, persona); },
    addContact: async(npub, name) => { added.push([npub, name]); contacts.add(hexOf(npub)); }
  };
  return {deps, calls, added, prefs, personas};
}

describe('adoptLocalPhantoms', () => {
  beforeEach(() => resetSenderGateForTests());

  it('brings an orphaned phantom into a new account: allow + start + add as Provider contact', async() => {
    const h = harness({cora: {npub: 'npub1cora', allowed: [OLD]}});
    const res = await adoptLocalPhantoms(h.deps);
    expect(res).toEqual([{persona: 'cora', npub: 'npub1cora', outcome: 'added'}]);
    expect(h.personas.cora.allowed).toEqual([OLD, OWN]);
    expect(h.personas.cora.started).toBe(true);
    expect(h.added).toEqual([['npub1cora', 'Cora']]);
    // Persona recorded, so deleting the contact later deletes the persona too.
    expect(h.prefs.get(hexOf('npub1cora'))).toBe('cora');
    expect(isLocalPhantom(hexOf('npub1cora'))).toBe(true);
  });

  it('is idempotent: an adopted phantom costs no writes', async() => {
    const hex = hexOf('npub1cora');
    const h = harness({cora: {npub: 'npub1cora', allowed: [OWN]}}, {contacts: [hex], prefs: {[hex]: 'cora'}});
    const res = await adoptLocalPhantoms(h.deps);
    expect(res[0].outcome).toBe('present');
    expect(h.calls.map(([m]) => m)).not.toContain('persona.phantomchat.allow');
    expect(h.added).toEqual([]);
  });

  it('links an existing contact that lost its persona record', async() => {
    const hex = hexOf('npub1cora');
    const h = harness({cora: {npub: 'npub1cora', allowed: [OWN]}}, {contacts: [hex]});
    expect((await adoptLocalPhantoms(h.deps))[0].outcome).toBe('linked');
    expect(h.prefs.get(hex)).toBe('cora');
    expect(h.added).toEqual([]);
  });

  it('never resurrects a contact this account deleted, and never touches its allowlist', async() => {
    const h = harness({cora: {npub: 'npub1cora', allowed: [OLD]}}, {deleted: [hexOf('npub1cora')]});
    expect((await adoptLocalPhantoms(h.deps))[0].outcome).toBe('deleted');
    expect(h.personas.cora.allowed).toEqual([OLD]);
    expect(h.added).toEqual([]);
  });

  it('skips a persona with no PhantomChat identity, and one failure does not stop the rest', async() => {
    const h = harness({
      ghost: {npub: null, allowed: []},
      barry: {npub: 'npub1barry', allowed: [OLD]},
      cora: {npub: 'npub1cora', allowed: [OLD]}
    });
    const failing = h.deps.addContact;
    h.deps.addContact = async(npub, name) => {
      if(npub === 'npub1barry') throw new Error('boom');
      return failing(npub, name);
    };
    const res = await adoptLocalPhantoms(h.deps);
    expect(res.map((r) => [r.persona, r.outcome])).toEqual([['ghost', 'no-identity'], ['barry', 'failed'], ['cora', 'added']]);
  });

  it('names the contact like the engine does', () => {
    expect(localPhantomDisplayName('cora')).toBe('Cora');
  });
});
