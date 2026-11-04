import {describe, expect, it} from 'vitest';
import {allowOnLocalPersona, atLeast, findPhantombot, listLocalPersonas, parseVersion, phantombotCandidates, type Runner} from './scan';

const ME = 'npub1' + 'q'.repeat(58);
const BOT = 'npub1' + 'p'.repeat(58);

function fakeRunner(version = '[log] 1.1.475', overrides: Record<string, {code: number; stdout?: string; stderr?: string}> = {}) {
  const calls: string[][] = [];
  const run: Runner = async(_bin, args) => {
    calls.push(args);
    const key = args.join(' ');
    if(overrides[key]) return {stdout: '', stderr: '', ...overrides[key]};
    if(key === '--version') return {code: 0, stdout: version + '\n', stderr: ''};
    if(key === 'phantomchat --list --json') {
      return {code: 0, stderr: '', stdout: JSON.stringify([
        {persona: 'robbie', npub: BOT, phantomchat: true, allowedNpubs: [ME]},
        {persona: 'lena', npub: null, phantomchat: false, allowedNpubs: []},
        {persona: '../evil', npub: BOT, phantomchat: true, allowedNpubs: []}
      ])};
    }
    if(args[0] === 'phantomchat' && args.includes('--allow')) return {code: 0, stderr: '', stdout: JSON.stringify({persona: args[2], npub: ME, added: true})};
    if(key === 'restart') return {code: 0, stdout: '', stderr: ''};
    return {code: 2, stdout: '', stderr: 'unexpected'};
  };
  return {run, calls};
}

describe('Scan: local phantombot personas', () => {
  it('looks in the installer dirs before PATH', () => {
    expect(phantombotCandidates({PATH: '/usr/bin'}, 'linux', '/home/a')[0]).toBe('/home/a/.local/bin/phantombot');
    expect(phantombotCandidates({LOCALAPPDATA: 'C:\\L', Path: ''}, 'win32', 'C:\\U')[0]).toContain('Programs');
    expect(findPhantombot(['/a', '/b'], (p) => p === '/b')).toBe('/b');
  });

  it('compares versions', () => {
    expect(parseVersion('[log] 1.1.473')).toEqual([1, 1, 473]);
    expect(atLeast([1, 1, 475], [1, 1, 475])).toBe(true);
    expect(atLeast([1, 2, 0], [1, 1, 475])).toBe(true);
    expect(atLeast([1, 1, 474], [1, 1, 475])).toBe(false);
  });

  it('refuses an older phantombot before running any phantomchat command', async() => {
    const {run, calls} = fakeRunner('[log] 1.1.473');
    const res = await listLocalPersonas('/bin/phantombot', ME, run);
    expect(res).toMatchObject({ok: false, error: {code: 'outdated'}});
    expect(calls).toEqual([['--version']]);
    const allow = await allowOnLocalPersona('/bin/phantombot', 'robbie', ME, run);
    expect(allow).toMatchObject({ok: false, error: {code: 'outdated'}});
    expect(calls.some((c) => c.includes('--allow'))).toBe(false);
  });

  it('lists personas, marks the ones already allowing me, drops bad names', async() => {
    const {run} = fakeRunner();
    const res = await listLocalPersonas('/bin/phantombot', ME, run);
    expect(res).toEqual({ok: true, value: [
      {persona: 'robbie', npub: BOT, phantomchat: true, allowed: true},
      {persona: 'lena', npub: null, phantomchat: false, allowed: false}
    ]});
    expect(await listLocalPersonas(undefined, ME, run)).toMatchObject({ok: false, error: {code: 'not_installed'}});
  });

  it('allows, restarts, and returns the persona npub', async() => {
    const {run, calls} = fakeRunner();
    const res = await allowOnLocalPersona('/bin/phantombot', 'robbie', ME, run);
    expect(res).toEqual({ok: true, value: {npub: BOT, added: true, restarted: true}});
    expect(calls).toContainEqual(['phantomchat', '--persona', 'robbie', '--allow', ME, '--json']);
    expect(calls.at(-1)).toEqual(['restart']);
  });

  it('skips the restart when already allowed, and reports a failed restart', async() => {
    const already = fakeRunner('[log] 1.1.475', {[`phantomchat --persona robbie --allow ${ME} --json`]: {code: 0, stdout: JSON.stringify({added: false})}});
    expect(await allowOnLocalPersona('/bin/p', 'robbie', ME, already.run)).toEqual({ok: true, value: {npub: BOT, added: false, restarted: false}});
    expect(already.calls).not.toContainEqual(['restart']);
    const broken = fakeRunner('[log] 1.1.475', {restart: {code: 1, stderr: 'no service installed'}});
    expect(await allowOnLocalPersona('/bin/p', 'robbie', ME, broken.run)).toEqual({ok: true, value: {npub: BOT, added: true, restarted: false, restartError: 'no service installed'}});
  });

  it('refuses a bad persona name or npub without running phantombot', async() => {
    const {run, calls} = fakeRunner();
    expect(await allowOnLocalPersona('/bin/p', '../x', ME, run)).toMatchObject({ok: false});
    expect(await allowOnLocalPersona('/bin/p', 'robbie', 'nsec1zzz', run)).toMatchObject({ok: false});
    expect(calls).toEqual([]);
  });
});
