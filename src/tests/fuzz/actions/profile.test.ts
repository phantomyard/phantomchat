// @ts-nocheck
// @vitest-environment node
import {describe, it, expect} from 'vitest';
import {editNameAction, editBioAction, uploadAvatarAction, setNip05Action} from './profile';

// fast-check sample helper — deterministic at seed 42 across Node versions.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fc = require('fast-check');

describe('editName action spec', () => {
  it('has stable name + positive weight', () => {
    expect(editNameAction.name).toBe('editName');
    expect(editNameAction.weight).toBeGreaterThan(0);
  });

  it('generateArgs yields {user, newName}', () => {
    const samples = fc.sample(editNameAction.generateArgs(), {numRuns: 10, seed: 42});
    for(const s of samples) {
      expect(['userA', 'userB']).toContain(s.user);
      expect(typeof s.newName).toBe('string');
      expect(s.newName.length).toBeGreaterThan(0);
    }
  });

  it('drive marks skipped when tab cannot be opened', async () => {
    const mockPage = {
      evaluate: async () => false,
      waitForTimeout: async () => {},
      locator: () => ({first: () => ({waitFor: async () => { throw new Error('no'); }, click: async () => {}})}),
      keyboard: {press: async () => {}}
    };
    const ctx: any = {
      users: {userA: {page: mockPage, id: 'userA'}, userB: {page: mockPage, id: 'userB'}},
      relay: {},
      snapshots: new Map(),
      actionIndex: 0
    };
    const res = await editNameAction.drive(ctx, {name: 'editName', args: {user: 'userA', newName: 'Alice-xyz'}});
    expect(res.skipped).toBe(true);
  });
});

describe('editBio action spec', () => {
  it('has stable name + positive weight', () => {
    expect(editBioAction.name).toBe('editBio');
    expect(editBioAction.weight).toBeGreaterThan(0);
  });

  it('generateArgs yields {user, newBio}', () => {
    const samples = fc.sample(editBioAction.generateArgs(), {numRuns: 10, seed: 42});
    for(const s of samples) {
      expect(['userA', 'userB']).toContain(s.user);
      expect(typeof s.newBio).toBe('string');
    }
  });
});

describe('uploadAvatar action spec', () => {
  it('has stable name + positive weight', () => {
    expect(uploadAvatarAction.name).toBe('uploadAvatar');
    expect(uploadAvatarAction.weight).toBeGreaterThan(0);
  });

  it('generateArgs yields {user, size}', () => {
    const samples = fc.sample(uploadAvatarAction.generateArgs(), {numRuns: 10, seed: 42});
    for(const s of samples) {
      expect(['userA', 'userB']).toContain(s.user);
      expect(typeof s.size).toBe('number');
      expect(s.size).toBeGreaterThanOrEqual(16);
      expect(s.size).toBeLessThanOrEqual(128);
    }
  });

  it('drive marks skipped when evaluate throws', async () => {
    const mockPage = {
      evaluate: async () => ({ok: false, error: 'mock failure'}),
      waitForTimeout: async () => {},
      locator: () => ({first: () => ({waitFor: async () => {}, click: async () => {}})}),
      keyboard: {press: async () => {}}
    };
    const ctx: any = {
      users: {userA: {page: mockPage}, userB: {page: mockPage}},
      relay: {},
      snapshots: new Map(),
      actionIndex: 0
    };
    const res = await uploadAvatarAction.drive(ctx, {name: 'uploadAvatar', args: {user: 'userA', size: 32}});
    expect(res.skipped).toBe(true);
  });
});

describe('setNip05 action spec', () => {
  it('has stable name + positive weight', () => {
    expect(setNip05Action.name).toBe('setNip05');
    expect(setNip05Action.weight).toBeGreaterThan(0);
  });

  it('generateArgs yields a user@domain format', () => {
    const samples = fc.sample(setNip05Action.generateArgs(), {numRuns: 20, seed: 42});
    for(const s of samples) {
      expect(['userA', 'userB']).toContain(s.user);
      expect(s.nip05).toMatch(/^[^@]+@[^@]+\.[a-z]+$/);
    }
  });
});
