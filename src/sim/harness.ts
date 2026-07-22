/**
 * Headless simulation harness: assembles the field from plain inputs and runs
 * the SAME `runDay` engine the game runs, so results match the mod exactly.
 * Mirrors `main.ts`'s field wiring (the pure functions are the shared source of
 * truth; only the input plumbing differs — here it comes from a dump, not the
 * game API). Water masking is off (isWater → false) and mode shares are the
 * static snapshot from the dump.
 */
import type { Coordinate } from '../types/core';
import type { DemandData, Station, Route, StationGroup } from '../types/game-state';
import type { InducedDemandConfig } from '../model/config';
import { DEFAULT_CONFIG } from '../model/config';
import { buildStationGraph } from '../model/stationGraph';
import {
  stationMasses, computeOpportunities, buildAccessIndex, type AccessIndex,
} from '../model/opportunity';
import {
  fitDensity, spacingAt, supportedDensityAt, massResAt, massJobAt, type DensityFit,
} from '../model/densityFit';
import { buildPointSites, type Site } from '../model/field';
import { integrateCells, findCut, type CellIntegral, type LatticeDeps } from '../model/lattice';
import { buildJobDensity } from '../model/agglomeration';
import { buildPopDensity } from '../model/localDensity';
import { runDay, type RunDayDeps } from '../model/engine';
import { newLedger, captureBaselines } from '../model/ledger';
import { makeRng } from '../model/gravity';
import { DEFAULT_SLOT_SET } from '../model/commuteTimes';
import { DEFAULT_DRIVING_MODEL } from '../model/drivingModel';
import { INDUCED_POINT_PREFIX } from '../model/inducedId';
import type { ParsedDump } from './dump';

/** The game's induction gate: built (constructed) stations carrying a live route. */
function inductionStations(stations: Station[]): Station[] {
  return stations.filter((s) => s.buildType === 'constructed' && (s.routeIds?.length ?? 0) > 0);
}

function nativeTotals(stations: Station[], dd: DemandData, cfg: InducedDemandConfig): { res: number; jobs: number } {
  let res = 0, jobs = 0;
  for (const m of stationMasses(stations, dd.points.values(), cfg).values()) { res += m.res; jobs += m.jobs; }
  return { res, jobs };
}

function latticeDeps(accessIdx: AccessIndex, fit: DensityFit, cfg: InducedDemandConfig): LatticeDeps {
  return {
    accessAt: (c) => accessIdx.at(c),
    isWater: () => false,
    isAirport: () => false,
    supportedDensity: (a) => supportedDensityAt(fit, a),
    spacingAt: (a) => spacingAt(fit, a),
    minAccess: cfg.MIN_SITE_ACCESS,
  };
}

/** One full field build over the current demand (recomputed each sim day). */
function buildField(
  dd: DemandData, stations: Station[], routes: Route[], groups: StationGroup[],
  frozen: { res: number; jobs: number }, cfg: InducedDemandConfig,
): { sites: Site[]; deps: RunDayDeps } {
  const graph = buildStationGraph(routes, stations, groups, cfg);
  const opps = computeOpportunities(graph, stationMasses(stations, dd.points.values(), cfg), cfg, frozen);
  const accessIdx = buildAccessIndex(opps, cfg);
  const fit = fitDensity([...dd.points.values()].map((p) => {
    const a = accessIdx.at(p.location);
    return { location: p.location, residents: p.residents, jobs: p.jobs, access: Math.max(a.res, a.com) };
  }), cfg);
  const sites = buildPointSites(dd, (c) => accessIdx.at(c));
  const catchmentM = cfg.CATCHMENT_SECONDS * cfg.WALK_SPEED;
  const routedCoords = stations.filter((s) => (s.routeIds?.length ?? 0) > 0).map((s) => s.coords);
  const anchorsOf = (): { id: string; location: Coordinate }[] =>
    [...dd.points.values()].map((p) => ({ id: p.id, location: p.location }));
  const cells = integrateCells({
    anchors: anchorsOf(), stations: routedCoords, catchmentM,
    latticeM: cfg.LATTICE_M, deps: latticeDeps(accessIdx, fit, cfg),
  });
  const jobDensity = buildJobDensity(dd.points.values(), cfg);
  const popDensity = buildPopDensity(dd.points.values(), cfg.POP_DENSITY_RADIUS_M);
  const deps: RunDayDeps = {
    massResAt: (a, u) => massResAt(fit, a, u, cfg.SPLIT_CAP_QUANTILE_FLOOR),
    massJobAt: (a, u) => massJobAt(fit, a, u, cfg.SPLIT_CAP_QUANTILE_FLOOR),
    jobDensity: (c) => jobDensity.at(c),
    popDensity: (c) => popDensity.at(c),
    cells,
    findCut: (anchorId, centroid) => findCut({
      anchorId, centroid, anchors: anchorsOf(),
      latticeM: cfg.FINDCUT_LATTICE_M, clearanceM: cfg.WATER_CLEARANCE_M,
      deps: latticeDeps(accessIdx, fit, cfg),
    }),
  };
  return { sites, deps };
}

export interface SnapshotPoint {
  id: string; lon: number; lat: number; residents: number; jobs: number; materialized: boolean;
}
export interface Snapshot { day: number; points: SnapshotPoint[]; }
export interface NetworkView {
  stations: { id: string; lon: number; lat: number }[];
  lines: { id: string; coords: [number, number][] }[];
}
export interface SimResult {
  city: string; days: number; before: Snapshot; after: Snapshot; network: NetworkView;
}

function snapshot(dd: DemandData, day: number): Snapshot {
  const points: SnapshotPoint[] = [];
  for (const p of dd.points.values()) {
    points.push({
      id: p.id, lon: p.location[0], lat: p.location[1],
      residents: p.residents, jobs: p.jobs,
      materialized: p.id.startsWith(INDUCED_POINT_PREFIX),
    });
  }
  return { day, points };
}

function buildNetworkView(stations: Station[], routes: Route[]): NetworkView {
  const byId = new Map(stations.map((s) => [s.id, s]));
  return {
    stations: stations.map((s) => ({ id: s.id, lon: s.coords[0], lat: s.coords[1] })),
    lines: routes.map((r) => ({
      id: r.id,
      coords: (r.stations ?? [])
        .map((s) => byId.get(s.id))
        .filter((s): s is Station => !!s)
        .map((s) => [s.coords[0], s.coords[1]] as [number, number]),
    })).filter((l) => l.coords.length >= 2),
  };
}

/** Run `days` of the induced-demand engine over a dump; snapshot before/after. */
export function runSimulation(
  parsed: ParsedDump, days: number, cfg: InducedDemandConfig = DEFAULT_CONFIG,
  onDay?: (day: number, added: number, removed: number, newPoints: number) => void,
): SimResult {
  const { dd, routes, groups, city } = parsed;
  const active = inductionStations(parsed.stations);
  const ledger = newLedger();
  captureBaselines(dd, ledger);
  const frozen = nativeTotals(active, dd, cfg); // baseline totals, frozen for Ô normalization
  const before = snapshot(dd, 0);
  for (let day = 0; day < days; day++) {
    const field = buildField(dd, active, routes, groups, frozen, cfg);
    const r = runDay(dd, field.sites, ledger, cfg, makeRng((day + 1) * 0x9e3779b1 >>> 0),
      field.deps, DEFAULT_SLOT_SET, DEFAULT_DRIVING_MODEL);
    onDay?.(day, r.added, r.removed, r.newPoints);
  }
  return { city, days, before, after: snapshot(dd, days), network: buildNetworkView(active, routes) };
}
