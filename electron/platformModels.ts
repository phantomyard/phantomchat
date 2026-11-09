/*
 * PhantomOps contacts inherit their server's models (phantombot #794,
 * phantomops #371).
 *
 * A Provider contact whose provider is PhantomOps needs no Decision Model,
 * Embeddings or Voice Models setup in this app: the PhantomOps admin picked
 * those models centrally, and the contact reaches them over its own `pok_`
 * token. So:
 *
 *   - the app-wide Decision Model, Embeddings and Voice Models settings never
 *     touch a PhantomOps persona (`platformPersonas` lets each save skip it);
 *   - when a persona's brain becomes PhantomOps, `inheritPlatformModels`
 *     points its embeddings and decision model at the server (or turns them
 *     off when the server has none), so nothing from the app-wide settings
 *     is left on it;
 *   - its Voice ID list is the server's TTS voices (voiceModels.ts).
 *
 * No Electron import, so vitest drives it with a fake bridge.
 */
export type PlatformCall = (method: string, params: Record<string, unknown>) => Promise<
  {ok: true; value: unknown} | {ok: false; error: {code: string; message: string}}
>;

export const PHANTOMOPS_PROVIDER = 'phantomops';

/** What `persona.platformModels` / `platformModels.check` answer. */
export interface PlatformModels {
  status: 'available' | 'unavailable';
  detail: string;
  embeddings?: string;
  /** The embeddings vector width; sent with the slot so the engine stores a usable embedder. */
  embeddingsDims?: number;
  decision?: string;
  tts?: {model: string; voices: string[]};
  stt?: string;
}

/** The brain provider of a persona, lowercased ('' when unknown). */
export async function brainProvider(call: PlatformCall, persona: string): Promise<string> {
  const res = await call('persona.brain', {persona});
  const provider = res.ok ? (res.value as any)?.provider : undefined;
  return typeof provider === 'string' ? provider.trim().toLowerCase() : '';
}

/**
 * Whether this app's engine can inherit PhantomOps models at all (phantombot
 * #794). Local, no network. On an older engine (or a failed bridge) nothing
 * is treated as a PhantomOps contact, so every app-wide save works as before.
 */
export async function platformSupported(call: PlatformCall): Promise<boolean> {
  const res = await call('platformModels.supported', {}).catch(() => undefined);
  return !!res?.ok && res.value === true;
}

export async function isPlatformPersona(call: PlatformCall, persona: string): Promise<boolean> {
  return await brainProvider(call, persona) === PHANTOMOPS_PROVIDER && await platformSupported(call);
}

/** The PhantomOps personas among `names`, asked one by one (none on an older engine). */
export async function platformPersonas(call: PlatformCall, names: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if(!names.length || !await platformSupported(call)) return found;
  for(const persona of names) {
    if(await brainProvider(call, persona) === PHANTOMOPS_PROVIDER) found.add(persona);
  }
  return found;
}

/** Normalise a bridge answer; an older engine (no method) is `unavailable`. */
export function asPlatformModels(res: Awaited<ReturnType<PlatformCall>>): PlatformModels {
  if(!res.ok) return {status: 'unavailable', detail: res.error.message};
  const v = res.value as any;
  if(v?.status !== 'available') return {status: 'unavailable', detail: typeof v?.detail === 'string' ? v.detail : 'unavailable'};
  const str = (x: unknown) => typeof x === 'string' && x ? x : undefined;
  const dims = Number.isInteger(v.embeddingsDims) && v.embeddingsDims > 0 ? v.embeddingsDims as number : undefined;
  const voices = Array.isArray(v.tts?.voices) ? v.tts.voices.filter((x: unknown): x is string => typeof x === 'string' && !!x) : [];
  return {
    status: 'available',
    detail: '',
    ...(str(v.embeddings) ? {embeddings: v.embeddings, ...(dims ? {embeddingsDims: dims} : {})} : {}),
    ...(str(v.decision) ? {decision: v.decision} : {}),
    ...(str(v.tts?.model) ? {tts: {model: v.tts.model, voices}} : {}),
    ...(str(v.stt) ? {stt: v.stt} : {})
  };
}

/** The last answer per persona, so reads never wait on the server (engine timeout 20 s). */
const known = new Map<string, PlatformModels>();
const inflight = new Map<string, Promise<PlatformModels>>();
/** Drop cached answers (one persona, or all). */
export function forgetPlatformModels(persona?: string) {
  if(persona === undefined) {
    known.clear();
    inflight.clear();
  } else {
    known.delete(persona);
    inflight.delete(persona);
  }
}

