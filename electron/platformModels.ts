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

export async function isPlatformPersona(call: PlatformCall, persona: string): Promise<boolean> {
  return await brainProvider(call, persona) === PHANTOMOPS_PROVIDER;
}

/** The PhantomOps personas among `names`, asked one by one. */
export async function platformPersonas(call: PlatformCall, names: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for(const persona of names) {
    if(await isPlatformPersona(call, persona)) found.add(persona);
  }
  return found;
}

/** Normalise a bridge answer; an older engine (no method) is `unavailable`. */
export function asPlatformModels(res: Awaited<ReturnType<PlatformCall>>): PlatformModels {
  if(!res.ok) return {status: 'unavailable', detail: res.error.message};
  const v = res.value as any;
  if(v?.status !== 'available') return {status: 'unavailable', detail: typeof v?.detail === 'string' ? v.detail : 'unavailable'};
  const str = (x: unknown) => typeof x === 'string' && x ? x : undefined;
  const voices = Array.isArray(v.tts?.voices) ? v.tts.voices.filter((x: unknown): x is string => typeof x === 'string' && !!x) : [];
  return {
    status: 'available',
    detail: '',
    ...(str(v.embeddings) ? {embeddings: v.embeddings} : {}),
    ...(str(v.decision) ? {decision: v.decision} : {}),
    ...(str(v.tts?.model) ? {tts: {model: v.tts.model, voices}} : {}),
    ...(str(v.stt) ? {stt: v.stt} : {})
  };
}

export async function personaPlatformModels(call: PlatformCall, persona: string): Promise<PlatformModels> {
  return asPlatformModels(await call('persona.platformModels', {persona}));
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
    embeddings: models.embeddings ? {provider: PHANTOMOPS_PROVIDER, model: models.embeddings} : {provider: 'none'},
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
 * Never throws: the brain save itself already succeeded.
 */
export async function followBrainChange(call: PlatformCall, persona: string, before: string, after: string, f: BrainFollowers): Promise<void> {
  const wasPlatform = before === PHANTOMOPS_PROVIDER;
  const isPlatform = after === PHANTOMOPS_PROVIDER;
  try {
    if(isPlatform) f.log(`${persona}: ${await inheritPlatformModels(call, persona)}`);
    if(wasPlatform !== isPlatform) {
      await f.resetVoice(persona);
      if(!isPlatform) await f.reapplyAppWide(persona);
    }
  } catch(err) {
    f.log(`${persona}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
