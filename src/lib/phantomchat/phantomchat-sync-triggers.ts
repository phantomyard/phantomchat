/**
 * Sync trigger registry — the seam between the code that MUTATES contacts and
 * groups (addP2PContact, deleteContacts, GroupAPI, …) and the CRDT sync
 * engines that PUBLISH those changes cross-device.
 *
 * Mutation sites depend only on this tiny module, never on the engines. At
 * boot, `phantomchat-onboarding-integration` registers a debounced publisher
 * for each domain; before that (and after logout) `schedulePublish` is a
 * silent no-op, so mutation paths never break when sync is disabled or not yet
 * wired.
 *
 * This is deliberately a runtime registry rather than an import edge:
 * add-p2p-contact.ts and group-api.ts run in contexts where the sync engine's
 * dependencies (conversation key, ChatAPI) may not exist, and must not pull
 * them in.
 */

export type SyncDomain = 'contacts' | 'groups';

type Publisher = () => void;

const publishers: Partial<Record<SyncDomain, Publisher>> = {};

/** Wire a domain's debounced publisher. Called once per domain at boot. */
export function registerSyncPublisher(domain: SyncDomain, publish: Publisher): void {
  publishers[domain] = publish;
}

/**
 * Ask the given domain to publish its current local view cross-device. No-op
 * when no publisher is registered (sync disabled / pre-boot / post-logout).
 * Safe to call from any mutation path; the registered publisher is expected to
 * debounce, so calling this on every add/delete is fine.
 */
export function schedulePublish(domain: SyncDomain): void {
  try {
    publishers[domain]?.();
  } catch(err) {
    console.warn('[phantomchat-sync-triggers] publish trigger failed', domain, err);
  }
}

/** Drop all publishers — called on logout so a stale engine isn't retriggered. */
export function clearSyncPublishers(): void {
  delete publishers.contacts;
  delete publishers.groups;
}
