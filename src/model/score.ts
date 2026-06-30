import type { DemandPoint, ModeChoiceStats } from '../types/game-state';
import { clamp01 } from './util';

/** Transit share as a fraction in [0,1]. Works whether stats are counts or shares. */
export function transitFraction(m: ModeChoiceStats): number {
  const total = m.walking + m.driving + m.transit + m.unknown;
  return total > 0 ? m.transit / total : 0;
}

export function residentialScore(point: DemandPoint, accessValue: number): number {
  return clamp01(transitFraction(point.residentModeShare)) * accessValue;
}

export function commercialScore(point: DemandPoint, accessValue: number): number {
  return clamp01(transitFraction(point.workerModeShare)) * accessValue;
}
