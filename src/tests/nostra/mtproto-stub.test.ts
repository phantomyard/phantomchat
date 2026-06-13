import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';

// ---- api-manager-stub MTProto rejection tests ----

describe('api-manager-stub MTProto rejection', () => {
  let installApiManagerStub: typeof import('@lib/nostra/api-manager-stub').installApiManagerStub;
  let uninstallApiManagerStub: typeof import('@lib/nostra/api-manager-stub').uninstallApiManagerStub;
  let fakeInvokeApi: ReturnType<typeof vi.fn>;
  let stubbedInvokeApi: (...args: any[]) => Promise<any>;

  beforeEach(async() => {
    // Reset module registry for clean state
    vi.resetModules();

    fakeInvokeApi = vi.fn().mockResolvedValue({});

    // Mock @environment/ctx to provide a fake apiManager
    vi.doMock('@environment/ctx', () => ({
      default: {
        apiManager: {
          invokeApi: fakeInvokeApi,
          getBaseDcId: () => 2
        }
      }
    }));

    // Mock nostra-bridge
    vi.doMock('@lib/nostra/nostra-bridge', () => ({
      NostraBridge: {
        getInstance: () => ({
          reverseLookup: vi.fn().mockImplementation(async(userId: number) => {
            if(userId === 1000) return 'abc123pubkey';
            return null;
          }),
          deriveAvatarFromPubkeySync: vi.fn().mockReturnValue('avatar-hash')
        })
      }
    }));

    // Set up a fake ChatAPI on window for P2P routing
    (window as any).__nostraChatAPI = {
      getHistory: vi.fn().mockReturnValue([])
    };

    // Import the module and install the stub explicitly
    const mod = await import('@lib/nostra/api-manager-stub');
    installApiManagerStub = mod.installApiManagerStub;
    uninstallApiManagerStub = mod.uninstallApiManagerStub;
    installApiManagerStub();

    const ctx = (await import('@environment/ctx')).default as any;
    stubbedInvokeApi = ctx.apiManager.invokeApi.bind(ctx.apiManager);
  });

  afterEach(() => {
    delete (window as any).__nostraChatAPI;
    vi.restoreAllMocks();
  });

  it('routes messages.getHistory for P2P peer through Nostra.chat bridge', async() => {
    const result = await stubbedInvokeApi('messages.getHistory', {
      peer: {_: 'inputPeerUser', user_id: 1000}
    });
    expect(result).toMatchObject({
      _: 'messages.messages',
      messages: expect.any(Array),
      users: expect.any(Array),
      chats: []
    });
  });

  it('routes users.getFullUser for P2P peer through Nostra.chat bridge', async() => {
    const result = await stubbedInvokeApi('users.getFullUser', {
      id: {_: 'inputUser', user_id: 1000}
    });
    expect(result).toMatchObject({
      users: expect.arrayContaining([
        expect.objectContaining({_: 'user', id: 1000})
      ])
    });
  });

  it('returns differenceEmpty for updates.getDifference', async() => {
    const result = await stubbedInvokeApi('updates.getDifference', {});
    expect(result).toMatchObject({
      _: 'updates.differenceEmpty'
    });
  });

  it('rejects auth.sendCode with MTPROTO_DISABLED', async() => {
    await expect(stubbedInvokeApi('auth.sendCode', {}))
      .rejects.toMatchObject({
        type: 'MTPROTO_DISABLED',
        code: 503
      });
  });

  it('rejects messages.sendMessage with MTPROTO_DISABLED (no longer falls through)', async() => {
    await expect(stubbedInvokeApi('messages.sendMessage', {}))
      .rejects.toMatchObject({
        type: 'MTPROTO_DISABLED'
      });
  });
});

// ---- NetworkerFactory stub tests ----

describe('NetworkerFactory stub', () => {
  let NetworkerFactory: typeof import('@appManagers/networkerFactory').NetworkerFactory;

  beforeEach(async() => {
    vi.resetModules();
    const mod = await import('@appManagers/networkerFactory');
    NetworkerFactory = mod.NetworkerFactory;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getNetworker() throws Error containing MTProto disabled', () => {
    const factory = new NetworkerFactory();
    expect(() => factory.getNetworker({} as any)).toThrow('MTProto disabled');
  });

  it('startAll() is a no-op (does not throw)', () => {
    const factory = new NetworkerFactory();
    expect(factory.startAll()).toBeUndefined();
  });

  it('stopAll() is a no-op (does not throw)', () => {
    const factory = new NetworkerFactory();
    expect(factory.stopAll()).toBeUndefined();
  });

  it('forceReconnect() is a no-op (does not throw)', () => {
    const factory = new NetworkerFactory();
    expect(factory.forceReconnect()).toBeUndefined();
  });

  it('forceReconnectTimeout() is a no-op (does not throw)', () => {
    const factory = new NetworkerFactory();
    expect(factory.forceReconnectTimeout()).toBeUndefined();
  });
});

// ---- Defense-in-depth guards ----

describe('defense-in-depth: authorizer and transport guards', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('authorizer.auth() throws with MTPROTO_DISABLED', async() => {
    vi.resetModules();
    const mod = await import('@lib/mtproto/authorizer');
    const authorizer = new mod.Authorizer({
      timeManager: {} as any,
      dcConfigurator: {} as any
    });
    expect(() => authorizer.auth(2 as any, false)).toThrow(/MTProto disabled/i);
  });

  it('transport controller pingTransports rejects with MTPROTO_DISABLED', async() => {
    vi.resetModules();
    const mod = await import('@lib/mtproto/transports/controller');
    const controller = mod.default;
    await expect(controller.pingTransports())
      .rejects.toThrow(/MTProto disabled/i);
  });
});
