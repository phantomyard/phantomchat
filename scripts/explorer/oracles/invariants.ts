import * as vm from 'node:vm';
import type {Page} from 'playwright';

export interface InvariantSpec {
  name: string;
  description: string;
  fnBody: string;
}

export interface CompiledInvariant {
  name: string;
  description: string;
  fn: (ctx: SandboxContext) => Promise<InvariantResult>;
}

export interface SandboxContext {
  pageA: Page;
  pageB: Page;
}

export interface InvariantResult {
  ok: boolean;
  value?: unknown;
  message?: string;
}

const BANNED_PATTERNS: RegExp[] = [
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\bprocess\b/,
  /\bglobal\b/,
  /\bglobalThis\b/,
  /\bnode:/,
  /\bfs\b/,
  /\bchild_process\b/,
  /\bnet\b/,
  /\bhttp\b/,
  /\beval\s*\(/,
  /\bFunction\s*\(/
];

export function compileInvariant(spec: InvariantSpec): CompiledInvariant {
  for(const re of BANNED_PATTERNS) {
    if(re.test(spec.fnBody)) {
      throw new Error(`Invariant ${spec.name}: body contains banned pattern ${re.source}`);
    }
  }
  const wrapped = `(async function(ctx) {\n${spec.fnBody}\n})`;
  const script = new vm.Script(wrapped, {filename: `invariant-${spec.name}.js`});
  return {
    name: spec.name,
    description: spec.description,
    fn: async(ctx: SandboxContext) => {
      const sandbox: Record<string, unknown> = {ctx};
      const fn = script.runInNewContext(sandbox, {timeout: 1000}) as (c: SandboxContext) => Promise<InvariantResult>;
      return fn(ctx);
    }
  };
}

export async function runInvariant(
  inv: CompiledInvariant,
  ctx: SandboxContext,
  timeoutMs: number
): Promise<InvariantResult> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<InvariantResult>((resolve) => {
    timer = setTimeout(() => resolve({ok: false, message: `invariant ${inv.name} timeout after ${timeoutMs}ms`}), timeoutMs);
  });
  try {
    const result = await Promise.race([
      inv.fn(ctx),
      timeoutPromise
    ]);
    return result;
  } catch(err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {ok: false, message: `invariant ${inv.name} threw: ${msg}`};
  } finally {
    if(timer) clearTimeout(timer);
  }
}
