/*
 * Regression guard for the critical probe → event dispatch hook.
 *
 * `runProbeIfDue()` is the ONLY production code path that dispatches
 * `update_available_signed`. If it silently stops dispatching (e.g. wrong
 * event name, wrong dispatcher method, broken throttle, missing await),
 * the consent popup never appears for any user post-deploy — the exact
 * symptom we were unable to confirm against real prod on v0.18.1.
 *
 * The listener → popup half is covered by e2e-update-popup.ts. These
 * tests lock down the dispatch half at vitest speed.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';

const PROBE_THROTTLE_MS = 12 * 60 * 60 * 1000;
const LAST_PROBE_KEY = 'nostra.update.lastProbe';
const SNOOZE_VERSION_KEY = 'nostra.update.snoozedVersion';
const SNOOZE_UNTIL_KEY = 'nostra.update.snoozedUntil';

const probeMock = vi.fn();
const getActiveVersionMock = vi.fn();
const getBakedPubkeyMock = vi.fn();

vi.mock('@lib/update/probe', () => ({probe: (pubkey: string, activeVersion?: string): unknown => probeMock(pubkey, activeVersion)}));
vi.mock('@lib/serviceWorker/shell-cache', () => ({
  getActiveVersion: () => getActiveVersionMock()
}));
vi.mock('@lib/update/signing/trusted-keys', () => ({
  getBakedPubkey: () => getBakedPubkeyMock()
}));
vi.mock('@lib/update/update-flow', () => ({
  startUpdateSigned: vi.fn()
}));

import rootScope from '@lib/rootScope';
import {runProbeIfDue} from '@lib/update/update-popup-controller';

describe('runProbeIfDue — dispatch wiring', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dispatchSpy: any;

  beforeEach(() => {
    localStorage.clear();
    probeMock.mockReset();
    getActiveVersionMock.mockReset();
    getBakedPubkeyMock.mockReset();
    // Spy on dispatchEventSingle — the main-thread-only variant. Using
    // dispatchEvent here would forward via MTProtoMessagePort which has no
    // listener on the Worker side for this event (wasted) AND throws in
    // vitest where the port is never initialized.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dispatchSpy = vi.spyOn(rootScope as any, 'dispatchEventSingle').mockImplementation((): void => undefined);
    getActiveVersionMock.mockResolvedValue({version: '0.18.0', installedPubkey: 'test-pub-b64', keyFingerprint: 'ed25519:test', at: 0});
    getBakedPubkeyMock.mockReturnValue('baked-pub-b64');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches update_available_signed when probe returns update-available', async() => {
    probeMock.mockResolvedValue({
      outcome: 'update-available',
      manifest: {version: '0.99.0', gitSha: 'abc', changelog: 'note'},
      signature: 'sig-b64',
      manifestText: '{"version":"0.99.0"}'
    });

    await runProbeIfDue(true);

    const call = dispatchSpy.mock.calls.find((c: unknown[]) => c[0] === 'update_available_signed');
    expect(call, 'update_available_signed must be dispatched').toBeTruthy();
    expect(call![1]).toMatchObject({
      manifest: expect.objectContaining({version: '0.99.0'}),
      signature: 'sig-b64',
      manifestText: '{"version":"0.99.0"}'
    });
  });

  it('does NOT dispatch update_available_signed when probe returns up-to-date', async() => {
    probeMock.mockResolvedValue({outcome: 'up-to-date', manifest: {version: '0.18.0'}});

    await runProbeIfDue(true);

    const call = dispatchSpy.mock.calls.find((c: unknown[]) => c[0] === 'update_available_signed');
    expect(call).toBeUndefined();
  });

  it('does NOT dispatch when version is snoozed', async() => {
    localStorage.setItem(SNOOZE_VERSION_KEY, '0.99.0');
    localStorage.setItem(SNOOZE_UNTIL_KEY, String(Date.now() + 60_000));
    probeMock.mockResolvedValue({
      outcome: 'update-available',
      manifest: {version: '0.99.0'},
      signature: 's',
      manifestText: '{}'
    });

    await runProbeIfDue(true);

    const call = dispatchSpy.mock.calls.find((c: unknown[]) => c[0] === 'update_available_signed');
    expect(call).toBeUndefined();
  });

  it('skips probe when called without force within throttle window', async() => {
    localStorage.setItem(LAST_PROBE_KEY, String(Date.now() - 60_000));

    await runProbeIfDue();

    expect(probeMock).not.toHaveBeenCalled();
  });

  it('runs probe when throttle window has elapsed', async() => {
    localStorage.setItem(LAST_PROBE_KEY, String(Date.now() - PROBE_THROTTLE_MS - 1000));
    probeMock.mockResolvedValue({outcome: 'up-to-date', manifest: {version: '0.18.0'}});

    await runProbeIfDue();

    expect(probeMock).toHaveBeenCalledTimes(1);
  });

  it('prefers active.installedPubkey over baked pubkey when calling probe', async() => {
    probeMock.mockResolvedValue({outcome: 'up-to-date', manifest: {version: '0.18.0'}});

    await runProbeIfDue(true);

    expect(probeMock).toHaveBeenCalledWith('test-pub-b64', '0.18.0');
  });

  it('falls back to baked pubkey when active has no installedPubkey', async() => {
    getActiveVersionMock.mockResolvedValue({version: '0.18.0', keyFingerprint: 'ed25519:baked', at: 0});
    probeMock.mockResolvedValue({outcome: 'up-to-date', manifest: {version: '0.18.0'}});

    await runProbeIfDue(true);

    expect(probeMock).toHaveBeenCalledWith('baked-pub-b64', '0.18.0');
  });

  it('skips probe silently when no trusted pubkey is available', async() => {
    getActiveVersionMock.mockResolvedValue(null);
    getBakedPubkeyMock.mockReturnValue('');

    await runProbeIfDue(true);

    expect(probeMock).not.toHaveBeenCalled();
  });
});
