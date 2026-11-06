/** Model-only control messages: no credentials, no chat history, no LLM turns. */
import {getSharedRelayPool} from './nostr-relay-pool';
import {createRumor, createSeal, createGiftWrap} from './nostr-crypto';
export const VOICE_MODELS_TAG = 'phantomchat-voice-models';
const pending = new Map<string, {pubkey: string; resolve(value: any): void; reject(error: Error): void}>();
export function isVoiceModelsRumor(tags: string[][] | undefined) {
  return tags?.some(t => t[0] === VOICE_MODELS_TAG && t[1] === '1') && tags.some(t => t[0] === 'control' && t[1] === 'true');
}
export function handleVoiceModelsRumor(msg: {from: string; content: string; timestamp: number}) {
  if(Math.abs(Date.now() / 1000 - msg.timestamp) > 60) return;
  let data: any;
  try {data = JSON.parse(msg.content);} catch{return;}
  if(data?.type !== VOICE_MODELS_TAG) return;
  const request = pending.get(data.id);
  if(!request || request.pubkey !== msg.from) return;
  pending.delete(data.id);
  if(data.ok) request.resolve(data.value);
  else request.reject(new Error(typeof data.error === 'string' ? data.error : 'Remote voice configuration failed'));
}
export async function requestRemoteVoiceModels(pubkey: string, method: 'get' | 'set', models?: unknown) {
  const pool = getSharedRelayPool();
  const sk = pool?.getPrivateKey();
  if(!pool || !sk) throw new Error('Connect to relays to configure this Phantom');
  const id = crypto.randomUUID();
  let timer: ReturnType<typeof setTimeout>;
  const response = new Promise<any>((resolve, reject) => {
    pending.set(id, {pubkey, resolve, reject});
    timer = setTimeout(() => {pending.delete(id); reject(new Error('Remote engine is offline or does not support Voice Models'));}, 20_000);
  });
  const rumor = createRumor(JSON.stringify({type: VOICE_MODELS_TAG, id, method, models}), sk, [['p', pubkey], [VOICE_MODELS_TAG, '1'], ['phantomchat-local-tools', '1'], ['control', 'true']]);
  // Attach the rejection handler before publishing; the timeout can win first.
  const result = response.finally(() => {clearTimeout(timer); pending.delete(id);});
  void result.catch(() => {});
  try {await pool.publishRawEvent(createGiftWrap(createSeal(rumor, sk, pubkey), pubkey));}
  catch{pending.get(id)?.reject(new Error('Could not send remote voice configuration'));}
  return result;
}
