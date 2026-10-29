/**
 * Code Mode ↔ PhantomOps client.
 *
 * The protocol is newline-delimited JSON over `/api/chat/*`, authenticated with
 * a PhantomOps API key (`pok_…`) sent as a Bearer header. Both of those are easy
 * to get subtly wrong and impossible to notice in a browser until a phantom
 * answers in the wrong place, so they are pinned here with a fake fetch and a
 * fake local storage — no network, no DOM.
 */
import {describe, it, expect} from 'vitest';
import PhantomOpsClient, {
  PHANTOMOPS_BASE_URL,
  PHANTOMOPS_TOKEN_STORAGE_KEY,
  applyPhantomOpsEvent,
  isPhantomOpsApiToken,
  maskPhantomOpsApiToken,
  readPhantomOpsEvents,
  type PhantomOpsState
} from '@lib/phantomchat/code-mode-phantomops';

const API_KEY = 'pok_0123456789ab_' + 'k'.repeat(48);

const streamFrom = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if(index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index++]));
    }
  });
};

const collect = async(chunks: string[]) => {
  const events: any[] = [];
  for await(const event of readPhantomOpsEvents(streamFrom(chunks))) events.push(event);
  return events;
};

describe('readPhantomOpsEvents', () => {
  it('reads one event per line', async() => {
    const events = await collect([
      '{"status":"thinking"}\n{"status":"streaming","content":"hi"}\n'
    ]);
    expect(events).toEqual([
      {status: 'thinking'},
      {status: 'streaming', content: 'hi'}
    ]);
  });

  it('reassembles a line split across chunks', async() => {
    const events = await collect(['{"status":"thin', 'king"}\n']);
    expect(events).toEqual([{status: 'thinking'}]);
  });

  it('flushes a trailing line with no newline', async() => {
    const events = await collect(['{"status":"complete","response":"ok"}']);
    expect(events).toEqual([{status: 'complete', response: 'ok'}]);
  });

  it('skips malformed lines instead of killing the stream', async() => {
    const events = await collect(['{"status":"thinking"}\nnot json\n{"status":"complete"}\n']);
    expect(events.map((e) => e.status)).toEqual(['thinking', 'complete']);
  });

  it('ignores blank keepalive lines', async() => {
    const events = await collect(['\n\n{"status":"thinking"}\n\n']);
    expect(events).toEqual([{status: 'thinking'}]);
  });
});

describe('isPhantomOpsApiToken', () => {
  it('accepts a minted key', () => {
    expect(isPhantomOpsApiToken(API_KEY)).toBe(true);
    expect(isPhantomOpsApiToken(`  ${API_KEY}  `)).toBe(true);
  });

  it('rejects anything that is not a pok_ key', () => {
    expect(isPhantomOpsApiToken('')).toBe(false);
    expect(isPhantomOpsApiToken(null)).toBe(false);
    expect(isPhantomOpsApiToken(undefined)).toBe(false);
    expect(isPhantomOpsApiToken('jwt.header.payload')).toBe(false);
    expect(isPhantomOpsApiToken('pok_short')).toBe(false);
  });
});

describe('maskPhantomOpsApiToken', () => {
  it('keeps the key prefix and never the body', () => {
    expect(maskPhantomOpsApiToken(API_KEY)).toBe('pok_0123456789ab_…');
    expect(maskPhantomOpsApiToken(API_KEY)).not.toContain('kkkk');
  });

  it('is empty without a key', () => {
    expect(maskPhantomOpsApiToken(null)).toBe('');
  });
});

