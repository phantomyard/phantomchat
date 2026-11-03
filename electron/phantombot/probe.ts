/*
 * `--phantombot-probe`: the packaging check the release jobs run against the
 * real packaged app. It starts the bundled host on a throwaway root and drives
 * the engine through the same client the app uses: version info, a persona, a
 * vault write and read-back, a memory search. No model is called, so it needs
 * no key and no network.
 */
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PhantombotHostClient} from './client';

export async function runPhantombotProbe(binary: string, out: (line: string) => void = (l) => process.stdout.write(l + '\n')): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), 'phantomchat-phantombot-probe-'));
  const client = new PhantombotHostClient({binary, root, log: (line) => process.stderr.write(line + '\n')});
  try {
    const steps: Array<[string, Record<string, unknown>, (value: unknown) => boolean]> = [
      ['info', {}, (v: any) => typeof v?.phantombot === 'string' && typeof v?.pi === 'string'],
      ['personas.create', {persona: 'probe', options: {identity: 'packaging probe'}}, () => true],
      ['persona.secrets.set', {persona: 'probe', name: 'PROBE_SECRET', value: 'probe'}, () => true],
      ['persona.secrets.has', {persona: 'probe', name: 'PROBE_SECRET'}, (v) => v === true],
      ['persona.memory.search', {persona: 'probe', query: 'probe'}, (v) => Array.isArray(v)]
    ];
    for(const [method, params, ok] of steps) {
      const result = await client.call(method as any, params);
      if(!result.ok || !ok(result.value)) {
        out(`phantombot probe failed at ${method}: ${JSON.stringify(result)}`);
        return 1;
      }
      if(method === 'info') out(`phantombot ${JSON.stringify(result.value)}`);
    }
    out('phantombot probe ok');
    return 0;
  } finally {
    await client.shutdown();
    try {
      rmSync(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
    } catch{ /* a late Windows handle must not turn a pass into a fail */ }
  }
}
