import {describe, it, expect} from 'vitest';
import {createUpdateState} from '@lib/update/update-state';

describe('update-state', () => {
  it('starts in idle', () => {
    const s = createUpdateState();
    expect(s.status()).toBe('idle');
  });

  it('transitions idle → checking → update-available', () => {
    const s = createUpdateState();
    s.beginCheck();
    expect(s.status()).toBe('checking');
    s.setUpdateAvailable({version: '0.13.0'} as any, 'sig');
    expect(s.status()).toBe('update-available');
    expect(s.pendingManifest()?.version).toBe('0.13.0');
  });

  it('rejects invalid transitions', () => {
    const s = createUpdateState();
    expect(() => s.beginDownload()).toThrow();
  });

  it('transitions accepted → downloading → verifying → swapping → done', () => {
    const s = createUpdateState();
    s.beginCheck();
    s.setUpdateAvailable({version: '0.13.0'} as any, 'sig');
    s.accept();
    s.beginDownload();
    expect(s.status()).toBe('downloading');
    s.beginVerifying();
    expect(s.status()).toBe('verifying');
    s.beginSwap();
    expect(s.status()).toBe('swapping');
    s.setDone();
    expect(s.status()).toBe('done');
  });

  it('transitions to failed from any active state', () => {
    const s = createUpdateState();
    s.beginCheck();
    s.setFailed('network');
    expect(s.status()).toBe('failed');
    expect(s.lastError()).toBe('network');
  });
});