describe('applyPhantomOpsEvent', () => {
  const base: PhantomOpsState = {
    signedIn: true,
    busy: true,
    activity: 'Thinking…',
    error: null,
    messages: [],
    gate: null,
    sessionId: null
  };

  it('records the pinned session id', () => {
    const next = applyPhantomOpsEvent(base, {status: 'session_open', session_id: 42});
    expect(next.sessionId).toBe(42);
  });

  it('surfaces a tool gate so the user can approve or deny it', () => {
    const next = applyPhantomOpsEvent(base, {
      status: 'confirmation_required',
      gate_id: 'g1',
      tool: 'deploy',
      args_summary: 'ship it',
      rationale: 'you asked'
    });
    expect(next.gate).toEqual({
      gateId: 'g1',
      kind: 'confirm',
      tool: 'deploy',
      name: '',
      summary: 'ship it',
      rationale: 'you asked'
    });
  });

  it('surfaces a secret request as a gate instead of parking the turn', () => {
    const next = applyPhantomOpsEvent(base, {
      status: 'secret_required',
      gate_id: 'g2',
      name: 'PLANE_API_KEY',
      rationale: 'Plane needs it'
    });
    expect(next.gate).toEqual({
      gateId: 'g2',
      kind: 'secret',
      tool: '',
      name: 'PLANE_API_KEY',
      summary: '',
      rationale: 'Plane needs it'
    });
  });

  it('says so when a turn wants a local tool this client cannot run', () => {
    const next = applyPhantomOpsEvent(base, {status: 'client_tool_required', name: 'read_file'});
    expect(next.error).toContain('read_file');
    expect(next.gate).toBe(null);
  });

  it('shows work-in-progress activity and clears it when a tool finishes', () => {
    const working = applyPhantomOpsEvent(base, {status: 'working', description: 'Reading Plane'});
    expect(working.activity).toBe('Reading Plane');
    expect(applyPhantomOpsEvent(working, {status: 'tool_complete'}).activity).toBe('Thinking…');
  });

  it('ignores unknown statuses without touching state', () => {
    expect(applyPhantomOpsEvent(base, {status: 'brand_new_thing'})).toBe(base);
  });
});

const fakeStorage = () => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string): void => { map.set(k, v); },
    removeItem: (k: string): void => { map.delete(k); }
  };
};

const jsonResponse = (body: any, init: {status?: number, stream?: ReadableStream} = {}) => {
  return new Response(init.stream ?? JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {'Content-Type': init.stream ? 'application/x-ndjson' : 'application/json'}
  });
};

/** A client that already holds `API_KEY`, the shape a restored launch has. */
const signedInClient = (fetchImpl: typeof fetch, storage = fakeStorage()) => {
  storage.setItem(PHANTOMOPS_TOKEN_STORAGE_KEY, API_KEY);
  const ops = new PhantomOpsClient({storage, fetch: fetchImpl});
  return {ops, storage};
};

