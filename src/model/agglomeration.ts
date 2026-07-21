/**
 * Local job-density field for agglomeration: a point near lots of jobs is a
 * more attractive place for MORE jobs (the economic reason downtowns exist).
 * Returns a normalized [0,1] density — jobs within AGGLOM_RADIUS_M, scaled by the
 * 90th-percentile density so job cores read ~1 and the periphery ~0. Rebuilt with
 * the field, so it tracks induced growth (bounded by the caps) — the feedback
 * that makes a few clusters run away instead of jobs spreading evenly.
 */
import type { Coordinate } from '../types/core';
import type { InducedDemandConfig } from './config';
import { haversine } from './geo';

const M_PER_DEG_LAT = 111194.9;

export interface JobDensity {
  at(c: Coordinate): number;
}

export function buildJobDensity(
  points: Iterable<{ location: Coordinate; jobs: number }>,
  cfg: InducedDemandConfig,
): JobDensity {
  const R = cfg.AGGLOM_RADIUS_M;
  const jobPts = [...points].filter((p) => p.jobs > 0);
  if (jobPts.length === 0 || R <= 0) return { at: () => 0 };

  const refLat = jobPts[0].location[1];
  const mPerLon = M_PER_DEG_LAT * Math.max(0.05, Math.cos((refLat * Math.PI) / 180));
  const col = (lon: number): number => Math.floor((lon * mPerLon) / R);
  const row = (lat: number): number => Math.floor((lat * M_PER_DEG_LAT) / R);
  const key = (c: number, r: number): string => `${c},${r}`;

  const grid = new Map<string, { location: Coordinate; jobs: number }[]>();
  for (const p of jobPts) {
    const k = key(col(p.location[0]), row(p.location[1]));
    const b = grid.get(k);
    if (b) b.push(p); else grid.set(k, [p]);
  }

  const raw = (c: Coordinate): number => {
    const cc = col(c[0]), cr = row(c[1]);
    let sum = 0;
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        for (const p of grid.get(key(cc + dc, cr + dr)) ?? []) {
          if (haversine(c, p.location) <= R) sum += p.jobs;
        }
      }
    }
    return sum;
  };

  // Normalize by the 90th-percentile local density over the job points, so the
  // densest ~10% of job land saturates at 1 and the multiplier stays bounded.
  const densities = jobPts.map((p) => raw(p.location)).sort((a, b) => a - b);
  const q90 = densities[Math.floor(0.9 * densities.length)] || densities[densities.length - 1] || 1;
  return { at: (c) => Math.min(1, raw(c) / q90) };
}
