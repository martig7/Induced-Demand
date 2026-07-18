import type { Coordinate } from '../types/core';

export interface AccessStation {
  coords: Coordinate;
  /** Distinct line/route ids serving this station. */
  lineIds: string[];
}

/** Stations with at least one live route id — used for access scoring. */
export function toAccessStations(
  stations: { coords: Coordinate; routeIds?: string[] }[],
): AccessStation[] {
  return stations
    .filter((s) => (s.routeIds?.length ?? 0) > 0)
    .map((s) => ({ coords: s.coords, lineIds: s.routeIds ?? [] }));
}
