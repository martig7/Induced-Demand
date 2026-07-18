/**
 * Deterministic blue-noise site sampling (spec §4). Bridson Poisson-disc with a
 * spatially-varying radius inside one station catchment, seeded by city+station —
 * candidates re-derive identically every load, so positions are never persisted.
 * Blockers (existing demand points / already-accepted sites) live in one shared
 * SpacingIndex per field build and block placement at the SOFT spacing
 * (1−J_FRAC)·r, so condensation jitter reads as organic scatter instead of
 * compounding displacement. Water (or any reject predicate) excludes.
 *
 * Jitter at condensation is seeded by the materialized POINT id (FNV-1a →
 * mulberry32, the commuteTimes pattern): deterministic re-roll ≤ 4 attempts
 * against the caller's reject predicate, then the nominal position (already
 * validated at sampling time).
 */
import type { Coordinate } from '../types/core';
import { makeRng } from './gravity';
import { haversine } from './geo';

export function hashStringToSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export interface SamplePoint { id: string; location: Coordinate }

/**
 * Spatial hash over every placed site/blocker, shared across ALL catchments of
 * one field build. Each entry carries its own spacing radius; a candidate is
 * blocked when it sits within softFactor·max(rNew, rEntry) of any entry — the
 * larger exclusion disk of the two wins. Cell-ring lookup makes the check
 * O(nearby) instead of O(all placed), which is what turned the 10k-site build
 * quadratic (161 s measured in-game before this index existed).
 */
export interface SpacingIndex {
  insert(loc: Coordinate, r: number): void;
  blocked(loc: Coordinate, rNew: number, softFactor: number): boolean;
  size(): number;
}

const CELL_M = 128;

export function createSpacingIndex(): SpacingIndex {
  const cells = new Map<string, { loc: Coordinate; r: number }[]>();
  // Longitude cell width is fixed from the FIRST insert's latitude (deterministic
  // for a given build input order); the ring search adds a margin cell so the
  // small within-city cos(lat) drift can never miss a neighbor.
  let cellLonDeg: number | null = null;
  const cellLatDeg = CELL_M / M_PER_DEG;
  let maxR = 0;
  let count = 0;
  const keyOf = (loc: Coordinate): { cx: number; cy: number } => ({
    cx: Math.floor(loc[0] / (cellLonDeg ?? cellLatDeg)),
    cy: Math.floor(loc[1] / cellLatDeg),
  });
  return {
    insert(loc: Coordinate, r: number): void {
      if (cellLonDeg === null) {
        const cos = Math.max(0.2, Math.cos((loc[1] * Math.PI) / 180));
        cellLonDeg = CELL_M / (M_PER_DEG * cos);
      }
      const { cx, cy } = keyOf(loc);
      const k = `${cx},${cy}`;
      const bucket = cells.get(k);
      if (bucket) bucket.push({ loc, r }); else cells.set(k, [{ loc, r }]);
      if (r > maxR) maxR = r;
      count++;
    },
    blocked(loc: Coordinate, rNew: number, softFactor: number): boolean {
      if (count === 0) return false;
      const reach = softFactor * Math.max(rNew, maxR);
      const ring = Math.ceil(reach / CELL_M) + 1; // +1 margin for lon-scale drift
      const { cx, cy } = keyOf(loc);
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          const bucket = cells.get(`${cx + dx},${cy + dy}`);
          if (!bucket) continue;
          for (const e of bucket) {
            if (haversine(loc, e.loc) < softFactor * Math.max(rNew, e.r)) return true;
          }
        }
      }
      return false;
    },
    size: () => count,
  };
}

export interface SampleCatchmentOpts {
  /** Deterministic identity, e.g. `<city>:<stationId>`; also the site-id prefix. */
  seedKey: string;
  center: Coordinate;
  radiusM: number;
  /**
   * Shared spacing index (soft-spacing blockers). The caller seeds it with
   * existing points/sites once per BUILD, not per catchment; every accepted
   * sample is inserted so later catchments respect it.
   */
  blockers: SpacingIndex;
  /** Local target spacing r (m) at a location. */
  spacingAt(c: Coordinate): number;
  /** True to exclude a location (water). */
  reject(c: Coordinate): boolean;
  /** Soft-spacing factor (1 − J_FRAC). */
  softFactor: number;
}

