/**
 * Density calibration from the city's own points (spec §3): "at access level a,
 * how dense is this city, when it's dense?" Two monotone curves over access bins —
 * spacing (low quantile of NN distance; high access packs tighter) and people
 * mass (upper quantile; clamped by the city-wide envelope so induced sprawl can
 * never out-dense what the map demonstrates). The ceiling multiplier creeps up
 * while the city is saturated (never down — cities don't un-build).
 */
import type { Coordinate } from '../types/core';
import type { InducedDemandConfig } from './config';
import { haversine } from './geo';

export interface FitInputPoint {
  location: Coordinate;
  residents: number;
  jobs: number;
  access: number;
}

export interface DensityFit {
  /** Per-bin spacing r (m), index = bin. */
  spacing: number[];
  /** Per-bin mass M (people). */
  mass: number[];
  /** City-wide people-mass envelope (ENVELOPE_QUANTILE). */
  massCeiling: number;
  bins: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx];
}

/** Nearest-neighbor distance per point via a coarse grid (cell = R_MAX). */
function nnDistances(pts: FitInputPoint[], cellM: number): number[] {
  const grid = new Map<string, number[]>();
  const key = (lon: number, lat: number): string =>
    `${Math.floor((lon * 111320) / cellM)},${Math.floor((lat * 110540) / cellM)}`;
  pts.forEach((p, i) => {
    const k = key(p.location[0], p.location[1]);
    const b = grid.get(k);
    if (b) b.push(i); else grid.set(k, [i]);
  });
  return pts.map((p, i) => {
    const cx = Math.floor((p.location[0] * 111320) / cellM);
    const cy = Math.floor((p.location[1] * 110540) / cellM);
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (j === i) continue;
          const d = haversine(p.location, pts[j].location);
          if (d < best) best = d;
        }
      }
    }
    return best; // Infinity when isolated beyond the ring — treated as R_MAX by clamping
  });
}

export function fitDensity(pts: FitInputPoint[], cfg: InducedDemandConfig): DensityFit {
  const bins = cfg.FIT_BINS;
  const nn = nnDistances(pts, cfg.R_MAX);
  const byBinNN: number[][] = Array.from({ length: bins }, () => []);
  const byBinMass: number[][] = Array.from({ length: bins }, () => []);
  const allMass: number[] = [];
  pts.forEach((p, i) => {
    const b = Math.min(bins - 1, Math.floor(p.access * bins));
    if (Number.isFinite(nn[i])) byBinNN[b].push(nn[i]);
    byBinMass[b].push(p.residents + p.jobs);
    allMass.push(p.residents + p.jobs);
  });
  allMass.sort((a, b) => a - b);
  const massCeiling = quantile(allMass, cfg.ENVELOPE_QUANTILE);

  const spacing: number[] = new Array(bins);
  const mass: number[] = new Array(bins);
  const clampR = (r: number): number => Math.min(cfg.R_MAX, Math.max(cfg.R_MIN, r));
  for (let b = 0; b < bins; b++) {
    const nnSorted = [...byBinNN[b]].sort((x, y) => x - y);
    const mSorted = [...byBinMass[b]].sort((x, y) => x - y);
    // Empty bins borrow from the nearest populated bin below (bin 0 → global default).
    spacing[b] = nnSorted.length > 0
      ? clampR(quantile(nnSorted, cfg.FIT_SPACING_QUANTILE))
      : (b > 0 ? spacing[b - 1] : cfg.R_MAX);
    mass[b] = mSorted.length > 0
      ? Math.min(massCeiling, quantile(mSorted, cfg.FIT_MASS_QUANTILE))
      : (b > 0 ? mass[b - 1] : quantile(allMass, cfg.FIT_MASS_QUANTILE));
  }
  // Monotone enforcement: spacing non-increasing, mass non-decreasing with access.
  for (let b = 1; b < bins; b++) {
    spacing[b] = Math.min(spacing[b], spacing[b - 1]);
    mass[b] = Math.max(mass[b], mass[b - 1]);
  }
  return { spacing, mass, massCeiling, bins };
}

function binOf(fit: DensityFit, access: number): number {
  return Math.min(fit.bins - 1, Math.max(0, Math.floor(access * fit.bins)));
}

export function spacingAt(fit: DensityFit, access: number): number {
  return fit.spacing[binOf(fit, access)];
}

export function massAt(fit: DensityFit, access: number): number {
  return fit.mass[binOf(fit, access)];
}

/** Daily ceiling creep (spec §3): monotone, only while σ exceeds the threshold. */
export function creepDensify(current: number, sigma: number, cfg: InducedDemandConfig): number {
  if (sigma <= cfg.SAT_THRESHOLD) return current;
  return current * (1 + cfg.RHO_DENSIFY * (sigma - cfg.SAT_THRESHOLD));
}

/**
 * Areal density the access level supports: people per m², derived from the two
 * fitted curves (mass per point ÷ the area one point serves at that spacing).
 * Feeds the lattice's per-cell supported-mass integral (spec 2026-07-18).
 */
export function supportedDensityAt(fit: DensityFit, access: number): number {
  const r = spacingAt(fit, access);
  return massAt(fit, access) / (r * r);
}
