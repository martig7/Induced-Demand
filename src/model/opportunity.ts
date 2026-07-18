/**
 * Reachability-to-opportunity (spec §2). Per station: Dijkstra over the
 * stationGraph, then O_jobs/O_res = Σ reachable mass × exp(−t/TAU_REACH),
 * normalized by city totals. Per location: walk proximity × opportunity of the
 * best in-catchment station, directional (residences value reachable JOBS,
 * job sites value reachable RESIDENTS — mirroring gravity pairing).
 * Recomputed on network change / day end only; per-site lookups are O(stations).
 */
import type { Coordinate } from '../types/core';
import type { DemandPoint, Station } from '../types/game-state';
import type { InducedDemandConfig } from './config';
import type { StationGraph } from './stationGraph';
import { haversine, walkSeconds } from './geo';

/** Binary-heap Dijkstra; returns seconds from `sourceStreet` to every street node. */
export function dijkstraStreetTimes(g: StationGraph, sourceStreet: number): Float64Array {
  const dist = new Float64Array(g.nodeCount).fill(Infinity);
  dist[sourceStreet] = 0;
  // [dist, node] pairs in a simple binary min-heap.
  const heap: [number, number][] = [[0, sourceStreet]];
  const push = (d: number, n: number): void => {
    heap.push([d, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length > 0) {
    const [d, n] = pop()!;
    if (d > dist[n]) continue;
    for (const e of g.adj[n]) {
      const nd = d + e.s;
      if (nd < dist[e.to]) { dist[e.to] = nd; push(nd, e.to); }
    }
  }
  return dist.slice(0, g.stationIds.length);
}

export interface StationMass { res: number; jobs: number }

/**
 * Degree-scaled grid keying for radius searches. Longitude degrees shrink by
 * cos(lat), so an unscaled lon key makes cells NARROWER (in meters) than the
 * search radius away from the equator, and a 3×3 ring can miss east/west
 * neighbors near the radius edge. Keys are cos-scaled at a fixed reference
 * latitude, and the cell gets a 5% margin so "the ring covers the radius"
 * holds across a city's own cos(lat) variation.
 */
function radiusGridKeyer(
  radiusM: number,
  refLat: number,
): (lon: number, lat: number) => { cx: number; cy: number } {
  const cell = radiusM * 1.05;
  const mPerLon = 111320 * Math.max(0.2, Math.cos((refLat * Math.PI) / 180));
  return (lon: number, lat: number) => ({
    cx: Math.floor((lon * mPerLon) / cell),
    cy: Math.floor((lat * 110540) / cell),
  });
}

/** Residents/jobs mass within each station's walk catchment (grid-indexed). */
export function stationMasses(
  stations: Station[],
  points: Iterable<DemandPoint>,
  cfg: InducedDemandConfig,
): Map<string, StationMass> {
  const radiusM = cfg.CATCHMENT_SECONDS * cfg.WALK_SPEED;
  const cellOf = radiusGridKeyer(radiusM, stations[0]?.coords[1] ?? 0);
  const grid = new Map<string, DemandPoint[]>();
  for (const p of points) {
    const { cx, cy } = cellOf(p.location[0], p.location[1]);
    const k = `${cx},${cy}`;
    const bucket = grid.get(k);
    if (bucket) bucket.push(p); else grid.set(k, [p]);
  }
  const out = new Map<string, StationMass>();
  for (const st of stations) {
    let res = 0, jobs = 0;
    const { cx, cy } = cellOf(st.coords[0], st.coords[1]);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const p of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (haversine(st.coords, p.location) <= radiusM) { res += p.residents; jobs += p.jobs; }
        }
      }
    }
    out.set(st.id, { res, jobs });
  }
  return out;
}

export interface StationOpportunity {
  stationId: string;
  coords: Coordinate;
  /** Normalized reachable-jobs mass in [0,1] — feeds RESIDENTIAL access. */
  oJobs: number;
  /** Normalized reachable-residents mass in [0,1] — feeds COMMERCIAL access. */
  oRes: number;
}

