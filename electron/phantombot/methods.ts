/*
 * The phantombot bridge's method allowlist, shared by the Electron main
 * process (which refuses anything else before it reaches the host) and the
 * Bun host (which refuses it again). Each method maps onto one call of the
 * phantombot engine's public API (`phantombot/engine`), nothing deeper.
 *
 * No method returns a secret: `secrets.set` writes into the persona's
 * encrypted vault, and the vault is never read back over the bridge.
 */
export const PHANTOMBOT_METHODS = [
  'info',
  'personas.list',
  'personas.exists',
  'personas.create',
  'persona.configure',
  'persona.secrets.set',
  'persona.secrets.has',
  'persona.secrets.delete',
  'persona.memory.search',
  'persona.memory.capture',
  'persona.turn',
  'persona.askJson',
  'persona.decide',
  'turn.cancel'
] as const;

export type PhantombotMethod = (typeof PHANTOMBOT_METHODS)[number];

export function isPhantombotMethod(value: unknown): value is PhantombotMethod {
  return typeof value === 'string' && (PHANTOMBOT_METHODS as readonly string[]).includes(value);
}

/** Largest request the bridge forwards, as serialized JSON. */
export const MAX_REQUEST_BYTES = 1024 * 1024;