describe('PhantomOpsClient — connect', () => {
  it('adopts the key, loads the chat and pins both', async() => {
    const storage = fakeStorage();
    const requests: {url: string; auth?: string}[] = [];
    const fetchImpl = (async(url: string, init: RequestInit) => {
      requests.push({url: String(url), auth: (init?.headers as any)?.Authorization});
      return jsonResponse({
        session_id: 7,
        messages: [{role: 'user', content: 'hi'}, {role: 'assistant', content: 'hello'}]
      });
    }) as unknown as typeof fetch;

    const ops = new PhantomOpsClient({storage, fetch: fetchImpl});
    await ops.connect(`  ${API_KEY}  `);

    expect(ops.isSignedIn()).toBe(true);
    // the header reads the hint off the SAME state it renders, so a connect
    // that emits before adopting the key would show a blank one
    expect(ops.tokenHint()).toBe('pok_0123456789ab_…');
    expect(ops.state.sessionId).toBe(7);
    expect(ops.state.messages.map((m) => [m.role, m.text])).toEqual([['user', 'hi'], ['assistant', 'hello']]);
    expect(storage.map.get(PHANTOMOPS_TOKEN_STORAGE_KEY)).toBe(API_KEY);
    // history is the proof the key works: one authenticated GET, no popup
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`${PHANTOMOPS_BASE_URL}/api/chat/history`);
    expect(requests[0].auth).toBe(`Bearer ${API_KEY}`);
  });

  it('refuses an obvious paste error without touching the network', async() => {
    let calls = 0;
    const fetchImpl = (async() => {
      calls++;
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const ops = new PhantomOpsClient({storage: fakeStorage(), fetch: fetchImpl});
    await expect(ops.connect('jwt.header.payload')).rejects.toThrow(/pok_/);

    expect(calls).toBe(0);
    expect(ops.isSignedIn()).toBe(false);
    expect(ops.state.error).toMatch(/pok_/);
  });

  it('refuses an empty key', async() => {
    const ops = new PhantomOpsClient({storage: fakeStorage(), fetch: (async() => jsonResponse({})) as any});
    await expect(ops.connect('   ')).rejects.toThrow(/API key/);
    expect(ops.isSignedIn()).toBe(false);
  });

  it('drops a rejected key and says why', async() => {
    const storage = fakeStorage();
    const fetchImpl = (async() => jsonResponse({detail: 'Invalid API key'}, {status: 401})) as unknown as typeof fetch;

    const ops = new PhantomOpsClient({storage, fetch: fetchImpl});
    await expect(ops.connect(API_KEY)).rejects.toThrow(/rejected/);

    expect(ops.isSignedIn()).toBe(false);
    expect(storage.map.has(PHANTOMOPS_TOKEN_STORAGE_KEY)).toBe(false);
  });

  it('restores the key across a launch and forgets garbage', () => {
    const storage = fakeStorage();
    storage.setItem(PHANTOMOPS_TOKEN_STORAGE_KEY, API_KEY);
    expect(new PhantomOpsClient({storage, fetch: (async() => jsonResponse({})) as any}).isSignedIn()).toBe(true);

    storage.setItem(PHANTOMOPS_TOKEN_STORAGE_KEY, 'not-a-key');
    expect(new PhantomOpsClient({storage, fetch: (async() => jsonResponse({})) as any}).isSignedIn()).toBe(false);
    expect(storage.map.has(PHANTOMOPS_TOKEN_STORAGE_KEY)).toBe(false);
  });

  it('clears the key and the thread on disconnect', async() => {
    const {ops, storage} = signedInClient((async() => jsonResponse({session_id: 3, messages: []})) as any);
    await ops.loadHistory();
    expect(ops.state.sessionId).toBe(3);

    await ops.logout();

    expect(ops.isSignedIn()).toBe(false);
    expect(ops.state.messages).toEqual([]);
    expect(storage.map.has(PHANTOMOPS_TOKEN_STORAGE_KEY)).toBe(false);
  });
});

describe('PhantomOpsClient — turns', () => {
  it('streams a turn into the transcript, keyed to the adopted session', async() => {
    const calls: {url: string; body?: any}[] = [];
    const fetchImpl = (async(url: string, init: RequestInit) => {
      calls.push({url: String(url), body: init?.body ? JSON.parse(init.body as string) : undefined});
      if(String(url).endsWith('/api/chat/history')) return jsonResponse({session_id: 11, messages: []});
      return jsonResponse(null, {
        stream: streamFrom([
          '{"status":"thinking"}\n',
          '{"status":"streaming","content":"Hel"}\n',
          '{"status":"streaming","content":"lo"}\n',
          '{"status":"complete","response":"Hello there"}\n'
        ])
      });
    }) as unknown as typeof fetch;

    const {ops} = signedInClient(fetchImpl);
    await ops.loadHistory();
    await ops.send('hi');

    expect(ops.state.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Hello there']
    ]);
    expect(ops.state.busy).toBe(false);
    expect(ops.state.activity).toBe(null);
    expect(calls.at(-1)!.body).toMatchObject({content: 'hi', session_id: 11});
  });

  it('surfaces a server error instead of throwing', async() => {
    const {ops} = signedInClient((async() => jsonResponse({detail: 'Phantom is busy'}, {status: 503})) as any);

    await ops.send('hi');

    expect(ops.state.error).toBe('Phantom is busy');
    expect(ops.state.busy).toBe(false);
  });

  it('signs out when the server says the key is gone', async() => {
    const {ops} = signedInClient((async() => jsonResponse({detail: 'nope'}, {status: 401})) as any);

    await ops.send('hi');

    expect(ops.isSignedIn()).toBe(false);
    expect(ops.state.messages).toEqual([]);
  });

  it('does not send while a turn is already running', async() => {
    let calls = 0;
    const {ops} = signedInClient((async() => {
      calls++;
      return jsonResponse(null, {stream: streamFrom(['{"status":"complete","response":"x"}\n'])});
    }) as any);
    ops.state = {...ops.state, busy: true};

    await ops.send('hi');
    expect(calls).toBe(0);
  });

  it('ignores an empty draft', async() => {
    const {ops} = signedInClient((async() => jsonResponse({})) as any);
    await ops.send('   ');
    expect(ops.state.messages).toEqual([]);
  });

  const confirmGate = {gateId: 'g1', kind: 'confirm' as const, tool: 'deploy', name: '', summary: '', rationale: ''};

  it('answers a confirmation gate through /api/chat/confirm', async() => {
    const calls: {url: string; body?: string}[] = [];
    const {ops} = signedInClient((async(url: string, init: RequestInit) => {
      calls.push({url: String(url), body: init?.body as string});
      return jsonResponse({status: 'ok'});
    }) as any);
    ops.state = {...ops.state, gate: {...confirmGate}};

    await ops.confirmGate('deny');

    expect(ops.state.gate).toBe(null);
    expect(calls[0].url).toContain('/api/chat/confirm');
    expect(JSON.parse(calls[0].body!)).toEqual({gate_id: 'g1', action: 'cancel'});
  });

  it('keeps the gate and reports it when the answer does not land', async() => {
    const {ops} = signedInClient((async() => jsonResponse({detail: 'nope'}, {status: 500})) as any);
    ops.state = {...ops.state, gate: {...confirmGate}};

    await ops.confirmGate('approve');

    // a cleared gate here is a silent dead end: no gate, no error, no resume
    expect(ops.state.gate).toEqual(confirmGate);
    expect(ops.state.error).toMatch(/500/);
  });

  it('submits a secret through /api/chat/secret and clears the gate', async() => {
    const calls: {url: string; body?: string}[] = [];
    const {ops} = signedInClient((async(url: string, init: RequestInit) => {
      calls.push({url: String(url), body: init?.body as string});
      return jsonResponse({status: 'ok'});
    }) as any);
    ops.state = {...ops.state, gate: {...confirmGate, kind: 'secret', gateId: 'g2', name: 'PLANE_API_KEY'}};

    await ops.answerSecret('  s3cret  ');

    expect(ops.state.gate).toBe(null);
    expect(calls[0].url).toContain('/api/chat/secret');
    expect(JSON.parse(calls[0].body!)).toEqual({gate_id: 'g2', action: 'submit', value: 's3cret'});
  });

  it('cancels a secret gate instead of submitting a blank value', async() => {
    const calls: {body?: string}[] = [];
    const {ops} = signedInClient((async(_url: string, init: RequestInit) => {
      calls.push({body: init?.body as string});
      return jsonResponse({status: 'ok'});
    }) as any);
    ops.state = {...ops.state, gate: {...confirmGate, kind: 'secret', gateId: 'g2'}};

    await ops.answerSecret('   ');

    expect(JSON.parse(calls[0].body!)).toEqual({gate_id: 'g2', action: 'cancel'});
    expect(ops.state.gate).toBe(null);
  });

  it('ignores a confirmation answer when the gate is a secret one', async() => {
    let calls = 0;
    const {ops} = signedInClient((async() => {
      calls++;
      return jsonResponse({});
    }) as any);
    ops.state = {...ops.state, gate: {...confirmGate, kind: 'secret', gateId: 'g2'}};

    await ops.confirmGate('approve');
    expect(calls).toBe(0);
  });
});
