/**
 * Boot path validation: ensures no MTProto connections during app startup.
 *
 * This test validates the defense-in-depth layers that prevent Telegram
 * server connections:
 * 1. NetworkerFactory.getNetworker() throws
 * 2. api-manager-stub rejects non-intercepted methods with MTPROTO_DISABLED
 * 3. authorizer.auth() throws before handshake
 * 4. transport controller throws before creating connections
 * 5. index.ts does not call randomlyChooseVersionFromSearch()
 */

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';

// ---- Layer 1: NetworkerFactory stub ----

describe('boot path: NetworkerFactory layer', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getNetworker() throws Error with MTProto disabled message', async() => {
    const {NetworkerFactory} = await import('@appManagers/networkerFactory');
    const factory = new NetworkerFactory();
    expect(() => factory.getNetworker({} as any)).toThrow('[Nostra.chat] MTProto disabled');
  });

  it('startAll() is a silent no-op', async() => {
    const {NetworkerFactory} = await import('@appManagers/networkerFactory');
    const factory = new NetworkerFactory();
    expect(() => factory.startAll()).not.toThrow();
  });

  it('forceReconnect() is a silent no-op', async() => {
    const {NetworkerFactory} = await import('@appManagers/networkerFactory');
    const factory = new NetworkerFactory();
    expect(() => factory.forceReconnect()).not.toThrow();
  });

  it('forceReconnectTimeout() is a silent no-op', async() => {
    const {NetworkerFactory} = await import('@appManagers/networkerFactory');
    const factory = new NetworkerFactory();
    expect(() => factory.forceReconnectTimeout()).not.toThrow();
  });
});

// ---- Layer 2: api-manager-stub MTPROTO_DISABLED rejection ----

describe('boot path: api-manager-stub layer', () => {
  let stubbedInvokeApi: (...args: any[]) => Promise<any>;

  beforeEach(async() => {
    vi.resetModules();

    const fakeInvokeApi = vi.fn().mockResolvedValue({});

    vi.doMock('@environment/ctx', () => ({
      default: {
        apiManager: {
          invokeApi: fakeInvokeApi,
          getBaseDcId: () => 2
        }
      }
    }));

    vi.doMock('@lib/nostra/nostra-bridge', () => ({
      NostraBridge: {
        getInstance: () => ({
          reverseLookup: vi.fn().mockRejectedValue(new Error('not found')),
          deriveAvatarFromPubkeySync: vi.fn().mockReturnValue('avatar-hash')
        })
      }
    }));

    const stubModule = await import('@lib/nostra/api-manager-stub');
    stubModule.installApiManagerStub();

    const ctx = (await import('@environment/ctx')).default as any;
    stubbedInvokeApi = ctx.apiManager.invokeApi.bind(ctx.apiManager);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns synthetic state for updates.getState (no MTProto call)', async() => {
    const result = await stubbedInvokeApi('updates.getState', {});
    expect(result._).toBe('updates.state');
    expect(result.pts).toBe(1);
  });

  it('returns empty difference for updates.getDifference (no MTProto call)', async() => {
    const result = await stubbedInvokeApi('updates.getDifference', {});
    expect(result._).toBe('updates.differenceEmpty');
  });

  it('rejects auth.sendCode with MTPROTO_DISABLED', async() => {
    await expect(stubbedInvokeApi('auth.sendCode', {}))
      .rejects.toMatchObject({type: 'MTPROTO_DISABLED', code: 503});
  });

  it('rejects help.getConfig with MTPROTO_DISABLED', async() => {
    await expect(stubbedInvokeApi('help.getConfig', {}))
      .rejects.toMatchObject({type: 'MTPROTO_DISABLED', code: 503});
  });

  it('rejection includes method name in description for unknown methods', async() => {
    await expect(stubbedInvokeApi('phone.getCallConfig', {}))
      .rejects.toMatchObject({
        type: 'MTPROTO_DISABLED',
        description: expect.stringContaining('phone.getCallConfig')
      });
  });
});

// ---- Layer 3: Authorizer defense-in-depth ----

describe('boot path: authorizer defense-in-depth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('auth() throws before initiating MTProto handshake', async() => {
    vi.resetModules();
    const mod = await import('@lib/mtproto/authorizer');
    const authorizer = new mod.Authorizer({
      timeManager: {} as any,
      dcConfigurator: {} as any
    });
    expect(() => authorizer.auth(2 as any, false)).toThrow(/MTProto disabled/i);
  });
});

// ---- Layer 4: Transport controller defense-in-depth ----

describe('boot path: transport controller defense-in-depth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pingTransports() throws before creating connections', async() => {
    vi.resetModules();
    const mod = await import('@lib/mtproto/transports/controller');
    const controller = mod.default;
    await expect(controller.pingTransports())
      .rejects.toThrow(/MTProto disabled/i);
  });
});

// ---- Layer 5: index.ts boot path guards ----

describe('boot path: index.ts guards', () => {
  let indexSource: string;

  beforeAll(async() => {
    const fs = await import('fs');
    const path = await import('path');
    const indexPath = path.resolve(process.cwd(), 'src/index.ts');
    indexSource = fs.readFileSync(indexPath, 'utf-8');
  });

  it('randomlyChooseVersionFromSearch is commented out in index.ts', () => {
    // The call should be commented out
    const lines = indexSource.split('\n');
    const callLine = lines.find((l: string) => l.includes('randomlyChooseVersionFromSearch()') && !l.trimStart().startsWith('function'));
    expect(callLine).toBeDefined();
    expect(callLine!.trimStart().startsWith('//')).toBe(true);
  });

  it('getPremium() call has .catch(noop) to suppress MTPROTO_DISABLED rejection', () => {
    const premiumIdx = indexSource.indexOf('getPremium()');
    expect(premiumIdx).toBeGreaterThan(-1);

    const catchAfterPremium = indexSource.slice(premiumIdx, premiumIdx + 200);
    expect(catchAfterPremium).toContain('.catch(noop)');
  });
});
