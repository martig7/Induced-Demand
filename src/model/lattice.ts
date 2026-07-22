/**
 * Voronoi-cell integration WITHOUT polygon geometry (spec 2026-07-18): cell
 * membership is "this anchor is my nearest live demand point", evaluated on a
 * fixed coarse lattice covering the access-positive area. One pass yields each
 * cell's supported mass (∫ supportedDensity over its area) and access-weighted
 * centroid. Cut placement re-scans only the splitting cell's neighborhood at
 * split time (splits are rare by design).
 *
 * Determinism: fixed global grid origin (0,0), steps derived from LATTICE_M at
 * a reference latitude (first station), samples visited per-station in input
 * order with index-dedupe, nearest-anchor ties broken by id.
 */
import type { Coordinate } from '../types/core';
import type { DirectionalAccess } from './opportunity';
import { haversine } from './geo';

const M_PER_DEG_LAT = 111194.9;

export interface LatticeDeps {
  accessAt(c: Coordinate): DirectionalAccess;
  /**
   * Water/airport (or any placement obstacle) within `radiusM` of `c`, tested
   * against the fine blocked raster (a disc scan; `radiusM` 0 = the cell at `c`).
   * Replaces the old point-in-polygon isWater/isAirport — a fine precomputed
   * raster resolves thin rivers and shoreline neighbourhoods that discrete point
   * sampling misses.
   */
  blockedWithin(c: Coordinate, radiusM: number): boolean;
  /** People per m² the access level supports (densityFit.supportedDensityAt). */
  supportedDensity(access: number): number;
  /** Min distance (m) a cut must keep from every existing point. */
  spacingAt(access: number): number;
  /** Samples below this max(res, com) access are outside the lattice. */
  minAccess: number;
}

export interface AnchorIndex {
  nearest(c: Coordinate): { id: string; location: Coordinate } | null;
  /** All anchors within `radiusM` of `c`. */
  within(c: Coordinate, radiusM: number): { id: string; location: Coordinate }[];
}

/** Spatial grid over anchors; expanding-ring nearest with id tie-break. */
export function createAnchorIndex(
  anchors: { id: string; location: Coordinate }[],
): AnchorIndex {
  const CELL_M = 500;
  const refLat = anchors[0]?.location[1] ?? 0;
  const mPerLon = M_PER_DEG_LAT * Math.max(0.2, Math.cos((refLat * Math.PI) / 180));
  const cellOf = (c: Coordinate): { cx: number; cy: number } => ({
    cx: Math.floor((c[0] * mPerLon) / CELL_M),
    cy: Math.floor((c[1] * M_PER_DEG_LAT) / CELL_M),
  });
  const grid = new Map<string, { id: string; location: Coordinate }[]>();
  for (const a of anchors) {
    const { cx, cy } = cellOf(a.location);
    const k = `${cx},${cy}`;
    const b = grid.get(k);
    if (b) b.push(a); else grid.set(k, [a]);
  }
  const scanRings = (c: Coordinate, maxRing: number): { id: string; location: Coordinate } | null => {
    const { cx, cy } = cellOf(c);
    let best: { id: string; location: Coordinate } | null = null;
    let bestD = Infinity;
    for (let r = 0; r <= maxRing; r++) {
      // Distance-sound stop: any anchor in a ring-r cell is at least (r−1)·CELL_M
      // from the query (which may sit anywhere in its own cell), so once that
      // lower bound reaches the best distance found, no farther ring can win.
      // (A fixed "first hit + 1" guard is NOT sound: a diagonal ring-r anchor can
      // be √2·(r+1) cells away while a nearer one sits axially in ring r+2.)
      if (best !== null && (r - 1) * CELL_M >= bestD) break;
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          for (const a of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
            const d = haversine(c, a.location);
            if (d < bestD || (d === bestD && best !== null && a.id < best.id)) {
              bestD = d;
              best = a;
            }
          }
        }
      }
    }
    return best;
  };
  return {
    nearest: (c) => (anchors.length === 0 ? null : scanRings(c, 4000)),
    within: (c, radiusM) => {
      const { cx, cy } = cellOf(c);
      const ring = Math.ceil(radiusM / CELL_M) + 1;
      const out: { id: string; location: Coordinate }[] = [];
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          for (const a of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (haversine(c, a.location) <= radiusM) out.push(a);
          }
        }
      }
      return out;
    },
  };
}

