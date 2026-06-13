import {describe, it, expect, beforeEach} from 'vitest';
import {resetBaseline, getUpdateStateSnapshot} from '@lib/update/update-baseline';

const KEYS = [
  'nostra.update.installedVersion',
  'nostra.update.installedSwUrl',
  'nostra.update.lastAcceptedVersion',
  'nostra.update.lastIntegrityCheck',
  'nostra.update.lastIntegrityResult',
  'nostra.update.lastIntegrityDetails',
  'nostra.update.pendingFinalization',
  'nostra.update.pendingManifest'
];

describe('resetBaseline', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('removes every baseline key while leaving unrelated storage intact', () => {
    for(const k of KEYS) localStorage.setItem(k, 'X');
    localStorage.setItem('unrelated.key', 'keep-me');
    localStorage.setItem('nostra-identity', 'also-keep');

    resetBaseline();

    for(const k of KEYS) expect(localStorage.getItem(k)).toBeNull();
    expect(localStorage.getItem('unrelated.key')).toBe('keep-me');
    expect(localStorage.getItem('nostra-identity')).toBe('also-keep');
  });

  it('is idempotent — calling on empty storage is a no-op', () => {
    expect(() => resetBaseline()).not.toThrow();
    for(const k of KEYS) expect(localStorage.getItem(k)).toBeNull();
  });
});

describe('getUpdateStateSnapshot', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns all-null snapshot when storage is empty and SW API missing', async() => {
    const savedNav = (global as any).navigator;
    (global as any).navigator = {userAgent: savedNav?.userAgent || 'jsdom'};
    try {
      const snap = await getUpdateStateSnapshot();
      expect(snap.installedVersion).toBeNull();
      expect(snap.installedSwUrl).toBeNull();
      expect(snap.lastIntegrityCheck).toBeNull();
      expect(snap.lastIntegrityDetails).toBeNull();
      expect(snap.pendingFinalization).toBe(false);
      expect(snap.pendingManifest).toBeNull();
      expect(snap.activeScriptUrl).toBeNull();
      expect(snap.waitingScriptUrl).toBeNull();
    } finally {
      (global as any).navigator = savedNav;
    }
  });

  it('parses stored baseline values including JSON details and manifest', async() => {
    localStorage.setItem('nostra.update.installedVersion', '0.8.1');
    localStorage.setItem('nostra.update.installedSwUrl', 'http://x/sw-abc.js');
    localStorage.setItem('nostra.update.lastAcceptedVersion', '0.8.1');
    localStorage.setItem('nostra.update.lastIntegrityCheck', '1700000000000');
    localStorage.setItem('nostra.update.lastIntegrityResult', 'verified');
    localStorage.setItem(
      'nostra.update.lastIntegrityDetails',
      JSON.stringify([{name: 'cdn', status: 'ok', version: '0.8.1'}, {name: 'ipfs', status: 'error', error: 'timeout'}])
    );
    localStorage.setItem('nostra.update.pendingFinalization', '1');
    localStorage.setItem(
      'nostra.update.pendingManifest',
      JSON.stringify({version: '0.8.2', swUrl: './sw-new.js', extraIgnored: 'x'})
    );

    const snap = await getUpdateStateSnapshot();
    expect(snap.installedVersion).toBe('0.8.1');
    expect(snap.installedSwUrl).toBe('http://x/sw-abc.js');
    expect(snap.lastAcceptedVersion).toBe('0.8.1');
    expect(snap.lastIntegrityCheck).toBe(1700000000000);
    expect(snap.lastIntegrityResult).toBe('verified');
    expect(snap.lastIntegrityDetails).toEqual([
      {name: 'cdn', status: 'ok', version: '0.8.1'},
      {name: 'ipfs', status: 'error', error: 'timeout'}
    ]);
    expect(snap.pendingFinalization).toBe(true);
    expect(snap.pendingManifest).toEqual({version: '0.8.2', swUrl: './sw-new.js'});
  });

  it('tolerates malformed JSON in details / manifest without throwing', async() => {
    localStorage.setItem('nostra.update.lastIntegrityDetails', 'not-json');
    localStorage.setItem('nostra.update.pendingManifest', '{broken');

    const snap = await getUpdateStateSnapshot();
    expect(snap.lastIntegrityDetails).toBeNull();
    expect(snap.pendingManifest).toBeNull();
  });

  it('reads activeScriptURL and waitingScriptURL from registration when present', async() => {
    const savedNav = (global as any).navigator;
    (global as any).navigator = {
      userAgent: savedNav?.userAgent || 'jsdom',
      serviceWorker: {
        getRegistration: async() => ({
          active: {scriptURL: 'http://x/sw-A.js'},
          waiting: {scriptURL: 'http://x/sw-B.js'}
        })
      }
    };
    try {
      const snap = await getUpdateStateSnapshot();
      expect(snap.activeScriptUrl).toBe('http://x/sw-A.js');
      expect(snap.waitingScriptUrl).toBe('http://x/sw-B.js');
    } finally {
      (global as any).navigator = savedNav;
    }
  });
});
