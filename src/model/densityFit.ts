/**
 * Density calibration from the city's own points (spec §3): "at access level a,
 * how dense is this city, when it's dense?" Two monotone curves over access bins —
 * spacing (low quantile of NN distance; high access packs tighter) and people
 * mass (upper quantile; clamped by the city-wide envelope so induced sprawl can
 * never out-dense what the map demonstrates).
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

/** Quantile-ladder resolution for the per-bin res/job mass distributions. */
const MASS_LADDER = 10;

export interface DensityFit {
  /** Per-bin spacing r (m), index = bin. */
  spacing: number[];
  /** Per-bin mass M (people). */
  mass: number[];
  /** City-wide people-mass envelope (ENVELOPE_QUANTILE). */
  massCeiling: number;
  /**
   * Per-bin quantile ladder (MASS_LADDER+1 entries, q = 0..1) of the NATIVE
   * per-point RESIDENT / JOB mass (only points with mass on that side). These
   * capture each side's DISTRIBUTION SHAPE — residents are even, jobs are
   * heavy-tailed — so a materialized point's cap can be DRAWN from the shape
   * (massResAt/massJobAt) instead of a single flat quantile that erases it.
   */
  massResQ: number[][];
  massJobQ: number[][];
  bins: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx];
}

/** A quantile ladder [q0..q1] over `MASS_LADDER+1` evenly spaced quantiles. */
function ladderOf(sorted: number[]): number[] {
  return Array.from({ length: MASS_LADDER + 1 }, (_, k) => quantile(sorted, k / MASS_LADDER));
}

/** Linear-interpolate a quantile ladder at quantile q ∈ [0,1]. */
function ladderInterp(ladder: number[], q: number): number {
  const L = ladder.length - 1;
  const pos = Math.min(1, Math.max(0, q)) * L;
  const i = Math.min(L - 1, Math.floor(pos));
  return ladder[i] + (pos - i) * (ladder[i + 1] - ladder[i]);
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
  const byBinRes: number[][] = Array.from({ length: bins }, () => []);
  const byBinJob: number[][] = Array.from({ length: bins }, () => []);
  const allMass: number[] = [];
  const allRes: number[] = [];
  const allJob: number[] = [];
  pts.forEach((p, i) => {
    const b = Math.min(bins - 1, Math.floor(p.access * bins));
    if (Number.isFinite(nn[i])) byBinNN[b].push(nn[i]);
    byBinMass[b].push(p.residents + p.jobs);
    allMass.push(p.residents + p.jobs);
    // Per-side distributions use only points that HAVE that side's mass, so the
    // shape reflects real residential/job concentrations (a pure-resident point
    // is not a 0-job data point that would flatten the job distribution).
    if (p.residents > 0) { byBinRes[b].push(p.residents); allRes.push(p.residents); }
    if (p.jobs > 0) { byBinJob[b].push(p.jobs); allJob.push(p.jobs); }
  });
  allMass.sort((a, b) => a - b);
  allRes.sort((a, b) => a - b);
  allJob.sort((a, b) => a - b);
  const massCeiling = quantile(allMass, cfg.ENVELOPE_QUANTILE);
  const globalResLadder = ladderOf(allRes);
  const globalJobLadder = ladderOf(allJob);

  const spacing: number[] = new Array(bins);
  const mass: number[] = new Array(bins);
  const massResQ: number[][] = new Array(bins);
  const massJobQ: number[][] = new Array(bins);
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
    const rSorted = [...byBinRes[b]].sort((x, y) => x - y);
    const jSorted = [...byBinJob[b]].sort((x, y) => x - y);
    massResQ[b] = rSorted.length > 0 ? ladderOf(rSorted) : (b > 0 ? massResQ[b - 1] : globalResLadder);
    massJobQ[b] = jSorted.length > 0 ? ladderOf(jSorted) : (b > 0 ? massJobQ[b - 1] : globalJobLadder);
  }
  // Monotone enforcement: spacing non-increasing, mass non-decreasing with access.
  for (let b = 1; b < bins; b++) {
    spacing[b] = Math.min(spacing[b], spacing[b - 1]);
    mass[b] = Math.max(mass[b], mass[b - 1]);
  }
  return { spacing, mass, massCeiling, massResQ, massJobQ, bins };
}

function binOf(fit: DensityFit, access: number): number {
  return Math.min(fit.bins - 1, Math.max(0, Math.floor(access * fit.bins)));
}

export function spacingAt(fit: DensityFit, access: number): number {
  return fit.spacing[binOf(fit, access)];
}

/**
 * Materialized-point RESIDENT / JOB cap, DRAWN from the native side-distribution
 * at this access rather than a flat quantile — so a new point inherits the
 * side's shape (even residents, heavy-tailed jobs). `u` is a stable per-point
 * draw in [0,1] (access-biased upstream); it's mapped into the quantile bracket
 * [qFloor, 1] of the distribution. qFloor sets how far DOWN a low draw can reach
 * — lower = low-access points can be genuinely small, higher = all new areas
 * target denser native examples.
 */
export function massResAt(fit: DensityFit, access: number, u: number, qFloor: number): number {
  return ladderInterp(fit.massResQ[binOf(fit, access)], qFloor + (1 - qFloor) * Math.min(1, Math.max(0, u)));
}

export function massJobAt(fit: DensityFit, access: number, u: number, qFloor: number): number {
  return ladderInterp(fit.massJobQ[binOf(fit, access)], qFloor + (1 - qFloor) * Math.min(1, Math.max(0, u)));
}

export function massAt(fit: DensityFit, access: number): number {
  return fit.mass[binOf(fit, access)];
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
