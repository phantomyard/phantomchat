import {describe, expect, it, vi} from 'vitest';
import {createDispatcher, MAX_RUNNING_TOOLS, MAX_RUNNING_TURNS, parseRequest, type EngineLike, type HostMessage} from './dispatch';

const NPUB = 'npub1' + 'q'.repeat(58);

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
    decide: vi.fn(async() => ({answers: {}, latencyMs: 1})),
    phantomchat: {
      info: vi.fn(async() => ({npub: NPUB, configured: true, allowedNpubs: [NPUB]})),
      allow: vi.fn(async(npub: string) => ({npub, added: true, restart: 'none'})),
      disallow: vi.fn(async() => ({removed: true, restart: 'none'})),
      start: vi.fn(async() => ({state: 'running', npub: NPUB, relays: 3})),
      stop: vi.fn(async() => {}),
      status: vi.fn(() => ({state: 'stopped'})),
      onStatus: vi.fn((listener: (s: unknown) => void) => {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      })
    }
  };
  const statusListeners = new Set<(s: unknown) => void>();
  const engine: EngineLike = {
    personas: {
      list: vi.fn(async() => ['local']),
      exists: vi.fn(async() => true),
      create: vi.fn(async() => ({})),
      delete: vi.fn(async() => true)
    },
    providers: {
      list: vi.fn(async() => [{id: 'openrouter', label: 'OpenRouter'}]),
      check: vi.fn(async() => ({status: 'verified', detail: 'HTTP 200', models: [{id: 'm', supportsImages: false}]}))
    },
    decisionModels: {
      check: vi.fn(async() => ({status: 'verified', detail: 'HTTP 200', models: ['typesafe/jev-1.13']}))
    },
    persona: vi.fn(() => persona)
  };
  return {engine, persona, turnCalls, statusListeners, wasCancelled: () => cancelled};
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

  describe('contacts methods', () => {
    it('lists providers and checks a key, passing baseUrl only when given', async() => {
      const {engine} = fakeEngine();
      expect(await send(engine, {id: 1, method: 'providers.list'})).toEqual([
        {id: 1, result: [{id: 'openrouter', label: 'OpenRouter'}]}
      ]);
      await send(engine, {id: 2, method: 'providers.check', params: {provider: 'openrouter', apiKey: 'k'}});
      expect(engine.providers.check).toHaveBeenLastCalledWith('openrouter', 'k', undefined);
      await send(engine, {id: 3, method: 'providers.check', params: {provider: 'openai-compatible', baseUrl: 'http://x'}});
      expect(engine.providers.check).toHaveBeenLastCalledWith('openai-compatible', '', {baseUrl: 'http://x'});
    });

    it('checks a decision-model key, and refuses a missing provider or non-string key', async() => {
      const {engine} = fakeEngine();
      expect(await send(engine, {id: 1, method: 'decisionModels.check', params: {provider: 'typesafe', apiKey: 'k'}})).toEqual([
        {id: 1, result: {status: 'verified', detail: 'HTTP 200', models: ['typesafe/jev-1.13']}}
      ]);
      expect(engine.decisionModels.check).toHaveBeenLastCalledWith('typesafe', 'k');
      const noProvider = await send(engine, {id: 2, method: 'decisionModels.check', params: {apiKey: 'k'}});
      expect(noProvider[0]).toMatchObject({id: 2, error: {code: 'invalid_argument'}});
      const badKey = await send(engine, {id: 3, method: 'decisionModels.check', params: {provider: 'typesafe', apiKey: 7}});
      expect(badKey[0]).toMatchObject({id: 3, error: {code: 'invalid_argument'}});
      expect(engine.decisionModels.check).toHaveBeenCalledTimes(1);
    });

    it('checks embeddings, passing only the given fields, and says when the engine is too old', async() => {
      const {engine} = fakeEngine();
      expect(await send(engine, {id: 1, method: 'embeddings.check', params: {}})).toMatchObject([{id: 1, error: {code: 'not_supported'}}]);
      engine.embeddings = {check: vi.fn(async() => ({status: 'unchecked', detail: 'choose a model', models: ['bge-m3']}))};
      expect(await send(engine, {id: 2, method: 'embeddings.check', params: {provider: 'openai-compatible', baseUrl: 'http://x/v1'}})).toEqual([
        {id: 2, result: {status: 'unchecked', detail: 'choose a model', models: ['bge-m3']}}
      ]);
      expect(engine.embeddings.check).toHaveBeenLastCalledWith({provider: 'openai-compatible', baseUrl: 'http://x/v1'});
      const badKey = await send(engine, {id: 3, method: 'embeddings.check', params: {provider: 'gemini', apiKey: 7}});
      expect(badKey[0]).toMatchObject({id: 3, error: {code: 'invalid_argument'}});
    });

    it('refreshes a persona\'s memory index, or says the engine is too old', async() => {
      const {engine, persona} = fakeEngine();
      expect((await send(engine, {id: 1, method: 'persona.memory.refresh', params: {persona: 'p'}}))[0]).toMatchObject({error: {code: 'not_supported'}});
      (persona.memory as any).refresh = vi.fn(async() => ({indexed: 1, removed: 0, embedded: 2, embedFailed: 0}));
      expect(await send(engine, {id: 2, method: 'persona.memory.refresh', params: {persona: 'p'}})).toEqual([
        {id: 2, result: {indexed: 1, removed: 0, embedded: 2, embedFailed: 0}}
      ]);
    });

    it('refuses an allowlist entry that is not an npub', async() => {
      const {engine, persona} = fakeEngine();
      const out = await send(engine, {id: 1, method: 'persona.phantomchat.allow', params: {persona: 'p', npub: 'nsec1abc'}});
      expect(out[0]).toMatchObject({id: 1, error: {code: 'invalid_argument'}});
      expect(persona.phantomchat.allow).not.toHaveBeenCalled();
      await send(engine, {id: 2, method: 'persona.phantomchat.allow', params: {persona: 'p', npub: NPUB}});
      expect(persona.phantomchat.allow).toHaveBeenCalledWith(NPUB, undefined);
    });

    it('forwards channel status as events after start, and stops after delete', async() => {
      const {engine, statusListeners} = fakeEngine();
      const out: HostMessage[] = [];
      const d = createDispatcher(engine, info, (m) => out.push(m));
      await d.handle({id: 1, method: 'persona.phantomchat.start', params: {persona: 'p', displayName: 'Claude'}});
      await d.handle({id: 2, method: 'persona.phantomchat.start', params: {persona: 'p'}});
      expect(statusListeners.size).toBe(1);
      for(const l of statusListeners) l({state: 'failed', error: 'relay'});
      expect(out).toContainEqual({event: 'phantomchat', persona: 'p', data: {state: 'failed', error: 'relay'}});
      await d.handle({id: 3, method: 'personas.delete', params: {persona: 'p'}});
      expect(statusListeners.size).toBe(0);
      expect(engine.personas.delete).toHaveBeenCalledWith('p');
    });
  });

  describe('tools.run', () => {
    it('runs only the seven protocol tools', async() => {
      const {engine} = fakeEngine();
      const runTool = vi.fn(async() => ({status: 'ok' as const, output: 'hi', exit: 0}));
      const out: HostMessage[] = [];
      const d = createDispatcher(engine, info, (m) => out.push(m), runTool);
      await d.handle({id: 1, method: 'tools.run', params: {callId: 'c1', tool: 'bash', args: {command: 'echo hi'}}});
      await d.handle({id: 2, method: 'tools.run', params: {callId: 'c2', tool: 'rm', args: {}}});
      expect(out[0]).toEqual({id: 1, result: {status: 'ok', output: 'hi', exit: 0}});
      expect(out[1]).toMatchObject({id: 2, error: {code: 'invalid_argument'}});
      expect(runTool).toHaveBeenCalledTimes(1);
    });

    it('says not_supported without a runner', async() => {
      const {engine} = fakeEngine();
      expect((await send(engine, {id: 1, method: 'tools.run', params: {callId: 'c', tool: 'ls'}}))[0])
      .toMatchObject({error: {code: 'not_supported'}});
    });

    it('cancel aborts the run and reports cancelled; a thrown tool is an error result', async() => {
      const {engine} = fakeEngine();
      const runTool = vi.fn((_t: string, _a: unknown, signal: AbortSignal) => new Promise<any>((resolve, reject) => {
        if((_a as any).fail) return reject(new Error('boom'));
        signal.addEventListener('abort', () => resolve({status: 'ok', output: 'partial'}));
      }));
      const out: HostMessage[] = [];
      const d = createDispatcher(engine, info, (m) => out.push(m), runTool as any);
      const running = d.handle({id: 1, method: 'tools.run', params: {callId: 'c1', tool: 'bash', args: {}}});
      await d.handle({id: 2, method: 'tools.cancel', params: {callId: 'c1'}});
      await running;
      await d.handle({id: 3, method: 'tools.run', params: {callId: 'c3', tool: 'read', args: {fail: true}}});
      expect(out).toContainEqual({id: 2, result: true});
      expect(out).toContainEqual({id: 1, result: {status: 'cancelled', output: 'partial'}});
      expect(out).toContainEqual({id: 3, result: {status: 'error', output: 'boom'}});
    });

    it('refuses a tool run past the cap with busy, and frees the slot when one ends', async() => {
      const {engine} = fakeEngine();
      const runTool = vi.fn((_t: string, _a: unknown, signal: AbortSignal) => new Promise<any>((resolve) => {
        signal.addEventListener('abort', () => resolve({status: 'ok', output: ''}));
      }));
      const out: HostMessage[] = [];
      const d = createDispatcher(engine, info, (m) => out.push(m), runTool as any);
      const running: Promise<void>[] = [];
      for(let i = 0; i < MAX_RUNNING_TOOLS; i++) {
        running.push(d.handle({id: i, method: 'tools.run', params: {callId: `c${i}`, tool: 'bash', args: {}}}));
      }
      await d.handle({id: 100, method: 'tools.run', params: {callId: 'over', tool: 'bash', args: {}}});
      expect(out).toEqual([{id: 100, error: {code: 'busy', message: expect.stringContaining('already running')}}]);
      expect(runTool).toHaveBeenCalledTimes(MAX_RUNNING_TOOLS);
      await d.handle({id: 101, method: 'tools.cancel', params: {callId: 'c0'}});
      await running[0];
      const again = d.handle({id: 102, method: 'tools.run', params: {callId: 'again', tool: 'bash', args: {}}});
      expect(runTool).toHaveBeenCalledTimes(MAX_RUNNING_TOOLS + 1);
      d.cancelAll();
      await Promise.all([...running, again]);
    });

    it('times out at the requested limit', async() => {
      vi.useFakeTimers();
      try {
        const {engine} = fakeEngine();
        const runTool = vi.fn((_t: string, _a: unknown, signal: AbortSignal) => new Promise<any>((resolve) => {
          signal.addEventListener('abort', () => resolve({status: 'ok', output: ''}));
        }));
        const out: HostMessage[] = [];
        const d = createDispatcher(engine, info, (m) => out.push(m), runTool as any);
        const running = d.handle({id: 1, method: 'tools.run', params: {callId: 'c1', tool: 'bash', args: {}, timeoutMs: 1000}});
        await vi.advanceTimersByTimeAsync(1000);
        await running;
        expect(out).toEqual([{id: 1, result: {status: 'timeout', output: ''}}]);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
