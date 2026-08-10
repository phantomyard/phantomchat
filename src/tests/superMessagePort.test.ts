// @ts-nocheck
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import SuperMessagePort from '@lib/superMessagePort';

/**
 * Unit tests for SuperMessagePort's invoke backstop:
 *  - the blanket per-port timeout (defaultInvokeTimeout) and its exemptions,
 *  - the timer being cleared when the invoke settles normally,
 *  - the visibilitychange wake-recovery that rejects stale in-flight invokes.
 *
 * In test mode SuperMessagePort.postMessage is a no-op, so an invoke never
 * receives a reply on its own — exactly what we want to exercise the wedge
 * paths. Replies are simulated via the exposed resolveLatest() helper.
 */

class TestPort extends SuperMessagePort<any, any, true> {
  constructor(defaultTimeout: number, exempt: string[] = []) {
    super('TEST');
    this.defaultInvokeTimeout = defaultTimeout;
    this.invokeTimeoutExempt = new Set(exempt);
  }

  public awaitingIds() {
    return Object.keys(this.awaiting);
  }

  // Simulate the counterpart's result for the most recently created invoke.
  public resolveLatest(result: any) {
    const ids = this.awaitingIds();
    const id = ids[ids.length - 1];
    this.processResultTask({type: 'result', payload: {taskId: Number(id), result}} as any);
  }

  public triggerWake() {
    this.onVisibilityChange();
  }
}

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', {value: state, configurable: true});
};

describe('SuperMessagePort invoke backstop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects a wedged invoke with TIMEOUT after the blanket timeout', async() => {
    const port = new TestPort(60000);
    const rejection = vi.fn();
    port.invoke('manager', {}).catch(rejection);

    await vi.advanceTimersByTimeAsync(59999);
    expect(rejection).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(rejection).toHaveBeenCalledTimes(1);
    expect(rejection.mock.calls[0][0]).toMatchObject({type: 'TIMEOUT'});
    expect(port.awaitingIds()).toHaveLength(0);
  });

  it('clears the timer when the invoke settles normally', async() => {
    const port = new TestPort(60000);
    const resolved = vi.fn();
    const rejected = vi.fn();
    port.invoke('manager', {}).then(resolved, rejected);

    port.resolveLatest('ok');
    await Promise.resolve();
    expect(resolved).toHaveBeenCalledWith('ok');

    // Advancing well past the timeout must not fire a late rejection.
    await vi.advanceTimersByTimeAsync(120000);
    expect(rejected).not.toHaveBeenCalled();
  });

  it('does not time out an exempt invoke type', async() => {
    const port = new TestPort(60000, ['phantomchatBridge']);
    const rejected = vi.fn();
    port.invoke('phantomchatBridge', {}).catch(rejected);

    await vi.advanceTimersByTimeAsync(300000);
    expect(rejected).not.toHaveBeenCalled();
    expect(port.awaitingIds()).toHaveLength(1);
  });

  it('lets an explicit timeout override the blanket default', async() => {
    const port = new TestPort(60000);
    const rejected = vi.fn();
    port.invoke('manager', {}, undefined, undefined, undefined, 1000).catch(rejected);

    await vi.advanceTimersByTimeAsync(1001);
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(rejected.mock.calls[0][0]).toMatchObject({type: 'TIMEOUT'});
  });

  it('does not apply a blanket timeout when defaultInvokeTimeout is 0', async() => {
    const port = new TestPort(0);
    const rejected = vi.fn();
    port.invoke('manager', {}).catch(rejected);

    await vi.advanceTimersByTimeAsync(300000);
    expect(rejected).not.toHaveBeenCalled();
    expect(port.awaitingIds()).toHaveLength(1);
  });

  describe('wake recovery', () => {
    it('rejects stale invokes but spares young ones on wake', async() => {
      const port = new TestPort(60000);
      const staleReject = vi.fn();
      port.invoke('manager', {}).catch(staleReject);

      // Age the first invoke past the staleness threshold (but under 60s).
      await vi.advanceTimersByTimeAsync(11000);

      const youngResolve = vi.fn();
      const youngReject = vi.fn();
      port.invoke('manager', {}).then(youngResolve, youngReject);

      setVisibility('visible');
      port.triggerWake();
      await Promise.resolve();

      expect(staleReject).toHaveBeenCalledTimes(1);
      expect(staleReject.mock.calls[0][0]).toMatchObject({type: 'TAB_SUSPENDED'});
      expect(youngReject).not.toHaveBeenCalled();
      expect(port.awaitingIds()).toHaveLength(1); // only the young invoke remains
    });

    it('spares exempt invoke types on wake even when stale', async() => {
      const port = new TestPort(60000, ['phantomchatBridge']);
      const rejected = vi.fn();
      port.invoke('phantomchatBridge', {}).catch(rejected);

      await vi.advanceTimersByTimeAsync(11000);
      setVisibility('visible');
      port.triggerWake();
      await Promise.resolve();

      expect(rejected).not.toHaveBeenCalled();
      expect(port.awaitingIds()).toHaveLength(1);
    });

    it('does nothing while the tab is still hidden', async() => {
      const port = new TestPort(60000);
      const rejected = vi.fn();
      port.invoke('manager', {}).catch(rejected);

      await vi.advanceTimersByTimeAsync(11000);
      setVisibility('hidden');
      port.triggerWake();
      await Promise.resolve();

      expect(rejected).not.toHaveBeenCalled();
    });

    it('is inert on ports without a blanket timeout', async() => {
      const port = new TestPort(0);
      const rejected = vi.fn();
      port.invoke('manager', {}).catch(rejected);

      await vi.advanceTimersByTimeAsync(11000);
      setVisibility('visible');
      port.triggerWake();
      await Promise.resolve();

      expect(rejected).not.toHaveBeenCalled();
    });
  });
});
