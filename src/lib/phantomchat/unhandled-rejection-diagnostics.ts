/*
 * Global unhandled promise rejection diagnostics.
 *
 * Chrome renders unhandled rejection reasons that are neither Error instances
 * nor nicely-serialisable objects as the useless 'Uncaught (in promise)
 * #<Object>' — which is exactly what the console capture of a slow-wake
 * session produced (36 of them in one afternoon, sources invisible). This
 * handler renders the reason: Errors keep name/message + a trimmed stack,
 * plain objects are JSON-stringified, class instances fall back to their
 * constructor name plus own enumerable keys.
 *
 * Identical reasons are rate-limited (one full log per window, with a
 * suppressed count attached to the next line) so a 1/s rejection loop cannot
 * flood the captured log.
 */

const IDENTICAL_SUPPRESS_WINDOW_MS = 30_000;
const STACK_LINES = 4;

export function describeRejectionReason(reason: unknown): string {
  if(reason instanceof Error) {
    const stack = reason.stack ? '\n' + reason.stack.split('\n').slice(1, STACK_LINES).join('\n') : '';
    return reason.name + ': ' + reason.message + stack;
  }

  if(reason === null || reason === undefined || typeof reason !== 'object') {
    return String(reason);
  }

  try {
    const serialised = JSON.stringify(reason);
    if(serialised && serialised !== '{}') return serialised;
  } catch{}

  // Non-serialisable instance (the Chrome '#<Object>' case): best-effort shape.
  const name = (reason as any)?.constructor?.name || 'Object';
  const keys = Object.keys(reason as any).slice(0, 8).join(',');
  return keys ? name + '{' + keys + '}' : name;
}

export function installUnhandledRejectionDiagnostics(): void {
  if(typeof self === 'undefined' || typeof (self as any).addEventListener !== 'function') {
    return;
  }

  let lastKey: string | null = null;
  let lastAt = 0;
  let suppressed = 0;

  (self as any).addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const text = describeRejectionReason(event.reason);
    const now = Date.now();

    if(text === lastKey && now - lastAt < IDENTICAL_SUPPRESS_WINDOW_MS) {
      suppressed++;
      return;
    }

    const suffix = suppressed > 0 ? ' (+' + suppressed + ' identical suppressed)' : '';
    suppressed = 0;
    lastKey = text;
    lastAt = now;

    console.error('[unhandledRejection]', text + suffix, {reason: event.reason});
  });
}
