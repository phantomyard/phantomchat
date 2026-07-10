import {describe, it, expect, beforeEach} from 'vitest';
import {registerSyncPublisher, schedulePublish, clearSyncPublishers} from '@lib/phantomchat/phantomchat-sync-triggers';

describe('phantomchat-sync-triggers', () => {
  beforeEach(() => clearSyncPublishers());

  it('is a silent no-op before any publisher is registered', () => {
    expect(() => schedulePublish('contacts')).not.toThrow();
    expect(() => schedulePublish('groups')).not.toThrow();
  });

  it('routes schedulePublish to the registered domain publisher', () => {
    let contacts = 0, groups = 0;
    registerSyncPublisher('contacts', () => contacts++);
    registerSyncPublisher('groups', () => groups++);

    schedulePublish('contacts');
    schedulePublish('contacts');
    schedulePublish('groups');

    expect(contacts).toBe(2);
    expect(groups).toBe(1);
  });

  it('swallows a throwing publisher so mutation paths never break', () => {
    registerSyncPublisher('contacts', () => { throw new Error('boom'); });
    expect(() => schedulePublish('contacts')).not.toThrow();
  });

  it('clearSyncPublishers stops further delivery (post-logout)', () => {
    let n = 0;
    registerSyncPublisher('contacts', () => n++);
    schedulePublish('contacts');
    clearSyncPublishers();
    schedulePublish('contacts');
    expect(n).toBe(1);
  });
});
