/**
 * Driving distance and time for an induced pop, in three tiers of fidelity:
 *
 *  1. **Route** it on the city's real road network (model/router) — per-pair truth,
 *     so barriers like rivers and mountains are respected. Reproduces the game's own
 *     `drivingDistance` to ~1% at the median.
 *  2. **Resample** a real native pop ("donor") from the same distance band when no
 *     road graph is available — distributionally right, per city, for free.
 *  3. **Constants** measured across the shipped cities, if the city has no pops
 *     either (blank/custom cities).
 *
 * Every tier is deterministic in the pop id, so a pop restored from the roster keeps
 * the values it had and model/commuteRescue can detect a stale pop by recomputing.
 *
 * Why not the old `haversine × 1.30 ÷ 11 m/s`: real speeds run 8.9 m/s on short trips
 * to 18.2 m/s on long ones (median 14.6), so a flat 11 inflated every driving time and
 * pushed our pops onto transit far more than comparable native pops.
 */
import type { Coordinate } from '../types/core';
import type { DemandData } from '../types/game-state';
import { haversine } from './geo';
import { isInduced } from './inducedId';
import { snapToNode, type RoadGraph } from './roadGraph';
import type { DrivingRouter } from './router';
import { makeRng } from './gravity';

export interface DrivingEstimate {
  /** Metres of road between residence and job (also used as the walk distance). */
  distance: number;
  seconds: number;
}

export interface DrivingModel {
  estimate(
    popId: string,
    residenceId: string,
    jobId: string,
    resLoc: Coordinate,
    jobLoc: Coordinate,
  ): DrivingEstimate;
}

/** One band of the distance→(detour, speed) relationship. */
export interface DrivingBand {
  /** Upper bound (exclusive) of straight-line distance, in metres. */
  maxMeters: number;
  detour: number;
  speed: number;
}

/**
 * Medians across the shipped cities (DEN/NYC/CHI/SF/BOS). The shape — short trips
 * slower and more circuitous — is consistent everywhere; only the level differs,
 * which is why tiers 1 and 2 prefer live data.
 */
export const DEFAULT_DRIVING_BANDS: readonly DrivingBand[] = [
  { maxMeters: 2000, detour: 1.52, speed: 8.59 },
  { maxMeters: 5000, detour: 1.41, speed: 10.57 },
  { maxMeters: 10000, detour: 1.37, speed: 12.59 },
  { maxMeters: 20000, detour: 1.33, speed: 14.08 },
  { maxMeters: Infinity, detour: 1.29, speed: 16.76 },
];

/** A real pop's observed relationship, reused for an induced pop of similar length. */
export interface Donor {
  detour: number;
  speed: number;
}

/** Endpoints closer than this are treated as this far apart, so time is never zero. */
const MIN_STRAIGHT_METERS = 50;
const DEFAULT_MIN_DONORS = 20;

export function bandIndexFor(straightMeters: number): number {
  for (let i = 0; i < DEFAULT_DRIVING_BANDS.length; i++) {
    if (straightMeters < DEFAULT_DRIVING_BANDS[i].maxMeters) return i;
  }
  return DEFAULT_DRIVING_BANDS.length - 1;
}

/** Learn the distance→(detour, speed) relationship from the city's own pops. */
export function buildDonorBands(dd: DemandData): Donor[][] {
  const bands: Donor[][] = DEFAULT_DRIVING_BANDS.map(() => []);
  for (const pop of dd.popsMap.values()) {
    if (isInduced(pop.id)) continue; // never learn from ourselves
    if (!(pop.drivingSeconds > 0) || !(pop.drivingDistance > 0)) continue;
    const res = dd.points.get(pop.residenceId);
    const job = dd.points.get(pop.jobId);
    if (!res || !job) continue;
    const straight = haversine(res.location, job.location);
    if (straight < 1) continue;
    const detour = pop.drivingDistance / straight;
    const speed = pop.drivingDistance / pop.drivingSeconds;
    if (!Number.isFinite(detour) || !Number.isFinite(speed) || speed <= 0) continue;
    bands[bandIndexFor(straight)].push({ detour, speed });
  }
  return bands;
}

export interface DrivingModelOptions {
  /** Tier 1. Both are needed: the graph snaps demand points, the router connects them. */
  routing?: { graph: RoadGraph; router: DrivingRouter } | null;
  /** Tier 2, from `buildDonorBands`. */
  donors?: Donor[][] | null;
  /** Below this, a band borrows from its nearest fuller neighbour. */
  minDonors?: number;
}

/** FNV-1a over the pop id — the same stable seed scheme as model/commuteTimes. */
function seedOf(popId: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < popId.length; i++) {
    h ^= popId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function createDrivingModel(opts: DrivingModelOptions = {}): DrivingModel {
  const { routing = null, donors = null, minDonors = DEFAULT_MIN_DONORS } = opts;
  /** Routed pairs are shared by every pop between the same two points. */
  const cache = new Map<string, DrivingEstimate | null>();

  /** Nearest band with enough donors, searching outward from `index`. */
  function donorPool(index: number): Donor[] | null {
    if (!donors) return null;
    if ((donors[index]?.length ?? 0) >= minDonors) return donors[index];
    for (let step = 1; step < donors.length; step++) {
      for (const i of [index - step, index + step]) {
        if (i >= 0 && i < donors.length && donors[i].length >= minDonors) return donors[i];
      }
    }
    // Nothing is full enough; fall back to this band if it has anything at all.
    return donors[index]?.length ? donors[index] : null;
  }

  function routed(residenceId: string, jobId: string, resLoc: Coordinate, jobLoc: Coordinate): DrivingEstimate | null {
    if (!routing) return null;
    const key = `${residenceId}>${jobId}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let result: DrivingEstimate | null = null;
    const from = snapToNode(routing.graph, resLoc);
    const to = snapToNode(routing.graph, jobLoc);
    if (from && to) {
      const r = routing.router.route(from.node, to.node);
      // The gaps from each demand point to its nearest road node count toward the
      // distance (this is the combination validated at 0.988 of the game's own).
      if (r && r.seconds > 0) result = { distance: r.distance + from.dist + to.dist, seconds: r.seconds };
    }
    cache.set(key, result);
    return result;
  }

  function estimate(
    popId: string,
    residenceId: string,
    jobId: string,
    resLoc: Coordinate,
    jobLoc: Coordinate,
  ): DrivingEstimate {
    const fromRoad = routed(residenceId, jobId, resLoc, jobLoc);
    if (fromRoad) return fromRoad;

    const straight = Math.max(MIN_STRAIGHT_METERS, haversine(resLoc, jobLoc));
    const index = bandIndexFor(straight);
    const pool = donorPool(index);
    if (pool && pool.length > 0) {
      const donor = pool[Math.floor(makeRng(seedOf(popId))() * pool.length) % pool.length];
      const distance = straight * donor.detour;
      return { distance, seconds: distance / donor.speed };
    }
    const band = DEFAULT_DRIVING_BANDS[index];
    const distance = straight * band.detour;
    return { distance, seconds: distance / band.speed };
  }

  return { estimate };
}

/** Constants-only model — the default for tests and any call site without a city. */
export const DEFAULT_DRIVING_MODEL: DrivingModel = createDrivingModel();
