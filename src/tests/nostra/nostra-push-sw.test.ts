import {describe, expect, beforeEach, afterEach, it, vi} from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('@lib/nostra/nostr-crypto', () => ({
  unwrapNip17Message: vi.fn()
}));
vi.mock('@lib/nostra/nostra-identity-sw', () => ({
  loadIdentitySW: vi.fn()
}));

const showNotification = vi.fn().mockResolvedValue(undefined);
const matchAll = vi.fn().mockResolvedValue([]);
const openWindow = vi.fn().mockResolvedValue({});

(globalThis as any).self = {
  registration: {showNotification},
  clients: {matchAll, openWindow}
};

import {onNostraPush, onNostraNotificationClick} from '@lib/serviceWorker/nostra-push';
import {
  setPreviewLevel,
  setAggregationState,
  destroy as destroyStorage
} from '@lib/nostra/nostra-push-storage';
import {unwrapNip17Message} from '@lib/nostra/nostr-crypto';
import {loadIdentitySW} from '@lib/nostra/nostra-identity-sw';

function buildEvent(payload: any): any {
  return {data: {json: () => payload}};
}

describe('nostra-push SW handler', () => {
  beforeEach(async() => {
    showNotification.mockClear();
    matchAll.mockClear();
    openWindow.mockClear();
    (unwrapNip17Message as any).mockReset();
    (loadIdentitySW as any).mockReset();
    await destroyStorage();
    indexedDB.deleteDatabase('nostra-push');
  });
  afterEach(() => destroyStorage());

  it('drops non-nostra payloads', async() => {
    await onNostraPush(buildEvent({app: 'telegram'}));
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('preview A renders generic title/body without decrypting', async() => {
    await onNostraPush(buildEvent({
      app: 'nostra-webpush-relay',
      version: 1,
      event_id: 'evt1',
      recipient_pubkey: 'r',
      nostra_event: '{}'
    }));
    expect(loadIdentitySW).not.toHaveBeenCalled();
    expect(showNotification).toHaveBeenCalledTimes(1);
    const [title, opts] = showNotification.mock.calls[0];
    expect(title).toBe('Nostra.chat');
    expect(opts.body).toBe('New message');
    expect(opts.tag).toBe('nostra-evt1');
  });

  it('preview B decrypts and renders sender + truncated content', async() => {
    await setPreviewLevel('B');
    (loadIdentitySW as any).mockResolvedValue({publicKey: 'p', privateKey: '00'.repeat(32)});
    (unwrapNip17Message as any).mockReturnValue({
      pubkey: 'sender_pk',
      content: 'Hello world from preview B test'
    });
    await onNostraPush(buildEvent({
      app: 'nostra-webpush-relay',
      version: 1,
      event_id: 'evt2',
      recipient_pubkey: 'r',
      nostra_event: '{}'
    }));
    expect(showNotification).toHaveBeenCalledTimes(1);
    const [title, opts] = showNotification.mock.calls[0];
    expect(title).toMatch(/sender|sender_pk/);
    expect(opts.body).toContain('Hello world');
  });

  it('preview C decrypts but masks content', async() => {
    await setPreviewLevel('C');
    (loadIdentitySW as any).mockResolvedValue({publicKey: 'p', privateKey: '00'.repeat(32)});
    (unwrapNip17Message as any).mockReturnValue({
      pubkey: 'sender_pk',
      content: 'should not appear'
    });
    await onNostraPush(buildEvent({
      app: 'nostra-webpush-relay',
      version: 1,
      event_id: 'evt3',
      recipient_pubkey: 'r',
      nostra_event: '{}'
    }));
    const [, opts] = showNotification.mock.calls[0];
    expect(opts.body).toBe('[encrypted]');
  });

  it('aggregates 3 quick messages from same peer into one notification body', async() => {
    await setPreviewLevel('B');
    (loadIdentitySW as any).mockResolvedValue({publicKey: 'p', privateKey: '00'.repeat(32)});
    (unwrapNip17Message as any).mockReturnValue({pubkey: 'same_peer', content: 'msg'});
    await onNostraPush(buildEvent({app: 'nostra-webpush-relay', version: 1, event_id: 'e1', recipient_pubkey: 'r', nostra_event: '{}'}));
    await onNostraPush(buildEvent({app: 'nostra-webpush-relay', version: 1, event_id: 'e2', recipient_pubkey: 'r', nostra_event: '{}'}));
    await onNostraPush(buildEvent({app: 'nostra-webpush-relay', version: 1, event_id: 'e3', recipient_pubkey: 'r', nostra_event: '{}'}));
    expect(showNotification).toHaveBeenCalledTimes(3);
    const [, opts3] = showNotification.mock.calls[2];
    expect(opts3.body).toMatch(/3 new messages/);
    expect(opts3.tag).toBe('nostra-same_peer');
  });

  it('does not aggregate after window expires (state forced > 5min ago)', async() => {
    await setPreviewLevel('A');
    await setAggregationState({'evt99': {ts: Date.now() - 6 * 60 * 1000, count: 5, tag: 'nostra-evt99'}});
    await onNostraPush(buildEvent({app: 'nostra-webpush-relay', version: 1, event_id: 'evt99', recipient_pubkey: 'r', nostra_event: '{}'}));
    const [, opts] = showNotification.mock.calls[0];
    expect(opts.body).toBe('New message');
  });

  it('preview B falls back to generic when identity is missing', async() => {
    await setPreviewLevel('B');
    (loadIdentitySW as any).mockResolvedValue(null);
    await onNostraPush(buildEvent({
      app: 'nostra-webpush-relay',
      version: 1,
      event_id: 'evt4',
      recipient_pubkey: 'r',
      nostra_event: '{}'
    }));
    const [title, opts] = showNotification.mock.calls[0];
    expect(title).toBe('Nostra.chat');
    expect(opts.body).toBe('New message');
  });

  it('click handler closes notification and calls openWindow when no client open', async() => {
    matchAll.mockResolvedValueOnce([]);
    const close = vi.fn();
    const event = {
      notification: {data: {app: 'nostra', peerKey: 'pk', eventId: 'eid'}, close},
      waitUntil: () => { /* noop */ }
    } as any;
    await onNostraNotificationClick(event);
    expect(close).toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledWith(expect.stringContaining('?p=pk&m=eid'));
  });
});
