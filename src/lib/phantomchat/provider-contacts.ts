/*
 * Provider contacts (contacts redesign, desktop only): an AI contact that is
 * a persona of the phantombot engine bundled in the desktop app. It has its
 * own npub, runs its PhantomChat channel inside the app (allowlist = my
 * npub), and chats like any phantom. Its provider key goes into the persona's
 * encrypted vault and never comes back over the bridge.
 *
 * Every step goes through one `call` (window.phantomchatDesktop.phantombot.call),
 * so tests drive it with a fake.
 */
import {clearContactPrefs, getContactPrefs} from '@lib/phantomchat/contact-prefs';
import type {DesktopPhantombotResult} from '@lib/phantomchat/desktop-api';

export type BridgeCall = (method: string, params?: Record<string, unknown>) => Promise<DesktopPhantombotResult>;

export interface ProviderOption {
  id: string;
  label: string;
  keyOptional: boolean;
  checkable: boolean;
  autoModel: boolean;
  defaultModel?: string;
  keyLabel?: string;
}

export interface ProviderModelOption {
  id: string;
  supportsImages: boolean;
}

export interface ProviderCheckResult {
  status: 'verified' | 'invalid' | 'unverified';
  detail: string;
  models: ProviderModelOption[];
}

export class ProviderContactError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

async function value<T>(call: BridgeCall, method: string, params?: Record<string, unknown>): Promise<T> {
  const res = await call(method, params);
  if(!res?.ok) {
    const error = (res as any)?.error;
    throw new ProviderContactError(error?.code ?? 'failed', error?.message ?? `${method} failed`);
  }
  return res.value as T;
}

/**
 * Providers that belong at the top of the picker, in this order. The engine's
 * own order is alphabetical-ish and buries the two a PhantomChat user is
 * most likely to pick, so the client pins them; everything else keeps the
 * engine's order.
 */
export const PINNED_PROVIDERS: readonly string[] = ['phantomops', 'anthropic'];

/** Pin PhantomOps and Anthropic first; leave the engine's order otherwise. */
export function orderProviderOptions(providers: readonly ProviderOption[]): ProviderOption[] {
  const rank = (id: string) => {
    const index = PINNED_PROVIDERS.indexOf(id);
    return index === -1 ? PINNED_PROVIDERS.length : index;
  };
  return providers
  .map((provider, index) => ({provider, index}))
  .sort((a, b) => (rank(a.provider.id) - rank(b.provider.id)) || (a.index - b.index))
  .map(({provider}) => provider);
}

/**
 * Providers the engine can run as a contact, pinned order applied. Those that
 * need a base URL are left out: the engine's brain settings have no endpoint
 * field yet.
 */
export async function listProviderOptions(call: BridgeCall): Promise<ProviderOption[]> {
  const raw = await value<any[]>(call, 'providers.list');
  return orderProviderOptions((Array.isArray(raw) ? raw : [])
  .filter((p) => p && typeof p.id === 'string' && typeof p.label === 'string' && !p.needsBaseUrl)
  .map((p) => ({
    id: p.id,
    label: p.label,
    keyOptional: !!p.keyOptional,
    checkable: !!p.checkable,
    autoModel: !!p.autoModel,
    ...(typeof p.defaultModel === 'string' ? {defaultModel: p.defaultModel} : {}),
    ...(typeof p.keyLabel === 'string' ? {keyLabel: p.keyLabel} : {})
  })));
}

export async function checkProviderKey(call: BridgeCall, provider: string, apiKey: string): Promise<ProviderCheckResult> {
  const raw = await value<any>(call, 'providers.check', {provider, apiKey});
  const status = raw?.status === 'verified' || raw?.status === 'invalid' ? raw.status : 'unverified';
  const models = Array.isArray(raw?.models) ?
    raw.models.filter((m: any) => m && typeof m.id === 'string').map((m: any) => ({id: m.id, supportsImages: !!m.supportsImages})) :
    [];
  return {status, detail: typeof raw?.detail === 'string' ? raw.detail : '', models};
}

/** A persona name for the engine: the contact name lowercased, with spaces and every character outside a-z0-9 removed. */
export function providerPersonaName(displayName: string, existing: readonly string[], random = Math.random): string {
  const base = providerNameSlug(displayName) || 'provider';
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if(!taken.has(base)) return base;
  for(let i = 2; i < 100; i++) {
    const name = `${base}-${i}`;
    if(!taken.has(name)) return name;
  }
  return `${base}-${Math.floor(random() * 1e9).toString(36)}`;
}

/** The persona slug a contact name maps to ('' when it has no letters or digits). */
export function providerNameSlug(displayName: string): string {
  return (displayName || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '').slice(0, 40);
}

/**
 * Why this name cannot be used for a new Provider contact, or undefined when
 * it can. Required, and unique: a Provider contact's persona is named after
 * it, so two names that map to the same persona ("Barry", "barry!") clash.
 */
