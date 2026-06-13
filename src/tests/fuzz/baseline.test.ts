import {describe, it, expect} from 'vitest';
import {replayFile} from './replay';
import {writeFileSync, mkdirSync, existsSync, rmSync} from 'fs';
import {join} from 'path';

describe('baseline emit/replay round-trip', () => {
  const tmpDir = '/tmp/fuzz-baseline-test';
  const tmpFile = join(tmpDir, 'baseline-seed99.json');

  it('writes and reads back an action list', async() => {
    if(!existsSync(tmpDir)) mkdirSync(tmpDir, {recursive: true});
    const baseline = {
      seed: 99,
      backend: 'local',
      maxCommands: 5,
      commands: [
        {name: 'sendText', args: {from: 'userA', text: 'hi'}},
        {name: 'waitForPropagation', args: {ms: 500}}
      ],
      emittedAt: new Date().toISOString(),
      fuzzerVersion: 'phase2a'
    };
    writeFileSync(tmpFile, JSON.stringify(baseline, null, 2));
    const read = await replayFile(tmpFile);
    expect(read).toEqual(baseline.commands);
    rmSync(tmpDir, {recursive: true, force: true});
  });

  it('rejects files without a commands array', async() => {
    if(!existsSync(tmpDir)) mkdirSync(tmpDir, {recursive: true});
    writeFileSync(tmpFile, JSON.stringify({seed: 99, nothing: 'here'}));
    await expect(replayFile(tmpFile)).rejects.toThrow(/commands array/);
    rmSync(tmpDir, {recursive: true, force: true});
  });
});
