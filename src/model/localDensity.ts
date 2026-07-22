/**
 * Local population-density field: total demand mass (residents + jobs) per m²
 * within a build radius of a location, grid-bucketed at that radius so `at()`
 * scans only a 3×3 ring. Drives the split-readiness HEADROOM gate — a cell stops
 * accruing split pressure where local density already meets the target, so a
 * dense city (NYC) adds few new demand points while a sparse one (Denver)
 * subdivides toward the target. Unlike agglomeration's normalized [0,1] job
 * density, this is ABSOLUTE people/m², comparable across cities against the
 * target.
 */
import type { Coordinate } from '../types/core';
import type { DemandPoint } from '../types/game-state';
import { haversine } from './geo';

const M_PER_DEG_LAT = 111194.9;

export interface PopDensity {
  /** Existing people (residents + jobs) per m² within the build radius of `c`. */
  at(c: Coordinate): number;
}

export function buildPopDensity(points: Iterable<DemandPoint>, radiusM: number): PopDensity {
  const pts = [...points];
  const midLat = pts.length ? pts[0].location[1] : 0;
  const mPerLon = M_PER_DEG_LAT * Math.max(0.05, Math.cos((midLat * Math.PI) / 180));
  const cellOf = (lon: number, lat: number): [number, number] =>
    [Math.floor((lon * mPerLon) / radiusM), Math.floor((lat * M_PER_DEG_LAT) / radiusM)];
  const grid = new Map<string, DemandPoint[]>();
  for (const p of pts) {
    const [cx, cy] = cellOf(p.location[0], p.location[1]);
    const k = `${cx},${cy}`;
    const b = grid.get(k);
    if (b) b.push(p); else grid.set(k, [p]);
  }
  const area = Math.PI * radiusM * radiusM;
  return {
    at(c: Coordinate): number {
      const [cx, cy] = cellOf(c[0], c[1]);
      let mass = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const p of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (haversine(c, p.location) <= radiusM) mass += p.residents + p.jobs;
          }
        }
      }
      return mass / area;
    },
  };
}