export function computeOpportunities(
  g: StationGraph,
  masses: Map<string, StationMass>,
  cfg: InducedDemandConfig,
): StationOpportunity[] {
  let totalRes = 0, totalJobs = 0;
  for (const m of masses.values()) { totalRes += m.res; totalJobs += m.jobs; }
  const out: StationOpportunity[] = [];
  for (let i = 0; i < g.stationIds.length; i++) {
    const t = dijkstraStreetTimes(g, i);
    let oJobs = 0, oRes = 0;
    for (let j = 0; j < g.stationIds.length; j++) {
      if (!Number.isFinite(t[j])) continue;
      const m = masses.get(g.stationIds[j]);
      if (!m) continue;
      const decay = Math.exp(-t[j] / cfg.TAU_REACH);
      oJobs += m.jobs * decay;
      oRes += m.res * decay;
    }
    out.push({
      stationId: g.stationIds[i],
      coords: g.coords[i],
      oJobs: totalJobs > 0 ? Math.min(1, oJobs / totalJobs) : 0,
      oRes: totalRes > 0 ? Math.min(1, oRes / totalRes) : 0,
    });
  }
  return out;
}

export interface DirectionalAccess { res: number; com: number }

/**
 * Access v2 at a location: best in-catchment station's
 * walkProx × (floor + (1−floor)·Ô), per side. Replaces line-count connectivity.
 */
export function accessAt(
  loc: Coordinate,
  opps: StationOpportunity[],
  cfg: InducedDemandConfig,
): DirectionalAccess {
  return accessOver(loc, opps, cfg);
}

/** Shared scorer: only the stations handed in are considered. */
function accessOver(
  loc: Coordinate,
  opps: Iterable<StationOpportunity>,
  cfg: InducedDemandConfig,
): DirectionalAccess {
  let res = 0, com = 0;
  const floor = cfg.ACCESS_CONN_FLOOR;
  for (const o of opps) {
    const t = walkSeconds(loc, o.coords, cfg.WALK_SPEED);
    if (t > cfg.CATCHMENT_SECONDS) continue;
    const prox = Math.exp(-((t / cfg.TAU_ACCESS) ** 2));
    const r = prox * (floor + (1 - floor) * o.oJobs);
    const c = prox * (floor + (1 - floor) * o.oRes);
    if (r > res) res = r;
    if (c > com) com = c;
  }
  return { res, com };
}

/**
 * Station-proximity index for access lookups. `accessAt` is O(stations) per
 * call, which multiplied across every sampler attempt of a 10k-site field
 * rebuild — the second-largest cost in the measured 161 s tier1. Stations are
 * gridded at catchment-radius cells, so `at()` scans only the 3×3 ring: any
 * station within the catchment radius is inside that ring, and stations
 * outside contribute nothing to `accessOver` anyway — results are identical
 * to the brute-force scan, float for float.
 */
export interface AccessIndex {
  at(loc: Coordinate): DirectionalAccess;
}

export function buildAccessIndex(
  opps: StationOpportunity[],
  cfg: InducedDemandConfig,
): AccessIndex {
  const radiusM = cfg.CATCHMENT_SECONDS * cfg.WALK_SPEED;
  const cellOf = radiusGridKeyer(radiusM, opps[0]?.coords[1] ?? 0);
  const grid = new Map<string, StationOpportunity[]>();
  for (const o of opps) {
    const { cx, cy } = cellOf(o.coords[0], o.coords[1]);
    const k = `${cx},${cy}`;
    const bucket = grid.get(k);
    if (bucket) bucket.push(o); else grid.set(k, [o]);
  }
  return {
    at(loc: Coordinate): DirectionalAccess {
      const { cx, cy } = cellOf(loc[0], loc[1]);
      const nearby: StationOpportunity[] = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = grid.get(`${cx + dx},${cy + dy}`);
          if (bucket) nearby.push(...bucket);
        }
      }
      return accessOver(loc, nearby, cfg);
    },
  };
}
