/*
 * The phantombot bridge's method allowlist, shared by the Electron main
 * process (which refuses anything else before it reaches the host) and the
 * Bun host (which refuses it again). Each method maps onto one call of the
 * phantombot engine's public API (`phantombot/engine`), nothing deeper.
 *
 * No method returns a secret: `secrets.set` writes into the persona's
 * encrypted vault, and the vault is never read back over the bridge.
 * `providers.check`, `decisionModels.check` and `embeddings.check` take a key
 * and answer with a verdict and model ids (and `dims`) only.
 *
 * `tools.run` runs one of Pi's built-in tools on this PC, for the Local tools
 * protocol (docs/LOCAL-TOOLS.md). The page decides who may call it; the bridge
 * is the principal's own app either way, which can already run `tools: "full"`
 * turns.
 */
export const PHANTOMBOT_METHODS = [
  'info',
  'personas.list',
  'personas.exists',
  'personas.create',
  'personas.delete',
  'providers.list',
  'providers.check',
  'voiceModels.providers',
  'voiceModels.check',
  'decisionModels.check',
  'embeddings.check',
  'persona.configure',
  'persona.secrets.set',
  'persona.secrets.has',
  'persona.secrets.delete',
  'persona.memory.search',
  'persona.memory.capture',
  'persona.memory.refresh',
  'persona.turn',
  'persona.askJson',
  'persona.decide',
  'turn.cancel',
  'persona.phantomchat.info',
  'persona.phantomchat.allow',
  'persona.phantomchat.disallow',
  'persona.phantomchat.start',
  'persona.phantomchat.stop',
  'persona.phantomchat.status',
  'tools.run',
  'tools.cancel'
] as const;

export type PhantombotMethod = (typeof PHANTOMBOT_METHODS)[number];

export function isPhantombotMethod(value: unknown): value is PhantombotMethod {
  return typeof value === 'string' && (PHANTOMBOT_METHODS as readonly string[]).includes(value);
}

/** Largest request the bridge forwards, as serialized JSON. */
export const MAX_REQUEST_BYTES = 1024 * 1024;
