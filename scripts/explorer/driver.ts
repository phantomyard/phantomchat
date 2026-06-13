import {createServer, type Socket} from 'node:net';
import {unlinkSync, existsSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {bootHarness} from '../../src/tests/fuzz/harness';
import type {FuzzContext} from '../../src/tests/fuzz/types';
import {decodeMessages, encodeMessage, RequestSchema, type Request, type Response} from './ipc';
import {registry} from './intents/registry';
import {checkHard} from './oracles/hard';
import {verifyExpectation, type Expectation, type Pages} from './oracles/expectations';
import {compileInvariant, runInvariant, type SandboxContext, type InvariantSpec} from './oracles/invariants';

interface DriverState {
  ctx: FuzzContext;
  teardown: () => Promise<void>;
}

async function main() {
  const socketArg = process.argv.find((a) => a.startsWith('--socket='));
  if(!socketArg) {
    console.error('[driver] --socket=<path> is required');
    process.exit(2);
  }
  const socketPath = socketArg.slice('--socket='.length);
  if(existsSync(socketPath)) {
    try {unlinkSync(socketPath);} catch{}
  }

  const harness = await bootHarness({headed: false});
  const state: DriverState = {ctx: harness.ctx, teardown: harness.teardown};
  console.log('[driver] READY');

  const server = createServer((socket: Socket) => handleClient(socket, state));
  server.listen(socketPath, () => {
    console.log(`[driver] listening on ${socketPath}`);
  });

  // Idle timeout: shut down if no client connects within 10 minutes.
  const idleTimer = setTimeout(async() => {
    console.error('[driver] idle timeout, shutting down');
    await state.teardown();
    server.close();
    process.exit(0);
  }, 10 * 60 * 1000);
  server.once('connection', () => clearTimeout(idleTimer));
}

async function handleClient(socket: Socket, state: DriverState) {
  let buffer = '';
  socket.on('data', async(chunk) => {
    buffer += chunk.toString('utf8');
    const {messages, remainder} = decodeMessages(buffer);
    buffer = remainder;
    for(const raw of messages) {
      const parsed = RequestSchema.safeParse(raw);
      if(!parsed.success) {
        socket.write(encodeMessage({
          id: (raw as any)?.id ?? 'unknown',
          ok: false,
          error: `invalid request: ${parsed.error.message}`
        } as Response));
        continue;
      }
      const response = await dispatch(parsed.data, state);
      socket.write(encodeMessage(response));
    }
  });
  socket.on('error', (err) => console.error('[driver] socket error:', err.message));
}

async function captureObservations(state: DriverState): Promise<Record<'A'|'B', any>> {
  const out: Record<'A'|'B', any> = {} as any;
  const dir = `/tmp/exp-capture-${process.pid}-${Date.now()}`;
  mkdirSync(dir, {recursive: true});
  for(const userId of ['userA', 'userB'] as const) {
    const u = state.ctx.users[userId];
    const pageId = userId === 'userA' ? 'A' : 'B';
    const screenshotPath = join(dir, `${pageId}.png`);
    await u.page.screenshot({path: screenshotPath, fullPage: false}).catch(() => {});
    out[pageId] = {
      page: pageId,
      url: u.page.url(),
      screenshotPath,
      consoleTail: u.consoleLog.slice(-50),
      capturedAt: Date.now()
    };
  }
  return out;
}

async function dispatch(req: Request, state: DriverState): Promise<Response> {
  switch(req.cmd) {
    case 'capture': {
      const data = await captureObservations(state);
      return {id: req.id, ok: true, data};
    }
    case 'intent': {
      const def = registry[req.intentName];
      if(!def) {
        return {id: req.id, ok: false, error: `unknown intent: ${req.intentName}`};
      }
      const parsed = def.paramsSchema.safeParse(req.params);
      if(!parsed.success) {
        return {id: req.id, ok: false, error: `invalid params: ${parsed.error.message}`};
      }
      try {
        const result = await def.exec(parsed.data, state.ctx);
        const hardFindings = checkHard({
          pageA: {consoleSinceStart: state.ctx.users.userA.consoleLog},
          pageB: {consoleSinceStart: state.ctx.users.userB.consoleLog}
        });
        return {
          id: req.id,
          ok: result.ok && hardFindings.length === 0,
          data: {...result, hard_findings: hardFindings},
          error: result.error
        };
      } catch(err: any) {
        return {id: req.id, ok: false, error: `intent threw: ${err?.message ?? String(err)}`};
      }
    }
    case 'atomic': {
      return {id: req.id, ok: false, error: 'atomic dispatch not implemented in F1'};
    }
    case 'verify_expectation': {
      try {
        const pages: Pages = {pageA: state.ctx.users.userA.page, pageB: state.ctx.users.userB.page};
        const result = await verifyExpectation(req.expectation as Expectation, pages);
        return {id: req.id, ok: result.ok, data: result};
      } catch(err: any) {
        return {id: req.id, ok: false, error: `verify_expectation threw: ${err?.message ?? String(err)}`};
      }
    }
    case 'run_invariant': {
      try {
        const compiled = compileInvariant(req.spec as InvariantSpec);
        const sandbox: SandboxContext = {pageA: state.ctx.users.userA.page, pageB: state.ctx.users.userB.page};
        const result = await runInvariant(compiled, sandbox, req.timeout_ms);
        return {id: req.id, ok: result.ok, data: result};
      } catch(err: any) {
        // compileInvariant throws on banned-pattern match — surface as ok=false with reason.
        return {id: req.id, ok: false, error: `run_invariant: ${err?.message ?? String(err)}`};
      }
    }
    case 'teardown':
      await state.teardown();
      setTimeout(() => process.exit(0), 50);
      return {id: req.id, ok: true};
  }
}

main().catch((err) => {
  console.error('[driver] fatal:', err);
  process.exit(1);
});
