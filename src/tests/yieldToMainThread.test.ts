import {afterEach, describe, expect, test} from 'vitest';
import yieldToMainThread from '@helpers/schedulers/yieldToMainThread';

describe('yieldToMainThread', () => {
  const originalMessageChannel = globalThis.MessageChannel;

  afterEach(() => {
    globalThis.MessageChannel = originalMessageChannel;
  });

  test('resolves', async() => {
    await expect(yieldToMainThread()).resolves.toBeUndefined();
  });

  test('yields a real macro-task — pending microtasks run first', async() => {
    const order: string[] = [];
    Promise.resolve().then(() => order.push('microtask'));
    await yieldToMainThread();
    order.push('after-yield');
    // A macro-task drains the microtask queue before it runs, so the microtask
    // must have landed first. (A microtask-based yield would race here.)
    expect(order).toEqual(['microtask', 'after-yield']);
  });

  test('falls back to setTimeout when MessageChannel is unavailable', async() => {
    // @ts-ignore — simulate an environment without MessageChannel
    delete globalThis.MessageChannel;
    await expect(yieldToMainThread()).resolves.toBeUndefined();
  });
});
