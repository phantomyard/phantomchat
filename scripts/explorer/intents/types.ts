import type {z} from 'zod';
import type {FuzzContext} from '../../../src/tests/fuzz/types';
import type {AtomicAction, Observation} from '../types';

export type IntentArea =
  | 'messaging' | 'profile' | 'media' | 'navigation'
  | 'settings' | 'network' | 'edge';

export interface IntentResult {
  ok: boolean;
  atomic_trace: AtomicAction[];
  observations: Observation[];
  error?: string;
}

export interface IntentDef<P = Record<string, unknown>> {
  name: string;
  area: IntentArea;
  paramsSchema: z.ZodType<P>;
  description: string;
  exec: (params: P, ctx: FuzzContext) => Promise<IntentResult>;
}
