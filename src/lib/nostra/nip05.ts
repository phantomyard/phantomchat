/**
 * NIP-05 verification logic
 *
 * Pure functions for verifying NIP-05 identities and building
 * kind 0 metadata events. No UI dependencies.
 */

export type Nip05Status = 'unverified' | 'verifying' | 'verified' | 'failed';

/**
 * Verify a NIP-05 alias by fetching .well-known/nostr.json
 * and checking that the pubkey matches.
 */
export async function verifyNip05(alias: string, expectedPubkeyHex: string): Promise<{ok: boolean; error?: string}> {
  const atIndex = alias.indexOf('@');
  if(atIndex < 1) {
    return {ok: false, error: 'Invalid NIP-05 format. Use name@domain.com'};
  }

  const name = alias.slice(0, atIndex);
  const domain = alias.slice(atIndex + 1);

  if(!domain || domain.indexOf('.') < 1) {
    return {ok: false, error: 'Invalid domain in NIP-05 alias'};
  }

  try {
    const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
    const response = await fetch(url);

    if(!response.ok) {
      return {ok: false, error: `Server returned ${response.status}`};
    }

    const data = await response.json();

    if(!data.names || typeof data.names !== 'object') {
      return {ok: false, error: 'Invalid nostr.json: missing names object'};
    }

    const registeredPubkey = data.names[name];
    if(!registeredPubkey) {
      return {ok: false, error: `Name "${name}" not found in nostr.json`};
    }

    if(registeredPubkey.toLowerCase() !== expectedPubkeyHex.toLowerCase()) {
      return {ok: false, error: 'Pubkey mismatch: nostr.json has a different key for this name'};
    }

    return {ok: true};
  } catch(err) {
    const message = err instanceof Error ? err.message : String(err);
    if(message.includes('CORS') || message.includes('NetworkError') || message.includes('Failed to fetch')) {
      return {ok: false, error: 'CORS or network error. Ensure the server allows cross-origin requests.'};
    }
    return {ok: false, error: `Verification failed: ${message}`};
  }
}

/**
 * Build the JSON snippet that the user must add to .well-known/nostr.json
 */
export function buildNip05Instructions(name: string, pubkeyHex: string): string {
  return JSON.stringify({names: {[name]: pubkeyHex}}, null, 2);
}
