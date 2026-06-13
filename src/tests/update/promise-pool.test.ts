import {describe, it, expect} from 'vitest';
import {PromisePool} from '@lib/update/promise-pool';

describe('PromisePool', () => {
  it('runs tasks with bounded concurrency', async() => {
    const pool = new PromisePool(2);
    let concurrent = 0;
    let maxConcurrent = 0;
    const task = async() => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 10));
      concurrent--;
    };
    await Promise.all(Array.from({length: 10}, () => pool.run(task)));
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('propagates rejection', async() => {
    const pool = new PromisePool(2);
    await expect(pool.run(async() => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});
