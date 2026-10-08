// @vitest-environment jsdom
/**
 * Tests for the global unhandled-rejection diagnostics.
 *
 * Chrome renders non-Error rejection reasons as the useless
 * 'Uncaught (in promise) #<Object>' — the wake-latency session of 2026-10-08
 * produced 36 of them with no identifiable source. These tests pin:
 *   - describeRejectionReason: Errors (name/message/trimmed stack), plain
 *     objects (JSON), empty objects and class instances ('#<Object>' cases),
 *     primitives.
 *   - installUnhandledRejectionDiagnostics: identical reasons are suppressed
 *     inside the window with a '(+N identical suppressed)' count attached to
 *     the next line.
 */

import '../setup';

import {
  describeRejectionReason,
  installUnhandledRejectionDiagnostics
} from '@lib/phantomchat/unhandled-rejection-diagnostics';

describe('describeRejectionReason', () => {
  it('renders Error reasons with name, message and a trimmed stack', () => {
    const err = new Error('boom');
    const text = describeRejectionReason(err);
    expect(text).toContain('Error: boom');
    expect(text.split('\n').length).toBeLessThanOrEqual(5); // message + up to 4 stack lines
  });

  it('JSON-stringifies plain objects', () => {
    expect(describeRejectionReason({type: 'MTPROTO_DISABLED', code: 503})).toBe('{"type":"MTPROTO_DISABLED","code":503}');
  });

  it('falls back to shape description for empty objects (the Chrome #<Object> case)', () => {
    expect(describeRejectionReason({})).toBe('Object');
  });

  it('falls back to constructor name for non-serialisable instances without own keys', () => {
    const instance = new Map<string, number>([['a', 1]] as any);
    // Map JSON-stringifies to '{}' and has no own enumerable keys.
    expect(describeRejectionReason(instance)).toBe('Map');
  });

  it('falls back to name + keys when JSON.stringify throws (circular)', () => {
    const circular: any = {name: 'circular'};
    circular.self = circular;
    expect(describeRejectionReason(circular)).toBe('Object{name,self}');
  });

  it('renders primitives directly', () => {
    expect(describeRejectionReason('timeout')).toBe('timeout');
    expect(describeRejectionReason(42)).toBe('42');
    expect(describeRejectionReason(null)).toBe('null');
    expect(describeRejectionReason(undefined)).toBe('undefined');
  });
});

describe('installUnhandledRejectionDiagnostics', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  let listener: ((event: {reason: unknown}) => void) | undefined;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Capture the handler the module registers (jsdom has no
    // PromiseRejectionEvent to dispatch natively).
    const original = self.addEventListener.bind(self);
    vi.spyOn(self, 'addEventListener').mockImplementation(((type: string, fn: (event: any) => void, options?: any) => {
      if(type === 'unhandledrejection') listener = fn;
      return original(type, fn, options);
    }) as any);
    installUnhandledRejectionDiagnostics();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    listener = undefined;
  });

  const dispatch = (reason: unknown) => {
    listener?.({reason});
  };

  it('logs the rendered reason', () => {
    dispatch(new Error('first'));
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][1])).toContain('Error: first');
  });

  it('suppresses identical reasons inside the window and counts them', () => {
    // The SAME Error object: identical message AND stack, so identical text.
    const err = new Error('repeat');
    dispatch(err);
    consoleError.mockClear();
    dispatch(err);
    dispatch(err);
    expect(consoleError).not.toHaveBeenCalled();

    // A different reason logs, carrying the suppressed count.
    dispatch(new Error('other'));
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][1])).toContain('+2 identical suppressed');
  });
});
