/*
 * app:// scheme privileges (PR #152). Without allowServiceWorkers,
 * navigator.serviceWorker.register() rejects on the desktop origin and every
 * SW-backed feature silently never starts.
 */
import {describe, it, expect} from 'vitest';
import {APP_SCHEME_PRIVILEGES} from './scheme';

describe('APP_SCHEME_PRIVILEGES', () => {
  it('allows service workers on app://', () => {
    expect(APP_SCHEME_PRIVILEGES.allowServiceWorkers).toBe(true);
  });

  it('keeps the standard/secure/fetch privileges the renderer relies on', () => {
    expect(APP_SCHEME_PRIVILEGES).toMatchObject({standard: true, secure: true, supportFetchAPI: true});
  });
});
