/*
 * Local phantoms (desktop only): the personas of the phantombot engine bundled
 * in this app belong to the PC, not to one PhantomChat account.
 *
 * A Provider contact's persona name was only ever recorded in the account's
 * contact prefs, and its allowlist held only that account's npub. So deleting
 * the account (or signing in with a new one) orphaned every local phantom: it
 * kept running, nobody could reach it, it was missing from Contacts, and its
 * name was taken, so it could not be re-created either.
 *
 * adoptLocalPhantoms() runs at every desktop boot. For each engine persona with
 * a PhantomChat identity it:
 *   1. lets the sender gate always accept it (rememberLocalPhantom);
 *   2. allows the signed-in npub on its allowlist and (re)starts its channel;
 *   3. adds it as a Provider contact with its persona recorded, unless it is
 *      already a contact or this account deliberately deleted it.
 *
 * Idempotent: a phantom that is already a contact and already allows this npub
 * costs one `info` call. It never removes anything and never stamps a
 * deliberate add (AGENTS.md rule 12): an account that deleted the contact
 * keeps it deleted.
 */
import type {BridgeCall} from '@lib/phantomchat/provider-contacts';
import {rememberLocalPhantom} from '@lib/phantomchat/sender-gate';

export interface AdoptDeps {
  call: BridgeCall;
  /** My npub (the signed-in account). */
  ownNpub: string;
  /** npub1… → 64-hex. Throws on a malformed npub. */
  decode(npub: string): string;
  /** A committed contact mapping exists. */
  hasContact(hex: string): Promise<boolean>;
  /** This account durably deleted the contact (unix seconds, 0 = never). */
  deletedAt(hex: string): Promise<number>;
  /** The persona already recorded in this contact's prefs, if any. */
  recordedPersona(hex: string): Promise<string | undefined>;
  /** Record the persona in prefs as a Provider contact. */
  recordPersona(hex: string, persona: string): Promise<void>;
  /** Add the contact (non-deliberate, no chat opened). */
  addContact(npub: string, displayName: string): Promise<void>;
  log?: Pick<Console, 'warn' | 'log'>;
}

export type AdoptOutcome = 'added' | 'linked' | 'present' | 'deleted' | 'no-identity' | 'failed';

export interface AdoptResult {
  persona: string;
  outcome: AdoptOutcome;
  npub?: string;
  error?: string;
}

/** The name a phantom gets as a contact: the engine's own default. */
export function localPhantomDisplayName(persona: string): string {
  return persona.charAt(0).toUpperCase() + persona.slice(1);
}

async function value<T>(call: BridgeCall, method: string, params?: Record<string, unknown>): Promise<T> {
  const res = await call(method, params);
  if(!res?.ok) {
    const error = (res as any)?.error;
    throw new Error(error?.message ?? `${method} failed`);
  }
  return res.value as T;
}

async function adoptOne(deps: AdoptDeps, persona: string): Promise<AdoptResult> {
  const info = await value<{npub: string | null; configured: boolean; allowedNpubs: string[]}>(
    deps.call, 'persona.phantomchat.info', {persona});
  if(!info?.npub) return {persona, outcome: 'no-identity'};
  const npub = info.npub;
  const hex = deps.decode(npub);
  rememberLocalPhantom(hex);

  if(await deps.deletedAt(hex) > 0) return {persona, npub, outcome: 'deleted'};

  const allowed = Array.isArray(info.allowedNpubs) ? info.allowedNpubs : [];
  if(!allowed.includes(deps.ownNpub)) {
    // allow() restarts a running channel itself; start() covers a channel that
    // was never started (autostart skips a persona with no allowlist).
    await value(deps.call, 'persona.phantomchat.allow', {persona, npub: deps.ownNpub});
  }
  await value(deps.call, 'persona.phantomchat.start', {persona, displayName: localPhantomDisplayName(persona)})
  .catch((err) => deps.log?.warn('[local-phantoms] channel not running yet:', persona, err));

  if(await deps.hasContact(hex)) {
    if(await deps.recordedPersona(hex)) return {persona, npub, outcome: 'present'};
    await deps.recordPersona(hex, persona);
    return {persona, npub, outcome: 'linked'};
  }
  // Prefs first, so the first render already shows a Provider contact and a
  // later delete of this contact also deletes its persona.
  await deps.recordPersona(hex, persona);
  await deps.addContact(npub, localPhantomDisplayName(persona));
  return {persona, npub, outcome: 'added'};
}

/** Adopt every phantom of this PC's engine into the signed-in account. */
export async function adoptLocalPhantoms(deps: AdoptDeps): Promise<AdoptResult[]> {
  const names = await value<string[]>(deps.call, 'personas.list');
  return Promise.all((Array.isArray(names) ? names : []).map((persona) =>
    adoptOne(deps, persona).catch((err): AdoptResult => {
      const error = err instanceof Error ? err.message : String(err);
      deps.log?.warn('[local-phantoms] adopt failed:', persona, error);
      return {persona, outcome: 'failed', error};
    })
  ));
}

/** Boot wiring: real stores, desktop bridge. No-op outside the desktop app. */
export async function adoptLocalPhantomsAtBoot(ownHex: string): Promise<AdoptResult[]> {
  const call: BridgeCall | undefined = typeof window !== 'undefined' ?
    (window as any).phantomchatDesktop?.phantombot?.call :
    undefined;
  if(typeof call !== 'function') return [];
  const [{npubEncode, decodePubkey}, peers, prefs, {addP2PContact}, {whenContactsSettled}] = await Promise.all([
    import('@lib/phantomchat/nostr-identity'),
    import('@lib/phantomchat/virtual-peers-db'),
    import('@lib/phantomchat/contact-prefs'),
    import('@lib/phantomchat/add-p2p-contact'),
    import('@lib/phantomchat/sender-gate')
  ]);
  // Remember the phantoms' keys straight away so the sender gate never holds
  // their messages, but adopt only once contacts sync has applied this
  // account's deletes (a contact deleted on another device stays deleted).
  const names = await value<string[]>(call, 'personas.list').catch((): string[] => []);
  await Promise.all(names.map(async(persona) => {
    const info = await value<{npub: string | null}>(call, 'persona.phantomchat.info', {persona}).catch((): null => null);
    if(info?.npub) {
      try { rememberLocalPhantom(decodePubkey(info.npub)); } catch{ /* malformed npub */ }
    }
  }));
  await whenContactsSettled();
  const results = await adoptLocalPhantoms({
    call,
    ownNpub: npubEncode(ownHex),
    decode: decodePubkey,
    hasContact: (hex) => peers.hasStoredMapping(hex),
    deletedAt: (hex) => peers.getDeletedPeer(hex),
    recordedPersona: async(hex) => (await prefs.getContactPrefs(hex))?.persona,
    recordPersona: async(hex, persona) => { await prefs.setContactPrefs(hex, {kind: 'provider', persona}); },
    addContact: async(npub, displayName) => {
      await addP2PContact({pubkey: npub, nickname: displayName, openChat: false, source: 'local-phantom-adopt'});
    },
    log: console
  });
  const changed = results.filter((r) => r.outcome === 'added' || r.outcome === 'linked' || r.outcome === 'failed');
  if(changed.length) console.log('[local-phantoms] adopt:', changed.map((r) => `${r.persona}=${r.outcome}`).join(', '));
  return results;
}
