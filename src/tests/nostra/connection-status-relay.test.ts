/**
 * Tests for relay-based ConnectionStatusComponent.
 * Verifies that connection status reads from nostra_relay_state events
 * instead of MTProto connection_status_change.
 */

import '../setup';

// ─── Track registered events ──────────────────────────────────────
const registeredEvents: Map<string, Function> = new Map();

vi.mock('@lib/rootScope', () => ({
  default: {
    addEventListener: vi.fn((name: string, handler: Function) => {
      registeredEvents.set(name, handler);
    }),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    managers: {
      apiManager: {
        getBaseDcId: vi.fn().mockResolvedValue(2)
      },
      apiUpdatesManager: {
        forceGetDifference: vi.fn()
      },
      rootScope: {
        getConnectionStatus: vi.fn().mockResolvedValue({})
      },
      networkerFactory: {
        forceReconnect: vi.fn(),
        forceReconnectTimeout: vi.fn()
      }
    }
  }
}));

vi.mock('@lib/logger', () => ({
  logger: vi.fn(() => vi.fn())
}));

vi.mock('@lib/langPack', () => ({
  i18n: vi.fn((key: string) => {
    const span = document.createElement('span');
    span.textContent = key;
    return span;
  }),
  LangPackKey: {}
}));

vi.mock('@helpers/dom/cancelEvent', () => ({
  default: vi.fn()
}));

vi.mock('@helpers/dom/clickEvent', () => ({
  attachClickEvent: vi.fn()
}));

vi.mock('@lib/singleInstance', () => ({
  default: {deactivatedReason: undefined}
}));

vi.mock('@config/debug', () => ({
  default: false
}));

vi.mock('@config/app', () => ({
  default: {baseDcId: 2}
}));

vi.mock('@lib/mtproto/connectionStatus', () => ({
  ConnectionStatus: {
    Connected: 0,
    Closed: 1,
    TimedOut: 2
  }
}));

vi.mock('@components/inputSearch', () => {
  return {
    default: class MockInputSearch {
      placeholder = 'Search';
      loading = false;

      setPlaceholder(key: string) {
        this.placeholder = key;
      }

      toggleLoading(loading: boolean) {
        this.loading = loading;
      }

      isLoading() {
        return this.loading;
      }
    }
  };
});

import ConnectionStatusComponent from '@components/connectionStatus';
import InputSearch from '@components/inputSearch';
import rootScope from '@lib/rootScope';

describe('ConnectionStatusComponent relay integration', () => {
  let component: ConnectionStatusComponent;
  let inputSearch: InputSearch;
  let chatsContainer: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    registeredEvents.clear();
    vi.clearAllMocks();

    component = new ConnectionStatusComponent();
    inputSearch = new InputSearch();
    chatsContainer = document.createElement('div');

    component.construct(
      rootScope.managers as any,
      chatsContainer,
      inputSearch
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('listens to nostra_relay_state events, not connection_status_change', () => {
    expect(registeredEvents.has('nostra_relay_state')).toBe(true);
    expect(registeredEvents.has('connection_status_change')).toBe(false);
  });

  it('shows online state when at least 1 relay is connected', () => {
    const handler = registeredEvents.get('nostra_relay_state')!;
    expect(handler).toBeDefined();

    // Dispatch connected relay
    handler({url: 'wss://relay.damus.io', connected: true, latencyMs: 50, read: true, write: true});

    // Advance rAF + state timeout
    vi.advanceTimersByTime(ConnectionStatusComponent.CHANGE_STATE_DELAY + 100);

    // When online, placeholder should be 'Search' and not loading
    expect(inputSearch.isLoading()).toBe(false);
  });

  it('shows reconnecting when ALL relays report disconnected', () => {
    const handler = registeredEvents.get('nostra_relay_state')!;

    // First connect so hadConnect = true
    handler({url: 'wss://relay.damus.io', connected: true, latencyMs: 50, read: true, write: true});
    vi.advanceTimersByTime(ConnectionStatusComponent.CHANGE_STATE_DELAY + 100);

    // Now disconnect all
    handler({url: 'wss://relay.damus.io', connected: false, latencyMs: -1, read: true, write: true});

    vi.advanceTimersByTime(ConnectionStatusComponent.CHANGE_STATE_DELAY + 100);

    // Should be in connecting/loading state
    expect(inputSearch.isLoading()).toBe(true);
  });

  it('transitions from all-down to one-connected correctly', () => {
    const handler = registeredEvents.get('nostra_relay_state')!;

    // Connect first
    handler({url: 'wss://relay1.example.com', connected: true, latencyMs: 50, read: true, write: true});
    vi.advanceTimersByTime(ConnectionStatusComponent.CHANGE_STATE_DELAY + 100);

    // All relays down
    handler({url: 'wss://relay1.example.com', connected: false, latencyMs: -1, read: true, write: true});
    vi.advanceTimersByTime(ConnectionStatusComponent.CHANGE_STATE_DELAY + 100);
    expect(inputSearch.isLoading()).toBe(true);

    // One relay comes back
    handler({url: 'wss://relay1.example.com', connected: true, latencyMs: 30, read: true, write: true});
    vi.advanceTimersByTime(ConnectionStatusComponent.CHANGE_STATE_DELAY + 100);
    expect(inputSearch.isLoading()).toBe(false);
  });

  it('does NOT call forceGetDifference on any state transition', () => {
    const handler = registeredEvents.get('nostra_relay_state')!;

    // Simulate connect
    handler({url: 'wss://relay.damus.io', connected: true, latencyMs: 50, read: true, write: true});
    vi.advanceTimersByTime(ConnectionStatusComponent.CHANGE_STATE_DELAY + 100);

    // Simulate disconnect then reconnect
    handler({url: 'wss://relay.damus.io', connected: false, latencyMs: -1, read: true, write: true});
    vi.advanceTimersByTime(ConnectionStatusComponent.CHANGE_STATE_DELAY + 100);

    handler({url: 'wss://relay.damus.io', connected: true, latencyMs: 30, read: true, write: true});
    vi.advanceTimersByTime(ConnectionStatusComponent.CHANGE_STATE_DELAY + 100);

    expect(rootScope.managers.apiUpdatesManager.forceGetDifference).not.toHaveBeenCalled();
  });

  it('does NOT call getBaseDcId', () => {
    const handler = registeredEvents.get('nostra_relay_state')!;

    handler({url: 'wss://relay.damus.io', connected: true, latencyMs: 50, read: true, write: true});
    vi.advanceTimersByTime(ConnectionStatusComponent.CHANGE_STATE_DELAY + 100);

    expect(rootScope.managers.apiManager.getBaseDcId).not.toHaveBeenCalled();
  });

  it('handles multiple relays where some are down but at least one is connected', () => {
    const handler = registeredEvents.get('nostra_relay_state')!;

    // Two relays, one connected, one not
    handler({url: 'wss://relay1.example.com', connected: true, latencyMs: 50, read: true, write: true});
    handler({url: 'wss://relay2.example.com', connected: false, latencyMs: -1, read: true, write: true});

    vi.advanceTimersByTime(ConnectionStatusComponent.CHANGE_STATE_DELAY + 100);

    // Should be online (at least 1 connected)
    expect(inputSearch.isLoading()).toBe(false);
  });
});