/** Ask the server now (shared with any ask already in flight) and remember the answer. */
export function personaPlatformModels(call: PlatformCall, persona: string): Promise<PlatformModels> {
  let p = inflight.get(persona);
  if(!p) {
    p = call('persona.platformModels', {persona})
    .then(asPlatformModels, (err): PlatformModels => ({status: 'unavailable', detail: err instanceof Error ? err.message : String(err)}))
    .then((m) => {
      if(inflight.get(persona) !== p) return m;
      if(m.status === 'available' || !known.has(persona)) known.set(persona, m);
      return m;
    })
    .finally(() => {
      if(inflight.get(persona) === p) inflight.delete(persona);
    });
    inflight.set(persona, p);
  }
  return p;
}

/**
 * For reads the user waits on (the Edit pane): the last known answer at once,
 * refreshed in the background. With none yet, wait at most `waitMs` for the
 * server, then answer unavailable and let the refresh land for next time.
 */
export async function lastPlatformModels(call: PlatformCall, persona: string, waitMs = 1500): Promise<PlatformModels> {
  const last = known.get(persona);
  const fresh = personaPlatformModels(call, persona);
  if(last) return last;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<PlatformModels>((resolve) => {
    timer = setTimeout(() => resolve({status: 'unavailable', detail: 'PhantomOps is slow to answer'}), waitMs);
  });
  try { return await Promise.race([fresh, slow]); } finally { clearTimeout(timer); }
}

/** Voice is offered when the server has BOTH directions and its TTS model lists voices. */
export const platformVoiceReady = (m: PlatformModels) => m.status === 'available' && !!m.stt && !!m.tts?.voices.length;

/**
 * Point a PhantomOps persona's embeddings and decision model at its server.
 * A slot the server does not offer is turned off, so no app-wide setting is
 * left on the persona. An unreachable server changes nothing (the next brain
 * save tries again). Never throws; returns what it did, for the log.
 */
export async function inheritPlatformModels(call: PlatformCall, persona: string): Promise<string> {
  const models = await personaPlatformModels(call, persona);
  if(models.status !== 'available') return `not inherited (${models.detail})`;
  const config = {
    embeddings: models.embeddings ?
      {provider: PHANTOMOPS_PROVIDER, model: models.embeddings, ...(models.embeddingsDims ? {dims: models.embeddingsDims} : {})} :
      {provider: 'none'},
    decisionModel: models.decision ?
      {provider: PHANTOMOPS_PROVIDER, judge: true, router: true} :
      {judge: false, router: false}
  };
  const res = await call('persona.configure', {persona, config});
  if(!res.ok) return `not inherited (${res.error.message})`;
  return `embeddings ${models.embeddings ? 'from PhantomOps' : 'off'}, decision model ${models.decision ? 'from PhantomOps' : 'off'}`;
}

/** The brain provider a `persona.configure` call sets, lowercased, or undefined. */
export function brainTarget(method: string, params: Record<string, unknown>): {persona: string; provider: string} | undefined {
  if(method !== 'persona.configure' || typeof params.persona !== 'string') return undefined;
  const provider = (params.config as any)?.brain?.native?.provider;
  return typeof provider === 'string' && provider.trim() ? {persona: params.persona, provider: provider.trim().toLowerCase()} : undefined;
}

export interface BrainFollowers {
  /** Give the persona the app-wide Decision Model and Embeddings again. */
  reapplyAppWide(persona: string): Promise<void>;
  /** Drop the persona's Voice ID and turn its voice off. */
  resetVoice(persona: string): Promise<void>;
  log(line: string): void;
}

/**
 * After a successful brain save: a PhantomOps brain (re)inherits its
 * server's models (a new token can mean a new server answer); a move between
 * PhantomOps and another provider drops the Voice ID, and a move AWAY gives
 * the app-wide settings back (the engine turned the borrowed slots off).
 * Never throws: the brain save itself already succeeded. The caller does not
 * await it (no user action waits on the network).
 */
export async function followBrainChange(call: PlatformCall, persona: string, before: string, after: string, f: BrainFollowers): Promise<void> {
  const wasPlatform = before === PHANTOMOPS_PROVIDER;
  const isPlatform = after === PHANTOMOPS_PROVIDER;
  if(!wasPlatform && !isPlatform) return;
  try {
    // An older engine inherits nothing, so nothing is reset or reapplied either.
    if(!await platformSupported(call)) return;
    if(!isPlatform) forgetPlatformModels(persona);
    if(isPlatform) f.log(`${persona}: ${await inheritPlatformModels(call, persona)}`);
    if(wasPlatform !== isPlatform) {
      await f.resetVoice(persona);
      if(!isPlatform) await f.reapplyAppWide(persona);
    }
  } catch(err) {
    f.log(`${persona}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
