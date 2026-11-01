/*
 * Content-Security-Policy for everything served from app://localhost.
 *
 * The frontend is fetched from the live PWA, so the boot-splash inline scripts
 * are only known when a document arrives: their hashes are computed per
 * document. Inline script injected into the page later still has no matching
 * hash, so script-src stays free of 'unsafe-inline'.
 */
import {createHash} from 'node:crypto';

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

export function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(INLINE_SCRIPT)]
  .map((match) => match[1])
  .filter((body) => body.trim().length > 0)
  .map((body) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`);
}

/** Pass the document's HTML; workers and other assets get the hash-free policy. */
export function buildCsp(html = ''): string {
  return [
    "default-src 'self'",
    // rlottie compiles WebAssembly in a worker; keep JavaScript eval blocked.
    ["script-src 'self' 'wasm-unsafe-eval'", ...inlineScriptHashes(html)].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' wss: https: blob: data:",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ');
}
