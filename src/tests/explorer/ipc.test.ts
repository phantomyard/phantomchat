import {describe, expect, it} from 'vitest';
import {encodeMessage, decodeMessages, RequestSchema} from '../../../scripts/explorer/ipc';

describe('ipc framing', () => {
  it('encodes a request as a JSON line ending in \\n', () => {
    const line = encodeMessage({id: '1', cmd: 'capture'});
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line.trim())).toEqual({id: '1', cmd: 'capture'});
  });

  it('decodes multiple framed messages from a buffer', () => {
    const buf = encodeMessage({id: '1', cmd: 'capture'}) +
                encodeMessage({id: '2', cmd: 'teardown'});
    const {messages, remainder} = decodeMessages(buf);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({id: '1', cmd: 'capture'});
    expect(messages[1]).toEqual({id: '2', cmd: 'teardown'});
    expect(remainder).toBe('');
  });

  it('keeps a partial trailing message in the remainder buffer', () => {
    const buf = encodeMessage({id: '1', cmd: 'capture'}) + '{"id":"2","cmd":';
    const {messages, remainder} = decodeMessages(buf);
    expect(messages).toHaveLength(1);
    expect(remainder).toBe('{"id":"2","cmd":');
  });

  it('parses a capture request with the Zod schema', () => {
    const parsed = RequestSchema.safeParse({id: '1', cmd: 'capture'});
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown cmd', () => {
    const parsed = RequestSchema.safeParse({id: '1', cmd: 'wat'});
    expect(parsed.success).toBe(false);
  });

  it('parses a verify_expectation request with a typed expectation payload', () => {
    const parsed = RequestSchema.safeParse({
      id: '1',
      cmd: 'verify_expectation',
      expectation: {
        type: 'element_appears',
        page: 'A',
        selector_hint: 'send-button',
        timeout_ms: 1000
      }
    });
    expect(parsed.success).toBe(true);
  });

  it('parses a run_invariant request with a spec payload', () => {
    const parsed = RequestSchema.safeParse({
      id: '2',
      cmd: 'run_invariant',
      spec: {name: 'INV-x', description: 'x', fnBody: 'return {ok: true};'},
      timeout_ms: 3000
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a verify_expectation with an unknown expectation type', () => {
    const parsed = RequestSchema.safeParse({
      id: '3',
      cmd: 'verify_expectation',
      expectation: {type: 'wat', page: 'A', selector_hint: 'x', timeout_ms: 100}
    });
    expect(parsed.success).toBe(false);
  });
});
