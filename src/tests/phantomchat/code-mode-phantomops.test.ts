/**
 * Code Mode ↔ PhantomOps client.
 *
 * The protocol is newline-delimited JSON over `/api/chat/message`, and the
 * token arrives through a `postMessage` hand-off from a login popup. Both of
 * those are easy to get subtly wrong and impossible to notice in a browser
 * until a phantom answers in the wrong place, so they are pinned here with a
 * fake fetch, a fake window and a fake sessionStorage — no network, no DOM.
 */
import {describe, it, expect} from 'vitest';
import PhantomOpsClient, {
  PHANTOMOPS_BASE_URL,
  PHANTOMOPS_PWA_ORIGIN,
  PHANTOMOPS_TOKEN_MESSAGE,
  PHANTOMOPS_TOKEN_STORAGE_KEY,
  applyPhantomOpsEvent,
  isPhantomOpsTokenMessage,
  phantomOpsConnectUrl,
  phantomOpsRequestOrigin,
  readPhantomOpsEvents,
  type PhantomOpsState
} from '@lib/phantomchat/code-mode-phantomops';

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
    const events = await collect(['{"status":"thinking"}\n{"status":"working","description":"Reading"}\n']);
    expect(events.map((e) => e.status)).toEqual(['thinking', 'working']);
  });

  it('reassembles a line split across chunks', async() => {
    const events = await collect(['{"status":"stre', 'aming","content":"hel', 'lo"}\n']);
    expect(events).toEqual([{status: 'streaming', content: 'hello'}]);
  });

  it('flushes a trailing line with no newline', async() => {
    const events = await collect(['{"status":"complete","response":"done"}']);
    expect(events).toEqual([{status: 'complete', response: 'done'}]);
  });

  it('skips malformed lines instead of killing the stream', async() => {
    const events = await collect([
      'not json\n',
      '{"no_status":true}\n',
      '{"status":"thinking"}\n'
    ]);
    expect(events).toEqual([{status: 'thinking'}]);
  });

  it('ignores blank keepalive lines', async() => {
    const events = await collect(['\n\n{"status":"thinking"}\n\n']);
    expect(events).toEqual([{status: 'thinking'}]);
  });
});

describe('phantomOpsRequestOrigin', () => {
  it('lets an http(s) page declare itself', () => {
    expect(phantomOpsRequestOrigin('https://phantomchat.app')).toBe('https://phantomchat.app');
    expect(phantomOpsRequestOrigin('http://localhost:8080')).toBe('http://localhost:8080');
  });

  it('maps the packaged desktop scheme to the PWA origin it stands for', () => {
    // phantomops refuses a non-http(s) origin outright, and the claim is only
    // ever used for the tenant site policy (which it re-checks per request).
    expect(phantomOpsRequestOrigin('app://localhost')).toBe(PHANTOMOPS_PWA_ORIGIN);
    expect(phantomOpsRequestOrigin('')).toBe(PHANTOMOPS_PWA_ORIGIN);
    expect(phantomOpsRequestOrigin(undefined)).toBe(PHANTOMOPS_PWA_ORIGIN);
  });
});

describe('phantomOpsConnectUrl', () => {
  it('points at the widget connect page with the encoded origin', () => {
    expect(phantomOpsConnectUrl(PHANTOMOPS_BASE_URL, 'https://phantomchat.app'))
    .toBe(`${PHANTOMOPS_BASE_URL}/widget/connect?origin=https%3A%2F%2Fphantomchat.app`);
  });

  it('tolerates a trailing slash on the base url', () => {
    expect(phantomOpsConnectUrl(`${PHANTOMOPS_BASE_URL}/`, 'https://phantomchat.app'))
    .toContain('/widget/connect?origin=');
  });
});