const K_ATTEMPTS = 16;
const DART_SEEDS = 12;

// Equirectangular meter frame derived from the SAME sphere as geo.ts's haversine
// (EARTH_RADIUS_M), so planar distances used for radius/spacing checks agree with
// the great-circle distances measured downstream. WGS84 averages (111320/110540)
// disagree with the spherical haversine by ~0.6% and let boundary sites overshoot.
const M_PER_DEG = (6371008.8 * Math.PI) / 180;

export function sampleCatchmentSites(opts: SampleCatchmentOpts): SamplePoint[] {
  const { center, radiusM, softFactor, blockers } = opts;
  const lat0 = center[1];
  const mPerLon = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const mPerLat = M_PER_DEG;
  const toLonLat = (x: number, y: number): Coordinate =>
    [center[0] + x / mPerLon, center[1] + y / mPerLat];
  const rng = makeRng(hashStringToSeed(opts.seedKey));

  const accepted: { x: number; y: number; loc: Coordinate }[] = [];

  const tryAccept = (x: number, y: number): boolean => {
    if (Math.hypot(x, y) > radiusM) return false;
    const loc = toLonLat(x, y);
    const r = opts.spacingAt(loc);
    if (blockers.blocked(loc, r, softFactor)) return false;
    if (opts.reject(loc)) return false;
    blockers.insert(loc, r);
    accepted.push({ x, y, loc });
    return true;
  };

  // Seeds: the center, plus deterministic darts for pockets behind blockers.
  const active: number[] = [];
  if (tryAccept(0, 0)) active.push(accepted.length - 1);
  for (let i = 0; i < DART_SEEDS; i++) {
    const ang = rng() * 2 * Math.PI;
    const rad = Math.sqrt(rng()) * radiusM;
    if (tryAccept(rad * Math.cos(ang), rad * Math.sin(ang))) active.push(accepted.length - 1);
  }

  // Bridson: spawn in the annulus [r, 2r] of an active sample.
  while (active.length > 0) {
    const ai = Math.floor(rng() * active.length);
    const a = accepted[active[ai]];
    const r = opts.spacingAt(a.loc);
    let placed = false;
    for (let k = 0; k < K_ATTEMPTS; k++) {
      const ang = rng() * 2 * Math.PI;
      const rad = r * (1 + rng());
      if (tryAccept(a.x + rad * Math.cos(ang), a.y + rad * Math.sin(ang))) {
        active.push(accepted.length - 1);
        placed = true;
        break;
      }
    }
    if (!placed) active.splice(ai, 1);
  }

  return accepted.map((a, i) => ({ id: `${opts.seedKey}:${i}`, location: a.loc }));
}

/**
 * Jittered condensation position for a materialized point (spec §4): offset
 * ≤ jFrac·r from the nominal site, deterministic per point id; re-roll with a
 * bumped seed while rejected (≤ `attempts`), then fall back to the nominal.
 */
export function jitterPosition(
  pointId: string,
  nominal: Coordinate,
  rM: number,
  jFrac: number,
  reject: (c: Coordinate) => boolean,
  attempts = 4,
): Coordinate {
  const lat0 = nominal[1];
  const mPerLon = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const mPerLat = M_PER_DEG;
  for (let a = 0; a < attempts; a++) {
    const rng = makeRng(hashStringToSeed(`${pointId}:${a}`));
    const ang = rng() * 2 * Math.PI;
    const rad = Math.sqrt(rng()) * jFrac * rM;
    const c: Coordinate = [
      nominal[0] + (rad * Math.cos(ang)) / mPerLon,
      nominal[1] + (rad * Math.sin(ang)) / mPerLat,
    ];
    if (!reject(c)) return c;
  }
  return nominal;
}