export interface CellIntegral {
  /** People the cell's access-positive area can support. */
  supportedMass: number;
  /** Access-weighted centroid of the cell, or null if it holds no samples. */
  centroid: Coordinate | null;
  /**
   * People a single materialized point would hold at the anchor's access
   * (massAt = supportedDensity·spacing²). The "one point" reference the engine
   * measures a GREENFIELD cell's supported mass against — an anchor with no
   * native baseline cap (undeveloped land) can then split on access alone.
   */
  pointCap: number;
}

interface LatticeFrame {
  stepLon: number;
  stepLat: number;
}

function latticeFrame(latticeM: number, refLat: number): LatticeFrame {
  const mPerLon = M_PER_DEG_LAT * Math.max(0.2, Math.cos((refLat * Math.PI) / 180));
  return { stepLon: latticeM / mPerLon, stepLat: latticeM / M_PER_DEG_LAT };
}

/** Visit each unique lattice sample within `radiusM` of any center, in order. */
function enumerateSamples(
  centers: Coordinate[],
  radiusM: number,
  latticeM: number,
  visit: (sample: Coordinate) => void,
): void {
  if (centers.length === 0) return;
  const frame = latticeFrame(latticeM, centers[0][1]);
  const seen = new Set<string>();
  for (const c of centers) {
    const i0 = Math.floor((c[0] - radiusM * frame.stepLon / latticeM) / frame.stepLon);
    const i1 = Math.ceil((c[0] + radiusM * frame.stepLon / latticeM) / frame.stepLon);
    const j0 = Math.floor((c[1] - radiusM * frame.stepLat / latticeM) / frame.stepLat);
    const j1 = Math.ceil((c[1] + radiusM * frame.stepLat / latticeM) / frame.stepLat);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = `${i},${j}`;
        if (seen.has(k)) continue;
        const sample: Coordinate = [(i + 0.5) * frame.stepLon, (j + 0.5) * frame.stepLat];
        // Outside THIS center's disc: leave it unmarked so a later center whose
        // disc contains it can still claim it. Marking seen here would silently
        // drop box-corner samples that belong to another station's catchment.
        if (haversine(sample, c) > radiusM) continue;
        seen.add(k);
        visit(sample);
      }
    }
  }
}

export interface IntegrateOpts {
  anchors: { id: string; location: Coordinate }[];
  /** Routed-station coordinates — the lattice domain is their catchment union. */
  stations: Coordinate[];
  catchmentM: number;
  latticeM: number;
  deps: LatticeDeps;
}

export function integrateCells(opts: IntegrateOpts): Map<string, CellIntegral> {
  const { deps } = opts;
  const index = createAnchorIndex(opts.anchors);
  const cells = new Map<string, CellIntegral & { wSum: number; lonSum: number; latSum: number }>();
  const sampleArea = opts.latticeM * opts.latticeM;
  enumerateSamples(opts.stations, opts.catchmentM, opts.latticeM, (sample) => {
    const a = deps.accessAt(sample);
    const access = Math.max(a.res, a.com);
    if (access < deps.minAccess) return;
    const anchor = index.nearest(sample);
    if (!anchor) return;
    const density = deps.supportedDensity(access);
    let cell = cells.get(anchor.id);
    if (!cell) {
      // pointCap at the anchor's own access: massAt = supportedDensity·spacing².
      const aAcc = deps.accessAt(anchor.location);
      const acc = Math.max(aAcc.res, aAcc.com);
      const sp = deps.spacingAt(acc);
      cell = {
        supportedMass: 0, centroid: null, pointCap: deps.supportedDensity(acc) * sp * sp,
        wSum: 0, lonSum: 0, latSum: 0,
      };
      cells.set(anchor.id, cell);
    }
    cell.supportedMass += density * sampleArea;
    cell.wSum += density;
    cell.lonSum += density * sample[0];
    cell.latSum += density * sample[1];
  });
  const out = new Map<string, CellIntegral>();
  for (const [id, c] of cells) {
    out.set(id, {
      supportedMass: c.supportedMass,
      centroid: c.wSum > 0 ? [c.lonSum / c.wSum, c.latSum / c.wSum] : null,
      pointCap: c.pointCap,
    });
  }
  return out;
}

