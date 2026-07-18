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
  isWater(c: Coordinate): boolean;
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
  const ringHas = (cx: number, cy: number, r: number): boolean => {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (grid.has(`${cx + dx},${cy + dy}`)) return true;
      }
    }
    return false;
  };
  const scanRings = (c: Coordinate, maxRing: number): { id: string; location: Coordinate } | null => {
    const { cx, cy } = cellOf(c);
    let firstHit = -1;
    let best: { id: string; location: Coordinate } | null = null;
    let bestD = Infinity;
    for (let r = 0; r <= maxRing; r++) {
      if (firstHit >= 0 && r > firstHit + 1) break; // ring r+1 guard covers diagonal cases
      if (!ringHas(cx, cy, r)) continue;
      if (firstHit < 0) firstHit = r;
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
      cell = { supportedMass: 0, centroid: null, wSum: 0, lonSum: 0, latSum: 0 };
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
    });
  }
  return out;
}

export interface FindCutOpts {
  anchorId: string;
  centroid: Coordinate;
  anchors: { id: string; location: Coordinate }[];
  latticeM: number;
  deps: LatticeDeps;
}

/**
 * The cut location for a splitting cell: the valid lattice sample nearest the
 * access-weighted centroid. Valid = access ≥ minAccess, dry, inside the cell
 * (nearest anchor is the splitting anchor), and ≥ spacingAt(access) from every
 * existing point. Null when nothing qualifies (the cell cannot split yet).
 */
export function findCut(opts: FindCutOpts): Coordinate | null {
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
  let best: Coordinate | null = null;
  let bestD = Infinity;
  enumerateSamples([opts.centroid], searchR, opts.latticeM, (sample) => {
    const a = deps.accessAt(sample);
    const access = Math.max(a.res, a.com);
    if (access < deps.minAccess) return;
    if (deps.isWater(sample)) return;
    if (index.nearest(sample)?.id !== opts.anchorId) return; // outside the cell
    const minDist = deps.spacingAt(access);
    for (const other of index.within(sample, minDist)) {
      if (haversine(sample, other.location) < minDist) return;
    }
    const d = haversine(sample, opts.centroid);
    if (d < bestD) { bestD = d; best = sample; }
  });
  return best;
}
