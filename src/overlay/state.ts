import type { OverlayView, OverlayMetric } from './types';

export interface OverlayState {
  enabled: boolean;
  view: OverlayView;
  metric: OverlayMetric;
  /** Bumped to re-render panel chrome. */
  revision: number;
  /** Induced pops still in the sim but queued to drop on the next save reload. */
  deferredRemovalCount: number;
  /** "Clear induced demand" was clicked; reload will wipe all induced pops. */
  clearQueued: boolean;
  /** Selected history day (green/red overlay active) or null. Takes precedence over `enabled`. */
  historyDay?: number | null;
  /** Inline history section expanded in the toolbar panel. */
  historyOpen?: boolean;
  /** Field heatmap view; 'off' hides the layer. */
  heatView?: 'off' | 'accessRes' | 'accessCom' | 'pressure';
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
