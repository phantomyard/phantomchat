/*
 * Sender gate: who may reach me at all.
 *
 * PhantomChat runs on public relays, so anyone who learns my pubkey can send
 * me a gift-wrapped DM. Only three kinds of sender may start or continue a
 * 1:1 chat (or create a group with me):
 *
 *   - a contact (a committed virtual-peers-db mapping, or an accepted request)
 *   - myself (my other devices)
 *   - a phantom running in this PC's embedded phantombot engine
 *
 * Everyone else is DROPPED before anything is stored, mapped or rendered
 * (chat-api-receive.ts step 2b). No request row, no dialog, no notification.
 *
 * One window needs care: on a fresh login the contact list is restored by
 * contacts sync, which can land AFTER the relay backlog. Dropping then would
 * silently lose real contacts' messages. So until contacts sync has had a
 * conclusive read (markContactsSettled) — bounded by SETTLE_TIMEOUT_MS — an
 * unknown sender's message is held in memory and replayed through the receive
 * path once the list is settled, where it is either delivered or dropped.
 */
import type {DecryptedMessage} from './nostr-relay';

/** Upper bound on the boot hold, from the first held message. */
export const SETTLE_TIMEOUT_MS = 60_000;
/** Held messages beyond this are dropped straight away (spam flood guard). */
export const MAX_HELD = 200;

type Replay = (msg: DecryptedMessage) => Promise<unknown> | unknown;

const localPhantoms = new Set<string>();
let settled = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let held: Array<{msg: DecryptedMessage; replay: Replay}> = [];
let settledWaiters: Array<() => void> = [];

/** A phantom of this PC's embedded engine (hex pubkey) may always reach me. */
export function rememberLocalPhantom(hexPubkey: string): void {
  if(/^[0-9a-f]{64}$/i.test(hexPubkey)) localPhantoms.add(hexPubkey.toLowerCase());
}

export function isLocalPhantom(hexPubkey: string): boolean {
  return localPhantoms.has((hexPubkey || '').toLowerCase());
}

export function contactsSettled(): boolean {
  return settled;
}

/** Resolves once contacts are settled (immediately if they already are). */
export function whenContactsSettled(): Promise<void> {
  if(settled) return Promise.resolve();
  if(!timer) timer = setTimeout(markContactsSettled, SETTLE_TIMEOUT_MS);
  return new Promise((resolve) => settledWaiters.push(resolve));
}

/**
 * Contacts sync has given a conclusive answer (or given up): the local
 * contact list is as complete as it will get. Replays every held message.
 */
export function markContactsSettled(): void {
  if(settled) return;
  settled = true;
  if(timer) {
    clearTimeout(timer);
    timer = null;
  }
  const waiters = settledWaiters;
  settledWaiters = [];
  for(const resolve of waiters) resolve();
  const batch = held;
  held = [];
  for(const {msg, replay} of batch) {
    try {
      void Promise.resolve(replay(msg)).catch((err) => console.warn('[sender-gate] replay failed:', err));
    } catch(err) {
      console.warn('[sender-gate] replay failed:', err);
    }
  }
}

/**
 * Hold an unknown sender's message until contacts are settled. Returns false
 * when it cannot be held (already settled, no replay path, queue full) — the
 * caller then drops it.
 */
export function holdUntilContactsSettled(msg: DecryptedMessage, replay: Replay | undefined): boolean {
  if(settled || !replay || held.length >= MAX_HELD) return false;
  held.push({msg, replay});
  if(!timer) timer = setTimeout(markContactsSettled, SETTLE_TIMEOUT_MS);
  return true;
}

/** Test hook. */
export function resetSenderGateForTests(): void {
  localPhantoms.clear();
  settled = false;
  if(timer) clearTimeout(timer);
  timer = null;
  held = [];
  settledWaiters = [];
}