describe('isPhantomOpsTokenMessage', () => {
  const base = 'https://phantomops.app';
  const page = 'https://phantomchat.app';
  const tokenMessage = {type: PHANTOMOPS_TOKEN_MESSAGE, token: 'jwt', expiresIn: 3600, origin: page};

  it('accepts the genuine hand-off', () => {
    expect(isPhantomOpsTokenMessage(tokenMessage, base, base, page)).toBe(true);
  });

  it('rejects a message from any other origin', () => {
    expect(isPhantomOpsTokenMessage(tokenMessage, 'https://evil.example', base, page)).toBe(false);
  });

  it('rejects another message type', () => {
    expect(isPhantomOpsTokenMessage({...tokenMessage, type: 'other'}, base, base, page)).toBe(false);
  });

  it('rejects an empty or missing token', () => {
    expect(isPhantomOpsTokenMessage({...tokenMessage, token: ''}, base, base, page)).toBe(false);
    expect(isPhantomOpsTokenMessage({type: PHANTOMOPS_TOKEN_MESSAGE}, base, base, page)).toBe(false);
    expect(isPhantomOpsTokenMessage(null, base, base, page)).toBe(false);
  });

  it('rejects a token minted for a different origin', () => {
    expect(isPhantomOpsTokenMessage({...tokenMessage, origin: 'https://someone-else.example'}, base, base, page))
    .toBe(false);
  });

  it('accepts the PWA origin on the packaged desktop build', () => {
    // The popup mints for the declared origin, which on app:// is the PWA one.
    const declaration = {type: PHANTOMOPS_TOKEN_MESSAGE, token: 'jwt', origin: PHANTOMOPS_PWA_ORIGIN};
    expect(isPhantomOpsTokenMessage(declaration, base, base, 'app://localhost')).toBe(true);
  });
});

describe('applyPhantomOpsEvent', () => {
  const base: PhantomOpsState = {
    signedIn: true,
    busy: false,
    activity: null,
    error: null,
    messages: [],
    gate: null,
    sessionId: null
  };

  it('records the pinned session id', () => {
    expect(applyPhantomOpsEvent(base, {status: 'session_open', session_id: 42}).sessionId).toBe(42);
    expect(applyPhantomOpsEvent(base, {status: 'session_open', session_id: '42'}).sessionId).toBe(null);
  });

  it('surfaces a tool gate so the user can approve or deny it', () => {
    const next = applyPhantomOpsEvent(base, {
      status: 'confirmation_required',
      gate_id: 'g1',
      tool: 'deploy',
      args_summary: 'deploy live',
      rationale: 'because'
    });
    expect(next.gate).toEqual({gateId: 'g1', tool: 'deploy', summary: 'deploy live', rationale: 'because'});
  });

  it('shows work-in-progress activity and clears it when a tool finishes', () => {
    const working = applyPhantomOpsEvent(base, {status: 'working', description: 'Running tests'});
    expect(working.activity).toBe('Running tests');
    expect(applyPhantomOpsEvent(working, {status: 'tool_complete'}).activity).toBe('Thinking…');
  });

  it('ignores unknown statuses without touching state', () => {
    expect(applyPhantomOpsEvent(base, {status: 'host_context_held'})).toBe(base);
    expect(applyPhantomOpsEvent(base, {status: 'something_new'})).toBe(base);
  });
});

interface FakeWindow {
  location: {origin: string};
  open: (url: string, target: string, features: string) => any;
  addEventListener: (type: string, listener: (e: any) => void) => void;
  removeEventListener: (type: string, listener: (e: any) => void) => void;
}

const fakeWindow = (origin = 'https://phantomchat.app') => {
  const listeners = new Set<(e: any) => void>();
  const wins: {url?: string; closed: boolean} = {closed: false};
  const win: FakeWindow = {
    location: {origin},
    open(url) {
      wins.url = url;
      return wins as any;
    },
    addEventListener(type, listener) {
      if(type === 'message') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if(type === 'message') listeners.delete(listener);
    }
  };

  return {
    win,
    popup: wins,
    emit(data: any, messageOrigin = 'https://phantomops.app') {
      for(const listener of listeners) listener({data, origin: messageOrigin});
    },
    listeners
  };
};

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

