import {describe, it, expect, beforeEach} from 'vitest';
import {getFlowState, setFlowState, resetFlowState} from '@lib/update/update-state-machine';

const manifest = {
  schemaVersion: 1, version: '0.8.0', gitSha: 'x', published: 'x',
  swUrl: './sw.js', bundleHashes: {'./sw.js': 'sha256-x'}, changelog: ''
};

describe('update-state-machine', () => {
  beforeEach(() => {
    localStorage.clear();
    resetFlowState();
  });

  it('starts idle', () => {
    expect(getFlowState()).toEqual({kind: 'idle'});
  });

  it('persists available state across reload', () => {
    setFlowState({kind: 'available', manifest} as any);
    resetFlowState();  // simulate fresh module load
    expect(getFlowState()).toEqual({kind: 'available', manifest});
  });

  it('does not persist transient downloading state', () => {
    setFlowState({kind: 'downloading', target: manifest, completed: 3, total: 10} as any);
    resetFlowState();
    expect(getFlowState().kind).not.toBe('downloading');
  });

  it('persists finalizing state', () => {
    setFlowState({kind: 'finalizing', target: manifest} as any);
    resetFlowState();
    expect(getFlowState().kind).toBe('finalizing');
  });

  it('persists failed state', () => {
    setFlowState({kind: 'failed', reason: {type: 'install-timeout'}} as any);
    resetFlowState();
    expect(getFlowState().kind).toBe('failed');
  });
});
