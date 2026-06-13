import {describe, expect, beforeEach, afterEach, it} from 'vitest';
import 'fake-indexeddb/auto';
import {
  getSubscription, setSubscription, clearSubscription,
  getPreviewLevel, setPreviewLevel,
  getEndpointBase, setEndpointBase, DEFAULT_ENDPOINT,
  getAggregationState, setAggregationState, clearAggregationFor,
  destroy
} from '@lib/nostra/nostra-push-storage';

const SAMPLE = {
  subscriptionId: 'sub_abc',
  endpointBase: 'https://push.nostra.chat',
  pubkey: 'a'.repeat(64),
  registeredAt: 1700000000_000,
  endpoint: 'https://fcm.googleapis.com/wp/aaa',
  keys: {p256dh: 'pX', auth: 'aY'}
};

describe('nostra-push-storage', () => {
  beforeEach(async() => {
    await destroy();
    indexedDB.deleteDatabase('nostra-push');
  });
  afterEach(async() => {
    await destroy();
  });

  it('returns null subscription before set', async() => {
    expect(await getSubscription()).toBeNull();
  });

  it('round-trips a subscription record', async() => {
    await setSubscription(SAMPLE);
    expect(await getSubscription()).toEqual(SAMPLE);
  });

  it('clears the subscription', async() => {
    await setSubscription(SAMPLE);
    await clearSubscription();
    expect(await getSubscription()).toBeNull();
  });

  it('preview level defaults to A', async() => {
    expect(await getPreviewLevel()).toBe('A');
  });

  it('preview level round-trips B and C', async() => {
    await setPreviewLevel('B');
    expect(await getPreviewLevel()).toBe('B');
    await setPreviewLevel('C');
    expect(await getPreviewLevel()).toBe('C');
  });

  it('endpoint defaults to push.nostra.chat', async() => {
    expect(await getEndpointBase()).toBe(DEFAULT_ENDPOINT);
    expect(DEFAULT_ENDPOINT).toBe('https://push.nostra.chat');
  });

  it('endpoint override and reset', async() => {
    await setEndpointBase('https://custom.example.invalid');
    expect(await getEndpointBase()).toBe('https://custom.example.invalid');
    await setEndpointBase(null);
    expect(await getEndpointBase()).toBe(DEFAULT_ENDPOINT);
  });

  it('aggregation state empty by default', async() => {
    expect(await getAggregationState()).toEqual({});
  });

  it('aggregation round-trip and clearAggregationFor', async() => {
    await setAggregationState({peer1: {ts: 1, count: 2, tag: 't'}, peer2: {ts: 3, count: 4, tag: 'u'}});
    await clearAggregationFor('peer1');
    expect(await getAggregationState()).toEqual({peer2: {ts: 3, count: 4, tag: 'u'}});
  });
});
