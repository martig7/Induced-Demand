import type { OverlayView, OverlayMetric } from './types';

export interface OverlayState {
  enabled: boolean;
  view: OverlayView;
  metric: OverlayMetric;
}

export interface OverlayStore {
  get(): OverlayState;
  set(patch: Partial<OverlayState>): void;
  subscribe(fn: () => void): () => void;
}

export function createOverlayStore(initial: OverlayState): OverlayStore {
  let state: OverlayState = { ...initial };
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
      for (const fn of subs) fn();
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => { subs.delete(fn); };
    },
  };
}
