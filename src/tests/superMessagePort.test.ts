// @ts-nocheck
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import SuperMessagePort, {describeInvoke} from '@lib/superMessagePort';

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

describe('SuperMessagePort timeout diagnostics (#246)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const managerPayload = {
    name: 'appMessagesManager',
    method: 'getHistory',
    args: [{secret: 'message body'}],
    accountNumber: 1
  };

  it('logs the manager name.method when an invoke times out', async() => {
    const port = new TestPort(60000);
    const errorSpy = vi.spyOn(port['log'], 'error').mockImplementation(() => {});
    port.invoke('manager', managerPayload).catch(() => {});
    port.invoke('manager', {name: 'appUsersManager', method: 'getSelf', args: []}, undefined, undefined, undefined, 120000).catch(() => {});

    await vi.advanceTimersByTimeAsync(60001);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = errorSpy.mock.calls[0][0];
    expect(typeof line).toBe('string');
    expect(line).toContain('invoke TIMEOUT after 60000ms');
    expect(line).toContain('manager:appMessagesManager.getHistory');
    expect(line).toContain('1 still awaiting');
  });

  it('attaches the label to the TIMEOUT error and never leaks args', async() => {
    const port = new TestPort(60000);
    const errorSpy = vi.spyOn(port['log'], 'error').mockImplementation(() => {});
    const rejection = vi.fn();
    port.invoke('manager', managerPayload).catch(rejection);

    await vi.advanceTimersByTimeAsync(60001);

    expect(rejection.mock.calls[0][0]).toMatchObject({
      type: 'TIMEOUT',
      message: 'manager:appMessagesManager.getHistory'
    });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('message body');
  });

  it('names the call when wake recovery rejects a stale invoke', async() => {
    const port = new TestPort(60000);
    const errorSpy = vi.spyOn(port['log'], 'error').mockImplementation(() => {});
    port.invoke('manager', managerPayload).catch(() => {});

    await vi.advanceTimersByTimeAsync(11000);
    setVisibility('visible');
    port.triggerWake();
    await Promise.resolve();

    expect(errorSpy.mock.calls[0][0]).toContain('manager:appMessagesManager.getHistory');
  });

  it('describeInvoke falls back to the bare type for non-manager payloads', () => {
    expect(describeInvoke('manager', managerPayload)).toBe('manager:appMessagesManager.getHistory');
    expect(describeInvoke('crypto', {method: 'sha256', args: []})).toBe('crypto:sha256');
    expect(describeInvoke('createObjectURL', new Blob())).toBe('createObjectURL');
    expect(describeInvoke('environment', undefined)).toBe('environment');
  });
});
