/*
 * The phantombot host: the binary PhantomChat desktop ships in
 * resources/phantombot and spawns from its main process.
 *
 * build-host.mjs copies this file, dispatch.ts and methods.ts into a pinned
 * phantombot checkout (src/phantomchat-host/) and compiles it with
 * `bun build --compile`, so the relative imports below are phantombot's own
 * sources at that tag. It is not part of the Electron bundle.
 *
 * One binary, three roles, dispatched before anything else runs:
 *   - `__pi <args>`: the embedded Pi engine. The engine's native harness
 *     re-executes this binary (process.execPath) with `__pi`, exactly as it
 *     re-executes the phantombot CLI.
 *   - `__escort`: the escort's claude hook, same contract as the CLI.
 *   - `--version`: prints {phantombot, pi, bun} as JSON (packaging probe).
 *   - otherwise `--root <dir>`: open the engine on <dir> and serve JSON
 *     lines on stdin/stdout until stdin closes.
 */
import {EMBEDDED_PI_SUBCOMMAND, EMBEDDED_PI_VERSION, runEmbeddedPi} from '../lib/embeddedPi.ts';
import {ESCORT_SUBCOMMAND, runEscortHook} from '../lib/escort.ts';
import {createEngine} from '../engine/index.ts';
import {VERSION} from '../version.ts';
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool
} from '@earendil-works/pi-coding-agent';
import {homedir} from 'node:os';
import {createDispatcher, type HostMessage, type LocalToolName, type ToolRunner} from './dispatch.ts';

const info = {phantombot: VERSION, pi: EMBEDDED_PI_VERSION, bun: Bun.version};

if(process.argv[2] === EMBEDDED_PI_SUBCOMMAND) {
  await runEmbeddedPi(process.argv.slice(3));
} else if(process.argv[2] === ESCORT_SUBCOMMAND) {
  const stdinText = await new Response(Bun.stdin.stream()).text();
  let reason = '';
  const code = await runEscortHook(stdinText, {stderr: (s) => {
    reason += s;
  }});
  if(reason) await Bun.write(Bun.stderr, reason);
  process.exit(code);
} else if(process.argv.includes('--version')) {
  process.stdout.write(JSON.stringify(info) + '\n');
  process.exit(0);
} else {
  await serve();
}

async function serve(): Promise<void> {
  const rootFlag = process.argv.indexOf('--root');
  const root = rootFlag > 0 ? process.argv[rootFlag + 1] : undefined;
  if(!root) {
    process.stderr.write('usage: phantombot-host --root <absolute dir>\n');
    process.exit(2);
  }

  // stdout carries the protocol only, one JSON object per line. The engine
  // logs to stderr, which the app writes into its diagnostics log.
  const emit = (message: HostMessage) => {
    process.stdout.write(JSON.stringify(message) + '\n');
  };

  const engine = await createEngine({root, log: 'stderr'});
  const dispatcher = createDispatcher(engine, info, emit, piToolRunner(homedir()));
  process.stdout.write(JSON.stringify({ready: info}) + '\n');
  // Provider contacts answer as soon as the app is up, not on first page call.
  void autostartChannels(engine, dispatcher);

  const pending = new Set<Promise<void>>();
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, {stream: true});
    let newline: number;
    while((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if(!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch{
        continue;
      }
      // Requests run concurrently: a streaming turn must not block cancel.
      const task = dispatcher.handle(value).finally(() => pending.delete(task));
      pending.add(task);
    }
  }

  // stdin closed: the app quit or crashed. Stop turns, release the root.
  dispatcher.cancelAll();
  await Promise.allSettled(pending);
  await engine.close();
  process.exit(0);
}

/** Pi's own built-in tools, one at a time, with no model and no agent loop. */
function piToolRunner(cwd: string): ToolRunner {
  const factories: Record<LocalToolName, (cwd: string) => any> = {
    bash: createBashTool,
    read: createReadTool,
    write: createWriteTool,
    edit: createEditTool,
    ls: createLsTool,
    find: createFindTool,
    grep: createGrepTool
  };
  return async(tool, args, signal) => {
    const raw = await factories[tool](cwd).execute(`local-${Date.now()}`, args, signal, () => {});
    const output = Array.isArray(raw?.content) ?
      raw.content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('') :
      '';
    // bash reports its exit code in structuredContent; truncation in either.
    const structured = raw?.structuredContent;
    const truncated = !!(structured?.truncated || raw?.details?.truncation?.truncated);
    return {
      status: raw?.isError ? 'error' : 'ok',
      output,
      ...(typeof structured?.exit_code === 'number' ? {exit: structured.exit_code} : {}),
      ...(truncated ? {truncated: true} : {})
    };
  };
}

/** Start every persona whose channel is set up (an allowlist exists). */
async function autostartChannels(
  engine: Awaited<ReturnType<typeof createEngine>>,
  dispatcher: ReturnType<typeof createDispatcher>
): Promise<void> {
  let names: string[];
  try {
    names = await engine.personas.list();
  } catch(err) {
    process.stderr.write(JSON.stringify({level: 'warn', msg: 'autostart: list failed', error: String(err)}) + '\n');
    return;
  }
  for(const name of names) {
    try {
      const persona = engine.persona(name);
      const chat = await persona.phantomchat.info();
      if(!chat.configured || chat.allowedNpubs.length === 0) continue;
      await dispatcher.handle({id: -1, method: 'persona.phantomchat.start', params: {persona: name}});
    } catch(err) {
      process.stderr.write(JSON.stringify({level: 'warn', msg: 'autostart failed', persona: name, error: String(err)}) + '\n');
    }
  }
}
