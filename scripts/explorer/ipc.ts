import {z} from 'zod';

export const PageIdSchema = z.enum(['A', 'B']);

export const AtomicActionSchema = z.discriminatedUnion('type', [
  z.object({type: z.literal('click'), page: PageIdSchema, selector: z.string()}),
  z.object({type: z.literal('fill'), page: PageIdSchema, selector: z.string(), value: z.string()}),
  z.object({type: z.literal('press'), page: PageIdSchema, key: z.string()}),
  z.object({type: z.literal('navigate'), page: PageIdSchema, url: z.string()}),
  z.object({type: z.literal('wait'), ms: z.number().int().nonnegative()}),
  z.object({type: z.literal('evaluate'), page: PageIdSchema, script: z.string()})
]);

export const ExpectationPayloadSchema = z.discriminatedUnion('type', [
  z.object({type: z.literal('element_appears'), page: PageIdSchema, selector_hint: z.string(), text_contains: z.string().optional(), timeout_ms: z.number().int().nonnegative()}),
  z.object({type: z.literal('element_disappears'), page: PageIdSchema, selector_hint: z.string(), timeout_ms: z.number().int().nonnegative()}),
  z.object({type: z.literal('text_changes'), page: PageIdSchema, selector_hint: z.string(), from: z.string().optional(), to_contains: z.string(), timeout_ms: z.number().int().nonnegative()}),
  z.object({type: z.literal('navigation_to'), page: PageIdSchema, url_pattern: z.string(), timeout_ms: z.number().int().nonnegative()}),
  z.object({type: z.literal('count_equals'), page: PageIdSchema, selector_hint: z.string(), count: z.number().int().nonnegative(), timeout_ms: z.number().int().nonnegative()}),
  z.object({type: z.literal('value_changes'), page: PageIdSchema, selector_hint: z.string(), expected: z.string(), timeout_ms: z.number().int().nonnegative()}),
  z.object({type: z.literal('bilateral_message_propagation'), from: PageIdSchema, text_contains: z.string(), timeout_ms: z.number().int().nonnegative()})
]);

export const InvariantSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  fnBody: z.string().min(1)
});

export const RequestSchema = z.discriminatedUnion('cmd', [
  z.object({id: z.string(), cmd: z.literal('capture')}),
  z.object({
    id: z.string(),
    cmd: z.literal('intent'),
    intentName: z.string(),
    params: z.record(z.unknown())
  }),
  z.object({
    id: z.string(),
    cmd: z.literal('atomic'),
    actions: z.array(AtomicActionSchema)
  }),
  z.object({
    id: z.string(),
    cmd: z.literal('verify_expectation'),
    expectation: ExpectationPayloadSchema
  }),
  z.object({
    id: z.string(),
    cmd: z.literal('run_invariant'),
    spec: InvariantSpecSchema,
    timeout_ms: z.number().int().nonnegative().default(5000)
  }),
  z.object({id: z.string(), cmd: z.literal('teardown')})
]);

export type Request = z.infer<typeof RequestSchema>;

export const ResponseSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional()
});

export type Response = z.infer<typeof ResponseSchema>;

export function encodeMessage(msg: object): string {
  return JSON.stringify(msg) + '\n';
}

export function decodeMessages(buffer: string): {messages: unknown[]; remainder: string} {
  const lines = buffer.split('\n');
  const remainder = lines.pop() ?? '';
  const messages = lines.filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
  return {messages, remainder};
}
