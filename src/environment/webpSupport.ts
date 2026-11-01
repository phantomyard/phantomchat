// A browser that cannot encode WebP answers `toDataURL` with a PNG data URL, so
// the capability answer below has always been right there. Outside a browser it
// may return nothing at all - jsdom has no canvas and answers null - and calling
// `.startsWith` on that threw at module scope, which made every module reaching
// this file unimportable. Trust the result only when it really is a string.
const url = document.createElement('canvas').toDataURL('image/webp');

const IS_WEBP_SUPPORTED = typeof url === 'string' && url.startsWith('data:image/webp');

export default IS_WEBP_SUPPORTED;
