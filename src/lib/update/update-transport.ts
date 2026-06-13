/**
 * Transport selector for update-related HTTP requests.
 * In privacy (Tor) mode, routes through webtorClient.fetch to avoid
 * leaking the user's IP to CDN / GitHub / IPFS gateways during
 * integrity checks. In direct mode, uses native fetch().
 */

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let currentFetch: FetchFn = (input, init) => fetch(input as any, init);

export function setUpdateTransport(fn: FetchFn): void {
  currentFetch = fn;
}

export function resetUpdateTransport(): void {
  currentFetch = (input, init) => fetch(input as any, init);
}

export const updateTransport = {
  fetch: (url: string, init?: RequestInit) => currentFetch(url, init)
};
