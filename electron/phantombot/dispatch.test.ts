import {describe, expect, it, vi} from 'vitest';
import {createDispatcher, MAX_RUNNING_TURNS, parseRequest, type EngineLike, type HostMessage} from './dispatch';

function fakeEngine() {
  const turnCalls: unknown[] = [];
  let cancelled = false;
  const persona = {
    configure: vi.fn(async() => {}),
    secrets: {set: vi.fn(async() => {}), has: vi.fn(async() => true), delete: vi.fn(async() => {})},
    memory: {search: vi.fn(async() => [{path: 'kb/a.md'}]), capture: vi.fn(async() => {})},
    turn: vi.fn((options: unknown) => {
      turnCalls.push(options);
      return {
        async *[Symbol.asyncIterator]() {
          yield {type: 'text', text: 'po'};
          yield {type: 'text', text: 'ng'};
        },
        result: async() => ({text: 'pong', held: false, conversation: 'app:x'}),
        cancel: () => {
          cancelled = true;
        }
      };
    }),
    askJson: vi.fn(async(options: any) => ({value: options.schema({a: 1}), text: '{"a":1}', held: false, attempts: 1})),
    decide: vi.fn(async() => ({answers: {}, latencyMs: 1}))
  };
  const engine: EngineLike = {
    personas: {list: vi.fn(async() => ['local']), exists: vi.fn(async() => true), create: vi.fn(async() => ({}))},
    persona: vi.fn(() => persona)
  };
  return {engine, persona, turnCalls, wasCancelled: () => cancelled};
}

const info = {phantombot: '1.1.464', pi: '1.4.0', bun: '1.4.4'};

async function send(engine: EngineLike, value: unknown) {
  const out: HostMessage[] = [];
  await createDispatcher(engine, info, (m) => out.push(m)).handle(value);
  return out;
}

