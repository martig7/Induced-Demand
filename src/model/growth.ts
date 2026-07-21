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
  // Decay tolerance band, sized to the INDUCED headroom (cap − baseline). It
  // absorbs the daily wobble of a moving-target cap (access/fit/share refit each
  // day) so a small dip doesn't shed a whole pop, but it VANISHES as cap → the
  // baseline (headroom → 0) — so removing transit still decays fully to baseline
  // with no residual. Below the band edge: no decay; above it: decay toward it.
  const band = capValue + cfg.DECAY_TOLERANCE * Math.max(0, capValue - baseline);
  if (current <= band) return 0;
  return -cfg.R_DECAY * (current - band);
}