export async function providerNameProblem(call: BridgeCall, displayName: string): Promise<string | undefined> {
  const name = displayName.trim();
  if(!name) return 'Enter a contact name';
  const slug = providerNameSlug(name);
  if(!slug) return 'Use letters or numbers in the name';
  const existing = await value<string[]>(call, 'personas.list');
  if((Array.isArray(existing) ? existing : []).some((n) => n.toLowerCase() === slug)) return `A Provider contact named "${name}" already exists`;
  return undefined;
}

export interface CreateProviderContactInput {
  displayName: string;
  provider: ProviderOption;
  /** Ignored for an autoModel provider (its defaultModel is used). */
  model?: string;
  apiKey: string;
  /** My npub: the only one the persona answers. */
  ownNpub: string;
}

export interface CreatedProviderContact {
  persona: string;
  npub: string;
  /** The channel did not come up; the contact works after the app restarts it. */
  channelError?: string;
}

/**
 * Create the persona, configure its model and key, allow my npub and start
 * its channel. Any failure before the channel starts deletes the persona, so
 * a failed add leaves nothing behind.
 */
export async function createProviderContact(call: BridgeCall, input: CreateProviderContactInput): Promise<CreatedProviderContact> {
  const model = input.provider.autoModel ? input.provider.defaultModel : (input.model || input.provider.defaultModel);
  if(!model) throw new ProviderContactError('invalid_argument', 'Choose a model');
  if(!input.apiKey && !input.provider.keyOptional) throw new ProviderContactError('invalid_argument', 'Enter a token');
  const displayName = input.displayName.trim() || input.provider.label;
  const existing = await value<string[]>(call, 'personas.list');
  const persona = providerPersonaName(displayName, Array.isArray(existing) ? existing : []);

  await value(call, 'personas.create', {
    persona,
    options: {identity: `${displayName}, an AI assistant on ${input.provider.label} (${model}), reached as a PhantomChat contact`}
  });
  try {
    await value(call, 'persona.configure', {
      persona,
      config: {brain: {chain: ['native'], native: {provider: input.provider.id, model, apiKey: input.apiKey}}}
    });
    await value(call, 'persona.phantomchat.allow', {persona, npub: input.ownNpub});
  } catch(err) {
    await call('personas.delete', {persona}).catch(() => {});
    throw err;
  }

  try {
    const status = await value<any>(call, 'persona.phantomchat.start', {persona, displayName});
    if(typeof status?.npub === 'string' && status.state === 'running') return {persona, npub: status.npub};
    const info = await value<any>(call, 'persona.phantomchat.info', {persona});
    if(typeof info?.npub !== 'string') throw new ProviderContactError('failed', 'the persona has no npub');
    return {persona, npub: info.npub, channelError: status?.error ?? `channel ${status?.state ?? 'not running'}`};
  } catch(err) {
    // No npub at all means nothing to add; a channel that only failed to
    // start still has its identity, and the app retries it on next launch.
    const info = await call('persona.phantomchat.info', {persona});
    const npub = info.ok ? (info.value as any)?.npub : undefined;
    if(typeof npub === 'string') return {persona, npub, channelError: err instanceof Error ? err.message : String(err)};
    await call('personas.delete', {persona}).catch(() => {});
    throw err;
  }
}

/** Delete a Provider contact's persona: its nsec, vault, memory and history. */
export async function deleteProviderPersona(call: BridgeCall, persona: string): Promise<void> {
  await value(call, 'personas.delete', {persona});
}

/**
 * The prefs half of deleting a contact. Its Local tools grant is revoked
 * first, through main's gate: that removes it from local-access.json (so it
 * stays gone after a restart) and cancels what the contact has running. The
 * prefs switch is not the grant, so clearing prefs alone would leave it live.
 * A failed revoke throws before anything is forgotten.
 *
 * A Provider contact's persona goes next: the prefs row is the only record of
 * its name, so if the persona cannot be deleted (or there is no engine to ask)
 * the row stays, the caller sees the error, and a retry is still possible.
 */
export async function forgetContact(pubkey: string, call: BridgeCall | undefined): Promise<void> {
  const {setPhantomLocalTools} = await import('@lib/phantomchat/local-tools');
  await setPhantomLocalTools(pubkey, false, '');
  const prefs = await getContactPrefs(pubkey);
  if(prefs?.kind === 'provider' && prefs.persona) {
    if(!call) throw new ProviderContactError('not_supported', 'this app cannot reach the engine that runs this contact');
    await deleteProviderPersona(call, prefs.persona);
  }
  await clearContactPrefs(pubkey);
}

/**
 * Delete a P2P contact. Every UI delete path goes through here (contact info
 * and the contacts list), so none can skip the Local tools revoke or the
 * prefs: the grant and prefs go first, then the conversation.
 */
export async function deleteP2PContact(
  pubkey: string,
  chatAPI: {deleteConversation(pubkey: string): Promise<unknown>},
  call: BridgeCall | undefined
): Promise<void> {
  await forgetContact(pubkey, call);
  await chatAPI.deleteConversation(pubkey);
}