describe('phantombot host dispatcher', () => {
  it('rejects methods outside the allowlist, with the id', async() => {
    const {engine} = fakeEngine();
    expect(await send(engine, {id: 3, method: 'persona.secrets.get', params: {}})).toEqual([
      {id: 3, error: {code: 'invalid_argument', message: 'unknown method persona.secrets.get'}}
    ]);
  });

  it('drops a line without a numeric id', async() => {
    const {engine} = fakeEngine();
    expect(await send(engine, {method: 'info'})).toEqual([]);
    expect(() => parseRequest({id: '1', method: 'info'})).toThrow();
  });

  it('defaults a turn to the principal and streams its events before the result', async() => {
    const {engine, turnCalls} = fakeEngine();
    const out = await send(engine, {id: 1, method: 'persona.turn', params: {persona: 'local', turnId: 't1', options: {message: 'ping'}}});
    expect(turnCalls).toEqual([{message: 'ping', source: 'principal'}]);
    expect(out).toEqual([
      {event: 'turn', turnId: 't1', data: {type: 'text', text: 'po'}},
      {event: 'turn', turnId: 't1', data: {type: 'text', text: 'ng'}},
      {id: 1, result: {text: 'pong', held: false, conversation: 'app:x'}}
    ]);
  });

  it('passes only documented turn options, and keeps an explicit untrusted source', async() => {
    const {engine, turnCalls} = fakeEngine();
    await send(engine, {id: 1, method: 'persona.turn', params: {persona: 'local', turnId: 't1', options: {
      message: 'hi', source: 'untrusted', tools: 'full', workingDir: '/tmp/w', history: false, conversation: 'c', signal: 'x', env: {A: 1}
    }}});
    expect(turnCalls).toEqual([{message: 'hi', source: 'untrusted', tools: 'full', workingDir: '/tmp/w', history: false, conversation: 'c'}]);
  });

  it('refuses a bad source, bad tools and odd persona names', async() => {
    const {engine, persona} = fakeEngine();
    for(const params of [
      {persona: 'local', turnId: 't', options: {message: 'x', source: 'admin'}},
      {persona: 'local', turnId: 't', options: {message: 'x', tools: 'root'}},
      {persona: '../etc', turnId: 't', options: {message: 'x'}}
    ]) {
      const [reply] = await send(engine, {id: 9, method: 'persona.turn', params});
      expect(reply).toMatchObject({id: 9, error: {code: 'invalid_argument'}});
    }
    expect(persona.turn).not.toHaveBeenCalled();
  });

  it('cancels a running turn by id', async() => {
    const {engine, persona} = fakeEngine();
    let release: () => void;
    const gate = new Promise<void>((r) => release = r);
    persona.turn.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {
        await gate;
      },
      result: async() => ({text: '', held: false, conversation: 'app:x'}),
      cancel: () => release()
    }) as any);
    const out: HostMessage[] = [];
    const d = createDispatcher(engine, info, (m) => out.push(m));
    const turn = d.handle({id: 1, method: 'persona.turn', params: {persona: 'local', turnId: 't1', options: {message: 'x'}}});
    await Promise.resolve();
    expect(d.runningTurns).toBe(1);
    await d.handle({id: 2, method: 'turn.cancel', params: {turnId: 't1'}});
    await turn;
    expect(out).toContainEqual({id: 2, result: true});
    expect(d.runningTurns).toBe(0);
  });

  it('refuses a model call past the cap with busy, and frees the slot when one ends', async() => {
    const {engine, persona} = fakeEngine();
    const releases: Array<() => void> = [];
    persona.turn.mockImplementation(() => {
      const gate = new Promise<void>((r) => releases.push(r));
      return {
        async *[Symbol.asyncIterator]() {
          await gate;
        },
        result: async() => ({text: '', held: false, conversation: 'app:x'}),
        cancel: () => {}
      } as any;
    });
    let releaseAsk: () => void;
    persona.askJson.mockImplementationOnce(() => new Promise((r) => releaseAsk = () => r({value: 1})) as any);
    const out: HostMessage[] = [];
    const d = createDispatcher(engine, info, (m) => out.push(m));
    const running = [d.handle({id: 0, method: 'persona.askJson', params: {persona: 'local', options: {message: 'j'}}})];
    for(let i = 1; i < MAX_RUNNING_TURNS; i++) {
      running.push(d.handle({id: i, method: 'persona.turn', params: {persona: 'local', turnId: `t${i}`, options: {message: 'x'}}}));
    }
    await Promise.resolve();
    for(const [id, method, params] of [
      [90, 'persona.turn', {persona: 'local', turnId: 'over', options: {message: 'x'}}],
      [91, 'persona.askJson', {persona: 'local', options: {message: 'x'}}],
      [92, 'persona.decide', {persona: 'local', options: {questions: []}}]
    ] as const) {
      // Not awaited: if the cap regresses, the call runs instead of hanging the test.
      void d.handle({id, method, params});
      await new Promise((r) => setTimeout(r, 0));
      expect(out).toContainEqual({id, error: {code: 'busy', message: expect.stringContaining('already running')}});
    }
    expect(persona.decide).not.toHaveBeenCalled();
    releaseAsk!();
    await running[0];
    await d.handle({id: 93, method: 'persona.decide', params: {persona: 'local', options: {questions: []}}});
    expect(out).toContainEqual({id: 93, result: {answers: {}, latencyMs: 1}});
    releases.forEach((r) => r());
    await Promise.all(running);
    expect(d.runningTurns).toBe(0);
  });

  it('frees the slot when a model call rejects', async() => {
    const {engine, persona} = fakeEngine();
    persona.askJson.mockRejectedValue(Object.assign(new Error('bad json'), {code: 'invalid_json'}));
    const out: HostMessage[] = [];
    const d = createDispatcher(engine, info, (m) => out.push(m));
    for(let i = 0; i <= MAX_RUNNING_TURNS; i++) {
      await d.handle({id: i, method: 'persona.askJson', params: {persona: 'local', options: {message: 'x'}}});
    }
    // A leaked slot per rejection would turn the last call into busy.
    expect(out.map((m: any) => m.error?.code)).toEqual(Array(MAX_RUNNING_TURNS + 1).fill('invalid_json'));
  });

  it('writes secrets into the vault and never returns one', async() => {
    const {engine, persona} = fakeEngine();
    expect(await send(engine, {id: 1, method: 'persona.secrets.set', params: {persona: 'local', name: 'K', value: 'v'}})).toEqual([{id: 1, result: null}]);
    expect(persona.secrets.set).toHaveBeenCalledWith('K', 'v');
    expect(await send(engine, {id: 2, method: 'persona.secrets.has', params: {persona: 'local', name: 'K'}})).toEqual([{id: 2, result: true}]);
  });

  it('turns an engine error into its code', async() => {
    const {engine, persona} = fakeEngine();
    persona.decide.mockRejectedValueOnce(Object.assign(new Error('no decision model'), {code: 'not_configured'}));
    expect(await send(engine, {id: 1, method: 'persona.decide', params: {persona: 'local', options: {}}})).toEqual([
      {id: 1, error: {code: 'not_configured', message: 'no decision model'}}
    ]);
  });

  it('runs askJson with a pass-through validator', async() => {
    const {engine} = fakeEngine();
    const [reply] = await send(engine, {id: 1, method: 'persona.askJson', params: {persona: 'local', options: {message: 'x', jsonSchema: {type: 'object'}}}});
    expect(reply).toMatchObject({id: 1, result: {value: {a: 1}}});
  });
});
