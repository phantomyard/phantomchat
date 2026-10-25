// @vitest-environment node
import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync('public/channel-switcher.js', 'utf8');
function shell(href = 'https://chat.test/index.html?account=2&swfix=1&pc_cb=2#peer', accept = true, storage = new Map<string, string>()) {
  const url = new URL(href);
  const assigned: string[] = [], replaced: string[] = [];
  let prompts = 0;
  const window = {} as {phantomchatChannels: {current: string; choose(value: string): boolean}};
  runInNewContext(source, {
    window, URL,
    location: {href, pathname: url.pathname, search: url.search, hash: url.hash, assign: (value: string) => assigned.push(value), replace: (value: string) => replaced.push(value)},
    localStorage: {getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value)},
    document: {querySelector: () => null},
    confirm: () => { prompts++; return accept; }
  });
  return {api: window.phantomchatChannels, assigned, replaced, storage, prompts: () => prompts};
}
describe('application channel shell', () => {
  it('preserves account/deep link and clears only recovery flags', () => {
    const s = shell();
    expect(s.api.current).toBe('stable');
    expect(s.api.choose('preview')).toBe(true);
    expect(s.assigned).toEqual(['https://chat.test/preview/index.html?account=2&channel=preview#peer']);
    expect(s.prompts()).toBe(1);
  });
  it('cancels Preview without navigation or preference mutation', () => {
    const s = shell(undefined, false);
    expect(s.api.choose('preview')).toBe(false);
    expect(s.assigned).toEqual([]);
    expect(s.storage.size).toBe(0);
    expect(s.api.current).toBe('stable');
  });
  it('returns from Preview without prompting; ignores current/invalid choices', () => {
    const s = shell('https://chat.test/preview/index.html?account=1#peer');
    expect(s.api.choose('preview')).toBe(true);
    expect(s.api.choose('invalid')).toBe(false);
    expect(s.assigned).toEqual([]);
    expect(s.api.choose('stable')).toBe(true);
    expect(s.assigned).toEqual(['https://chat.test/index.html?account=1&channel=stable#peer']);
    expect(s.prompts()).toBe(0);
  });
  it('remembers Preview launches but explicit Stable overrides it', () => {
    const storage = new Map([['phantomchat-release-channel', 'preview']]);
    expect(shell('https://chat.test/?account=1#peer', true, storage).replaced).toEqual(['/preview/index.html?account=1#peer']);
    expect(shell('https://chat.test/index.html?channel=stable', true, storage).api.current).toBe('stable');
    expect(storage.get('phantomchat-release-channel')).toBe('stable');
  });
});
