import {ServiceWorkerURL} from '@lib/update/service-worker-url';

const LS_INSTALLED_SW_URL = 'nostra.update.installedSwUrl';

/**
 * Returns the SW URL that apiManagerProxy should register on boot.
 *
 * Steady state: the already-installed URL from localStorage. Using the bundle's
 * hashed `ServiceWorkerURL` on every boot means a new deploy (new hash) would
 * register a different URL, installing a waiting SW outside the user-driven
 * update flow — which update-bootstrap Step 1a.5 treats as compromise.
 * First install: fall back to the bundle's declared URL.
 */
export function resolveSwRegistrationUrl(): string {
  try {
    const stored = localStorage.getItem(LS_INSTALLED_SW_URL);
    if(stored) return stored;
  } catch{}
  return ServiceWorkerURL as unknown as string;
}
