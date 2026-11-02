import {existsSync, mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {getPublicKey} from 'nostr-tools/pure';
import {ExternalAiStore, nextName, toView} from './externalAiStore';

const OWNER = 'a'.repeat(64);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'external-ai-store-'));
});
afterEach(() => {
  rmSync(dir, {recursive: true, force: true});
});

describe('nextName', () => {
  it('counts External AI, External AI 2, and reuses a free number', () => {
    expect(nextName([])).toBe('External AI');
    expect(nextName(['External AI'])).toBe('External AI 2');
    expect(nextName(['External AI', 'External AI 2'])).toBe('External AI 3');
    expect(nextName(['External AI 2'])).toBe('External AI');
  });
});

describe('ExternalAiStore', () => {
  it('gives each contact its own valid keypair, and reloads them', () => {
    const store = new ExternalAiStore(dir);
    const a = store.create(OWNER, 1);
    const b = store.create(OWNER, 2);
    expect(a.pubkey).not.toBe(b.pubkey);
    expect(getPublicKey(Uint8Array.from(Buffer.from(a.secretKey, 'hex')))).toBe(a.pubkey);
    expect(b.name).toBe('External AI 2');
    expect(new ExternalAiStore(dir).list().map((r) => r.pubkey)).toEqual([a.pubkey, b.pubkey]);
  });

  it('keeps the identity file private', () => {
    if(process.platform === 'win32') return;
    const a = new ExternalAiStore(dir).create(OWNER, 1);
    expect(statSync(join(dir, a.pubkey, 'identity.json')).mode & 0o077).toBe(0);
  });

  it('never gives the secret key to the renderer view', () => {
    const a = new ExternalAiStore(dir).create(OWNER, 1);
    const view = toView(a);
    expect(view).not.toHaveProperty('secretKey');
    expect(JSON.stringify(view)).not.toContain(a.secretKey);
  });

  it('applies changes and keeps them', () => {
    const store = new ExternalAiStore(dir);
    const a = store.create(OWNER, 1);
    store.update(a.pubkey, {name: 'Helper', model: 'openai/x', effort: 'high'});
    expect(new ExternalAiStore(dir).get(a.pubkey)).toMatchObject({name: 'Helper', model: 'openai/x', effort: 'high'});
    expect(readFileSync(join(dir, a.pubkey, 'identity.json'), 'utf8')).toContain('Helper');
  });

  it('keeps one owner\'s contacts from another', () => {
    const store = new ExternalAiStore(dir);
    store.create(OWNER, 1);
    expect(store.list('b'.repeat(64))).toEqual([]);
    expect(store.list(OWNER)).toHaveLength(1);
  });

  it('remembers the automatic first contact across restarts', () => {
    const store = new ExternalAiStore(dir);
    expect(store.autoCreated(OWNER)).toBe(false);
    store.markAutoCreated(OWNER);
    expect(new ExternalAiStore(dir).autoCreated(OWNER)).toBe(true);
  });

  it('destroy removes the nsec from disk', () => {
    const store = new ExternalAiStore(dir);
    const a = store.create(OWNER, 1);
    expect(store.destroy(a.pubkey)).toBe(true);
    expect(existsSync(join(dir, a.pubkey))).toBe(false);
    expect(new ExternalAiStore(dir).get(a.pubkey)).toBeUndefined();
  });

  it('refuses a path as a pubkey', () => {
    const store = new ExternalAiStore(dir);
    expect(store.destroy('../..')).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });
});
