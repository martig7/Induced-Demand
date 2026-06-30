import type { InducedDemandConfig } from './config';

/** Per-point ceiling: baseline scaled by transit attractiveness. */
export function cap(baseline: number, score: number, kMax: number): number {
  return baseline * (1 + kMax * score);
}

/**
 * One day's signed pressure for a side.
 * Below cap: logistic growth (scaled by score). Above cap: slow decay
 * proportional to the overshoot, independent of score.
 */
export function logisticDelta(
  baseline: number,
  current: number,
  capValue: number,
  score: number,
  cfg: InducedDemandConfig,
): number {
  if (capValue <= 0) return 0;
  if (current <= capValue) {
    return cfg.R_GROW * score * current * (1 - current / capValue);
  }
  return -cfg.R_DECAY * (current - capValue);
}