describe('PhantomOpsClient', () => {
  it('resolves login from the popup hand-off and pins the token in sessionStorage', async() => {
    const {win, emit} = fakeWindow();
    const storage = fakeStorage();
    const requests: string[] = [];
    const fetchImpl = (async(url: string) => {
      requests.push(String(url));
      if(String(url).endsWith('/api/widget/session')) return jsonResponse({session_id: 7});
      return jsonResponse(null, {status: 404});
    }) as unknown as typeof fetch;

    const ops = new PhantomOpsClient({window: win as any, storage, fetch: fetchImpl});
    const login = ops.login();

    emit({type: PHANTOMOPS_TOKEN_MESSAGE, token: 'jwt-1', expiresIn: 3600, origin: 'https://phantomchat.app'});
    await login;

    expect(ops.isSignedIn()).toBe(true);
    expect(storage.map.get(PHANTOMOPS_TOKEN_STORAGE_KEY)).toContain('jwt-1');
    // It also opens this site's chat, so history is scoped from the first turn.
    expect(requests.some((r) => r.endsWith('/api/widget/session'))).toBe(true);
  });

  it('ignores a token posted for another origin', async() => {
    const {win, emit} = fakeWindow();
    const ops = new PhantomOpsClient({window: win as any, storage: null, fetch: (async() => jsonResponse({})) as any});
    const login = ops.login();

    emit({type: PHANTOMOPS_TOKEN_MESSAGE, token: 'jwt', origin: 'https://evil.example'});
    expect(ops.isSignedIn()).toBe(false);

    emit({type: PHANTOMOPS_TOKEN_MESSAGE, token: 'jwt', origin: 'https://phantomchat.app'});
    await login;
    expect(ops.isSignedIn()).toBe(true);
  });

  it('reports a blocked popup instead of hanging', async() => {
    const {win} = fakeWindow();
    (win as any).open = (..._args: any[]): null => null;
    const ops = new PhantomOpsClient({window: win as any, storage: null, fetch: (async() => jsonResponse({})) as any});

    await expect(ops.login()).rejects.toThrow(/blocked/);
    expect(ops.state.error).toMatch(/blocked/);
  });

  it('reports a closed popup instead of hanging', async() => {
    const {win, popup} = fakeWindow();
    const ops = new PhantomOpsClient({
      window: win as any,
      storage: null,
      fetch: (async() => jsonResponse({})) as any,
      popupPollMs: 1
    });

    const login = ops.login();
    popup.closed = true;
    await expect(login).rejects.toThrow(/closed/);
  });

  it('restores a still-valid token but drops an expired one', () => {
    const storage = fakeStorage();
    const later = Date.now() + 3_600_000;
    storage.setItem(PHANTOMOPS_TOKEN_STORAGE_KEY, JSON.stringify({token: 'jwt', exp: later, session: 9}));

    const fresh = new PhantomOpsClient({window: fakeWindow().win as any, storage, fetch: (async() => jsonResponse({})) as any});
    expect(fresh.isSignedIn()).toBe(true);
    expect(fresh.state.sessionId).toBe(9);

    storage.setItem(PHANTOMOPS_TOKEN_STORAGE_KEY, JSON.stringify({token: 'jwt', exp: Date.now() - 1}));
    const stale = new PhantomOpsClient({window: fakeWindow().win as any, storage, fetch: (async() => jsonResponse({})) as any});
    expect(stale.isSignedIn()).toBe(false);
    expect(storage.map.has(PHANTOMOPS_TOKEN_STORAGE_KEY)).toBe(false);
  });

  it('streams a turn into the transcript', async() => {
    const {win} = fakeWindow();
    const storage = fakeStorage();
    const fetchImpl = (async(url: string) => {
      if(String(url).endsWith('/api/chat/message')) {
        return jsonResponse(null, {
          stream: streamFrom([
            '{"status":"thinking"}\n',
            '{"status":"streaming","content":"Hel"}\n',
            '{"status":"streaming","content":"lo"}\n',
            '{"status":"complete","response":"Hello there"}\n'
          ])
        });
      }
      return jsonResponse(null, {status: 404});
    }) as unknown as typeof fetch;

    const ops = new PhantomOpsClient({window: win as any, storage, fetch: fetchImpl});
    // Signed in: reuse the login path so the token is real for the call.
    (ops as any).token = 'jwt';
    (ops as any).expiresAt = Date.now() + 3_600_000;

    await ops.send('hi');

    expect(ops.state.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Hello there']
    ]);
    expect(ops.state.busy).toBe(false);
    expect(ops.state.activity).toBe(null);
  });

  it('surfaces a server error instead of throwing', async() => {
    const {win} = fakeWindow();
    const fetchImpl = (async() => jsonResponse({detail: 'Phantom is busy'}, {status: 503})) as unknown as typeof fetch;

    const ops = new PhantomOpsClient({window: win as any, storage: null, fetch: fetchImpl});
    (ops as any).token = 'jwt';
    (ops as any).expiresAt = Date.now() + 3_600_000;

    await ops.send('hi');

    expect(ops.state.error).toBe('Phantom is busy');
    expect(ops.state.busy).toBe(false);
  });

  it('signs out when the server says the token is gone', async() => {
    const {win} = fakeWindow();
    const fetchImpl = (async() => jsonResponse({detail: 'nope'}, {status: 401})) as unknown as typeof fetch;

    const ops = new PhantomOpsClient({window: win as any, storage: null, fetch: fetchImpl});
    (ops as any).token = 'jwt';
    (ops as any).expiresAt = Date.now() + 3_600_000;
    ops.state = {...ops.state, signedIn: true};

    await ops.send('hi');

    expect(ops.isSignedIn()).toBe(false);
    expect(ops.state.messages).toEqual([]);
  });

  it('does not send while a turn is already running', async() => {
    const {win} = fakeWindow();
    let calls = 0;
    const fetchImpl = (async() => {
      calls++;
      return jsonResponse(null, {stream: streamFrom(['{"status":"complete","response":"x"}\n'])});
    }) as unknown as typeof fetch;

    const ops = new PhantomOpsClient({window: win as any, storage: null, fetch: fetchImpl});
    (ops as any).token = 'jwt';
    (ops as any).expiresAt = Date.now() + 3_600_000;
    ops.state = {...ops.state, busy: true};

    await ops.send('hi');
    expect(calls).toBe(0);
  });

  it('ignores an empty draft', async() => {
    const {win} = fakeWindow();
    const ops = new PhantomOpsClient({window: win as any, storage: null, fetch: (async() => jsonResponse({})) as any});
    (ops as any).token = 'jwt';
    (ops as any).expiresAt = Date.now() + 3_600_000;

    await ops.send('   ');
    expect(ops.state.messages).toEqual([]);
  });

  it('answers a gate through /api/chat/confirm', async() => {
    const {win} = fakeWindow();
    const calls: {url: string; body?: string}[] = [];
    const fetchImpl = (async(url: string, init: RequestInit) => {
      calls.push({url: String(url), body: init?.body as string});
      return jsonResponse({ok: true});
    }) as unknown as typeof fetch;

    const ops = new PhantomOpsClient({window: win as any, storage: null, fetch: fetchImpl});
    (ops as any).token = 'jwt';
    (ops as any).expiresAt = Date.now() + 3_600_000;
    ops.state = {...ops.state, gate: {gateId: 'g1', tool: 'deploy', summary: '', rationale: ''}};

    await ops.confirmGate('deny');

    expect(ops.state.gate).toBe(null);
    expect(calls[0].url).toContain('/api/chat/confirm');
    expect(JSON.parse(calls[0].body!)).toEqual({gate_id: 'g1', action: 'deny'});
  });
});
