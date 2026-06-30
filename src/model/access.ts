import type { Coordinate } from '../types/core';
import type { InducedDemandConfig } from './config';
import { walkSeconds } from './geo';

export interface AccessStation {
  coords: Coordinate;
  /** Distinct line/route ids serving this station. */
  lineIds: string[];
}

/**
 * Catchment-connectivity score in [0,1] for a demand point.
 * 0 when no station is within catchment (gates growth).
 */
export function access(
  pointLoc: Coordinate,
  stations: AccessStation[],
  cfg: InducedDemandConfig,
): number {
  let walkProx = 0;
  const lines = new Set<string>();
  for (const s of stations) {
    const t = walkSeconds(pointLoc, s.coords, cfg.WALK_SPEED);
    if (t > cfg.CATCHMENT_SECONDS) continue;
    const d = Math.exp(-((t / cfg.TAU_ACCESS) ** 2));
    if (d > walkProx) walkProx = d;
    for (const id of s.lineIds) lines.add(id);
  }
  if (walkProx === 0) return 0;
  const connectivity = Math.min(1, lines.size / cfg.CONNECTIVITY_REF);
  return walkProx * (cfg.ACCESS_CONN_FLOOR + (1 - cfg.ACCESS_CONN_FLOOR) * connectivity);
}
