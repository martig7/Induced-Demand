import type { DemandPoint, ModeChoiceStats } from '../types/game-state';
import { clamp01 } from './util';

/**
 * Access-dominant floor for the mode-share modulator. Score = access × (FLOOR + (1−FLOOR)×transitFraction),
 * so transit *access* drives the score and current transit *mode share* only modulates it within
 * [FLOOR, 1]. Without the floor, the many nodes with ~0 current transit ridership score 0 even when
 * well-served — starving induced growth there. 0.5 = a served node with no transit riders still scores
 * half of its access; a fully-transit node scores its full access.
 */
export const MODE_SHARE_FLOOR = 0.5;

/** Transit share as a fraction in [0,1]. Works whether stats are counts or shares. */
export function transitFraction(m: ModeChoiceStats): number {
  const total = m.walking + m.driving + m.transit + m.unknown;
  return total > 0 ? m.transit / total : 0;
}

/** Mode-share modulator in [MODE_SHARE_FLOOR, 1]. */
function modeFactor(transit: number): number {
  return MODE_SHARE_FLOOR + (1 - MODE_SHARE_FLOOR) * clamp01(transit);
}

export function residentialScore(point: DemandPoint, accessValue: number): number {
  return accessValue * modeFactor(transitFraction(point.residentModeShare));
}

export function commercialScore(point: DemandPoint, accessValue: number): number {
  return accessValue * modeFactor(transitFraction(point.workerModeShare));
}
