/**
 * Relay read-back health scoring + deterministic ranking (issue #359).
 *
 * THIS FILE IS A DELIBERATE MIRROR of phantombot's
 * `src/channels/phantomchat/relayHealth.ts`. The scoring function and the sort
 * order MUST stay byte-for-byte equivalent in behaviour across the two
 * codebases. Here is why that matters more than it looks:
 *
 *   A message is delivered when the sender and the recipient share at least
 *   one healthy relay. Both ends quarantine bad relays INDEPENDENTLY, from
 *   their own observations. If the PWA and the bot rank relays differently
 *   they can converge on DISJOINT subsets — both perfectly healthy by their
 *   own lights, with an empty intersection, and every message silently lost.
 *   Identical ranking is what keeps the intersection non-empty.
 *
 * So: if you change `relayScore` or `rankRelays` here, change it there in the
 * same breath. Both are PURE — no clock, no randomness, no I/O — precisely so
 * that "same observations ⇒ same order" is a property you can actually rely on
 * rather than hope for.
 */

/** Consecutive read-back failures before a relay is quarantined from writes. */
export const READBACK_STRIKE_THRESHOLD = 5;

/**
 * First quarantine span, doubling on each repeat offence up to the cap, so a
 * relay that had one bad hour returns quickly while a persistently dead one is
 * retried roughly twice a day instead of hourly.
 */
export const READBACK_QUARANTINE_BASE_MS = 60 * 60 * 1000; // 1 hour
export const READBACK_QUARANTINE_MAX_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * ±10% jitter on every quarantine span. Without it a fleet that all saw the
 * same relay die at the same moment un-quarantines it in lockstep and
 * stampedes it. Applied once, when the quarantine is set.
 */
export const READBACK_QUARANTINE_JITTER = 0.1;

/**
 * Never write to fewer than this many relays. Delivery needs only ONE healthy
 * relay shared by both ends — but see the file header: the two ends quarantine
 * independently, so we hold a floor of 3 to keep their intersection non-empty.
 * A quarantine is an OPINION about relay quality; the floor is a HARD
 * CONSTRAINT and outranks it.
 */
export const MIN_WRITE_RELAYS = 3;

/** Per-relay read-back health. Mirrors phantombot's RelayHealthRecord. */
export interface ReadBackHealth {
  /** Consecutive read-back failures; any confirmed store resets it to 0. */
  strikes: number;
  /** Lifetime counters, used for ranking. */
  confirmed: number;
  dropped: number;
  /** Epoch ms until which this relay is out of the WRITE set; 0 = eligible. */
  quarantinedUntil: number;
  /** Quarantines served — drives the exponential backoff. */
  quarantineCount: number;
}

export function emptyReadBackHealth(): ReadBackHealth {
  return {strikes: 0, confirmed: 0, dropped: 0, quarantinedUntil: 0, quarantineCount: 0};
}

/**
 * Health score in [0, 1]: the share of read-backs this relay confirmed. A
 * relay with no observations scores 1 — optimistic, which is what lets a fresh
 * client use its configured relays immediately instead of trusting none of
 * them. Current strikes apply a small penalty so a relay failing RIGHT NOW
 * ranks below one with an equal lifetime ratio that is currently fine.
 */
export function relayScore(rec: ReadBackHealth | undefined): number {
  if(!rec) return 1;
  const total = rec.confirmed + rec.dropped;
  const ratio = total === 0 ? 1 : rec.confirmed / total;
  const strikePenalty = Math.min(rec.strikes, READBACK_STRIKE_THRESHOLD) /
    (READBACK_STRIKE_THRESHOLD * 10);
  return Math.max(0, ratio - strikePenalty);
}

/**
 * Deterministic total order: best score first, url ascending as the tiebreak.
 * The url tiebreak is load-bearing, not cosmetic — it is what makes the order
 * TOTAL, and therefore what makes two clients with zero observations pick the
 * same three relays. Do not add a time-based or random term.
 */
export function rankRelays(
  urls: readonly string[],
  health: ReadonlyMap<string, ReadBackHealth>
): string[] {
  return [...urls].sort((a, b) => {
    const diff = relayScore(health.get(b)) - relayScore(health.get(a));
    if(Math.abs(diff) > 1e-9) return diff;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * The quarantine span for the Nth offence (0-indexed), before jitter.
 * Exponential, capped.
 */
export function quarantineSpanMs(offence: number): number {
  return Math.min(
    READBACK_QUARANTINE_BASE_MS * Math.pow(2, offence),
    READBACK_QUARANTINE_MAX_MS
  );
}

/**
 * Choose the write set from `urls`, dropping relays under quarantine but never
 * returning fewer than MIN_WRITE_RELAYS: if quarantine would take us below the
 * floor, the best-ranked quarantined relays are promoted back to fill it.
 *
 * PROMOTION IS FREE. Quarantine here excludes a relay from WRITES only — it
 * keeps its socket and its read subscription (see the pool's
 * recordReadBackResult). So a promoted relay is a warm spare: no reconnect, no
 * handshake, no wait. That is the whole reason quarantine never disconnects.
 *
 * Pure apart from the `now` argument, which the caller supplies — so quarantine
 * expiry is evaluated lazily, at the moment a write needs a target set, and
 * nothing has to wake up on a timer to expire anything.
 */
export function selectWriteTargets(
  urls: readonly string[],
  health: ReadonlyMap<string, ReadBackHealth>,
  now: number,
  floor: number = MIN_WRITE_RELAYS
): string[] {
  const ranked = rankRelays(urls, health);
  const eligible = ranked.filter(u => (health.get(u)?.quarantinedUntil ?? 0) <= now);
  if(eligible.length >= floor) return eligible;

  const out = [...eligible];
  for(const url of ranked) {
    if(out.length >= floor) break;
    if(!out.includes(url)) out.push(url);
  }
  return out;
}
