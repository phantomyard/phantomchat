/*
 * Privileges for the app:// scheme the packaged UI is served from.
 * Kept in its own module so tests can assert on it without booting Electron.
 */
export const APP_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  allowServiceWorkers: true
} as const;
