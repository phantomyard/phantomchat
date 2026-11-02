/*
 * The two providers that are not in the catalog (issue #276): PhantomOps and
 * OpenAI-Compatible. Both are ordinary openai-completions entries in models.json.
 * The file never holds a real key: keys go through the runtime's own auth store.
 */
export const PHANTOMOPS_PROVIDER = 'phantomops';
export const OPENAI_COMPATIBLE_PROVIDER = 'openai-compatible';
export const PHANTOMOPS_AUTO_MODEL = 'phantomops/auto';
export const PHANTOMOPS_BASE_URL = 'https://phantomops.app/api/v1';
/** An endpoint with no key still needs something, or the provider disappears. */
export const NO_KEY_PLACEHOLDER = 'no-key-required';

export interface GatewayModel {
  id: string;
  /** Effort levels the gateway says this model takes. Missing means none. */
  efforts: string[];
}

export function normalizeBaseUrl(raw: string): string | null {
  let value = raw.trim().replace(/\/+$/, '');
  if(!/^https?:\/\/[^/]/i.test(value)) return null;
  for(const suffix of ['/chat/completions', '/completions', '/models']) {
    if(value.toLowerCase().endsWith(suffix)) {
      value = value.slice(0, value.length - suffix.length).replace(/\/+$/, '');
      break;
    }
  }
  try {
    new URL(value);
  } catch{
    return null;
  }
  return value;
}

export function parseGatewayModels(body: unknown): GatewayModel[] {
  const data = (body as {data?: unknown})?.data;
  if(!Array.isArray(data)) return [];
  const out: GatewayModel[] = [];
  for(const item of data) {
    const id = (item as {id?: unknown})?.id;
    if(typeof id !== 'string' || !id) continue;
    const efforts = (item as {efforts?: unknown}).efforts;
    out.push({
      id,
      efforts: Array.isArray(efforts) ? efforts.filter((e): e is string => typeof e === 'string') : []
    });
  }
  return out;
}

/** GET {baseUrl}/models. Any failure is "no answer": it never throws. */
export async function fetchGatewayModels(
  baseUrl: string,
  key: string | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000
): Promise<GatewayModel[] | null> {
  try {
    const res = await fetchImpl(`${baseUrl}/models`, {
      headers: key ? {authorization: `Bearer ${key}`} : {},
      signal: AbortSignal.timeout(timeoutMs)
    });
    if(!res.ok) return null;
    return parseGatewayModels(await res.json());
  } catch{
    return null;
  }
}

export interface ModelsJsonEntry {
  baseUrl: string;
  api: 'openai-completions';
  apiKey?: string;
  models: {id: string; name: string; reasoning: boolean}[];
}

export function buildProviderEntry(input: {
  baseUrl: string;
  models: GatewayModel[];
  defaultModel?: string;
  keyless: boolean;
}): ModelsJsonEntry {
  const models = [...input.models];
  if(input.defaultModel && !models.some((m) => m.id === input.defaultModel)) {
    models.unshift({id: input.defaultModel, efforts: []});
  }
  if(input.defaultModel) {
    models.sort((a, b) => Number(b.id === input.defaultModel) - Number(a.id === input.defaultModel));
  }
  return {
    baseUrl: input.baseUrl,
    api: 'openai-completions',
    ...(input.keyless ? {apiKey: NO_KEY_PLACEHOLDER} : {}),
    models: models.map((m) => ({id: m.id, name: m.id, reasoning: m.efforts.length > 0}))
  };
}
