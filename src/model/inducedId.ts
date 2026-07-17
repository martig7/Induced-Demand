/**
 * Identity of the pops this mod creates. Kept in its own module so low-level
 * consumers (model/drivingModel) can recognise our pops without importing
 * popFactory, which imports them back.
 */
export const INDUCED_PREFIX = 'induced:';

export function isInduced(popId: string): boolean {
  return popId.startsWith(INDUCED_PREFIX);
}
