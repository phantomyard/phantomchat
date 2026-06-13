import type {UpdateFlowState} from '@lib/update/types';

const LS_KEY = 'nostra.update.flowState';

let _state: UpdateFlowState = {kind: 'idle'};

function isPersisted(s: UpdateFlowState): boolean {
  return s.kind === 'available' || s.kind === 'finalizing' || s.kind === 'failed';
}

function loadFromStorage(): UpdateFlowState {
  const raw = localStorage.getItem(LS_KEY);
  if(!raw) return {kind: 'idle'};
  try {
    const parsed = JSON.parse(raw) as UpdateFlowState;
    if(isPersisted(parsed)) return parsed;
  } catch{}
  return {kind: 'idle'};
}

export function getFlowState(): UpdateFlowState {
  return _state;
}

export function setFlowState(next: UpdateFlowState): void {
  _state = next;
  if(isPersisted(next)) {
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  } else {
    localStorage.removeItem(LS_KEY);
  }
  import('@lib/rootScope').then(({default: rs}) => rs.dispatchEventSingle('update_state_changed', next));
}

export function resetFlowState(): void {
  _state = loadFromStorage();
}

_state = loadFromStorage();
