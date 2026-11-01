// A browser that cannot encode WebP answers `toDataURL` with something that is
// not a string (jsdom returns null, and a browser without canvas support may
// return undefined), so trust the result only when it really is a data URL.
// Trusting it unconditionally threw at module scope and made every module that
// reaches this file unimportable outside a real browser.
const url = document.createElement('canvas').toDataURL('image/webp');

const IS_WEBP_SUPPORTED = typeof url === 'string' && url.startsWith('data:image/webp');

export default IS_WEBP_SUPPORTED;