export interface FindCutOpts {
  anchorId: string;
  centroid: Coordinate;
  anchors: { id: string; location: Coordinate }[];
  latticeM: number;
  /**
   * Min clearance (m) a cut must keep from water/airport: a candidate is rejected
   * if water/airport is within this radius (8-point ring test), not only if the
   * point itself is on it — so new points don't sit right at a shoreline or
   * runway edge. 0 = point-only test (legacy).
   */
  clearanceM?: number;
  deps: LatticeDeps;
}

/** Per-gate rejection tally for a findCut call (diagnostic: why no sample won). */
export interface CutRejects {
  samples: number;  // candidate lattice samples visited
  floor: number;    // rejected: access < minAccess
  blocked: number;  // rejected: the candidate's own cell is water/airport
  outCell: number;  // rejected: nearest anchor isn't this cell (search disc off the cell)
  spacing: number;  // rejected: within spacingAt of an existing point (no room)
  clearance: number; // rejected: water/airport within the clearance margin (disc)
}

/**
 * The cut location for a splitting cell: the valid lattice sample nearest the
 * access-weighted centroid. Valid = access ≥ minAccess, dry, inside the cell
 * (nearest anchor is the splitting anchor), and ≥ spacingAt(access) from every
 * existing point. Null when nothing qualifies (the cell cannot split yet).
 *
 * KNOWN BOUND: the search disc (searchR below) is a heuristic and may not cover
 * a very elongated cell's far reaches — such a cell can sit at threshold with a
 * permanently null cut until its geometry or access changes. Accepted: bounded
 * cost beats exhaustive cell scans, and elongated starved cells shrink as
 * neighbors split.
 */
export function findCut(opts: FindCutOpts, reject?: CutRejects): Coordinate | null {
  const { deps } = opts;
  const index = createAnchorIndex(opts.anchors);
  const anchor = opts.anchors.find((a) => a.id === opts.anchorId);
  if (!anchor) return null;
  const spacingHint = deps.spacingAt(Math.max(
    deps.accessAt(opts.centroid).res, deps.accessAt(opts.centroid).com,
  ));
  const searchR = Math.max(
    3 * spacingHint,
    2 * haversine(anchor.location, opts.centroid),
    4 * opts.latticeM,
  );
  const clearanceM = opts.clearanceM ?? 0;
  let best: Coordinate | null = null;
  let bestD = Infinity;
  enumerateSamples([opts.centroid], searchR, opts.latticeM, (sample) => {
    if (reject) reject.samples++;
    const a = deps.accessAt(sample);
    const access = Math.max(a.res, a.com);
    if (access < deps.minAccess) { if (reject) reject.floor++; return; }
    if (deps.blockedWithin(sample, 0)) { if (reject) reject.blocked++; return; } // on water/airport
    if (index.nearest(sample)?.id !== opts.anchorId) { if (reject) reject.outCell++; return; } // outside the cell
    const minDist = deps.spacingAt(access);
    for (const other of index.within(sample, minDist)) {
      if (haversine(sample, other.location) < minDist) { if (reject) reject.spacing++; return; }
    }
    // Clearance last (the disc scan is the most work, so only otherwise-valid
    // candidates pay for it): reject a point with water/airport within the margin.
    if (clearanceM > 0 && deps.blockedWithin(sample, clearanceM)) { if (reject) reject.clearance++; return; }
    const d = haversine(sample, opts.centroid);
    if (d < bestD) { bestD = d; best = sample; }
  });
  return best;
}
