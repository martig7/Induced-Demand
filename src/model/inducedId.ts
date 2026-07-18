/**
 * Identity of the pops this mod creates. Kept in its own module so low-level
 * consumers (model/drivingModel) can recognise our pops without importing
 * popFactory, which imports them back.
 */
export const INDUCED_PREFIX = 'induced:';

export function isInduced(popId: string): boolean {
  return popId.startsWith(INDUCED_PREFIX);
}

/**
 * Demand POINTS this mod materializes from candidate sites. Distinct prefix from
 * pops: `isInduced` (pop checks) must NOT match point ids and vice versa.
 */
export const INDUCED_POINT_PREFIX = 'induced-pt:';

export function isInducedPoint(pointId: string): boolean {
  return pointId.startsWith(INDUCED_POINT_PREFIX);
}
