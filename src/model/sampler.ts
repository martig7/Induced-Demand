/**
 * Deterministic blue-noise site sampling (spec §4). Bridson Poisson-disc with a
 * spatially-varying radius inside one station catchment, seeded by city+station —
 * candidates re-derive identically every load, so positions are never persisted.
 * Priors (existing demand points / already-accepted sites) block placement at the
 * SOFT spacing (1−J_FRAC)·r so condensation jitter reads as organic scatter
 * instead of compounding displacement. Water (or any reject predicate) excludes.
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

export interface SampleCatchmentOpts {
  /** Deterministic identity, e.g. `<city>:<stationId>`; also the site-id prefix. */
  seedKey: string;
  center: Coordinate;
  radiusM: number;
  /** Existing locations that block placement (soft spacing). */
  priors: Coordinate[];
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
  const { center, radiusM, softFactor } = opts;
  const lat0 = center[1];
  const mPerLon = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const mPerLat = M_PER_DEG;
  const toLonLat = (x: number, y: number): Coordinate =>
    [center[0] + x / mPerLon, center[1] + y / mPerLat];
  const rng = makeRng(hashStringToSeed(opts.seedKey));

  // Occupancy grid over accepted + prior positions (meter frame), cell = R_MIN-ish.
  // Each sample/blocker carries its OWN spacing radius so rejection honors the
  // larger exclusion disk of the two — a dense candidate must not encroach on a
  // sparse sample's wider disk, and vice versa.
  const accepted: { x: number; y: number; loc: Coordinate; r: number }[] = [];
  const blockers: { x: number; y: number; r: number }[] = [];
  for (const p of opts.priors) {
    const x = (p[0] - center[0]) * mPerLon;
    const y = (p[1] - center[1]) * mPerLat;
    const r = opts.spacingAt(p);
    if (Math.hypot(x, y) <= radiusM + 2 * r) blockers.push({ x, y, r });
  }
  const tooClose = (x: number, y: number, rNew: number): boolean => {
    for (const b of blockers)
      if (Math.hypot(b.x - x, b.y - y) < softFactor * Math.max(rNew, b.r)) return true;
    for (const a of accepted)
      if (Math.hypot(a.x - x, a.y - y) < softFactor * Math.max(rNew, a.r)) return true;
    return false;
  };

  const tryAccept = (x: number, y: number): boolean => {
    if (Math.hypot(x, y) > radiusM) return false;
    const loc = toLonLat(x, y);
    const r = opts.spacingAt(loc);
    if (tooClose(x, y, r)) return false;
    if (opts.reject(loc)) return false;
    accepted.push({ x, y, loc, r });
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
