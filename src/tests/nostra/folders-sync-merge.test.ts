import {describe, it, expect} from 'vitest';
import {decideMerge} from '@lib/nostra/folders-sync-merge';

describe('decideMerge', () => {
  it('no-remote + custom folders → publish-local', () => {
    const d = decideMerge({
      remoteCreatedAt: null,
      localPublishedAt: 0,
      localModifiedAt: 0,
      hasLocalCustomFolders: true
    });
    expect(d.action).toBe('publish-local');
    expect(d.showToast).toBe(false);
  });

  it('no-remote + no custom folders → no-op', () => {
    const d = decideMerge({
      remoteCreatedAt: null,
      localPublishedAt: 0,
      localModifiedAt: 0,
      hasLocalCustomFolders: false
    });
    expect(d.action).toBe('no-op');
  });

  it('remote newer than local-modified, no offline edits → remote-wins clean', () => {
    const d = decideMerge({
      remoteCreatedAt: 200,
      localPublishedAt: 100,
      localModifiedAt: 100,
      hasLocalCustomFolders: true
    });
    expect(d.action).toBe('remote-wins');
    expect(d.showToast).toBe(false);
  });

  it('remote newer AND unpublished local edits older than remote → remote-wins + toast', () => {
    const d = decideMerge({
      remoteCreatedAt: 300,
      localPublishedAt: 100,
      localModifiedAt: 200,
      hasLocalCustomFolders: true
    });
    expect(d.action).toBe('remote-wins');
    expect(d.showToast).toBe(true);
  });

  it('local-modified newer than remote → local-wins', () => {
    const d = decideMerge({
      remoteCreatedAt: 100,
      localPublishedAt: 100,
      localModifiedAt: 200,
      hasLocalCustomFolders: true
    });
    expect(d.action).toBe('local-wins');
  });

  it('remote == local-published → in-sync', () => {
    const d = decideMerge({
      remoteCreatedAt: 100,
      localPublishedAt: 100,
      localModifiedAt: 50,
      hasLocalCustomFolders: true
    });
    expect(d.action).toBe('in-sync');
  });
});
