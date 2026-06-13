import {PrivacyTransport, RuntimeState} from '@lib/nostra/privacy-transport';

export type TorUiState = 'active' | 'bootstrap' | 'direct' | 'error' | 'disabled';

export function normalizeRuntimeState(raw: RuntimeState | undefined): TorUiState {
  switch(raw) {
    case 'tor-active': return 'active';
    case 'direct-active': return 'direct';
    case 'booting': return 'bootstrap';
    default: return 'error';
  }
}

export function computeTorUiState(): TorUiState {
  if(PrivacyTransport.readMode() === 'off') return 'disabled';
  const transport = (typeof window !== 'undefined') ?
    (window as any).__nostraPrivacyTransport : undefined;
  const raw = transport?.getRuntimeState?.() as RuntimeState | undefined;
  return normalizeRuntimeState(raw);
}

export const TOR_UI_COLORS: Record<TorUiState, string> = {
  active: '#4caf50',
  bootstrap: '#f44336',
  direct: '#ff9800',
  error: '#f44336',
  disabled: '#9e9e9e'
};
