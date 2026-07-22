/**
 * Offline-harness interchange format. `buildDump` (mod side) serializes the
 * live demand + network to plain JSON the user downloads; `parseDump` (harness
 * side) reconstructs the exact `DemandData` / `Station[]` / `Route[]` the model
 * functions consume — so `scripts/simulate.ts` runs the SAME engine the game
 * runs, headlessly. Only the fields the pipeline actually reads are carried.
 */
import type {
  DemandData, DemandPoint, Station, Route, StationGroup, ModeChoiceStats,
} from '../types/game-state';
import type { OceanDepthFile } from '../game/waterIndex';
import type { AirportFeatureCollection } from '../game/airportIndex';

export interface DumpPoint {
  id: string; lon: number; lat: number; residents: number; jobs: number;
  /** Mode split snapshot (drives score's modeFactor); harness holds it static. */
  resMode?: ModeChoiceStats;
  jobMode?: ModeChoiceStats;
}
export interface DumpStation {
  id: string; lon: number; lat: number; buildType: string;
  routeIds: string[]; stNodeIds: string[];
  nearby: { stationId: string; walkingTime: number }[];
}
export interface DumpRoute {
  id: string;
  /** Ordered stop station ids (consecutive = a ride segment). */
  stationIds: string[];
  stComboTimings?: unknown;
  trainSchedule?: unknown;
  timetableSchedule?: unknown;
  idealTrainCount?: number;
}
export interface DumpFile {
  version: 1;
  city: string;
  points: DumpPoint[];
  stations: DumpStation[];
  routes: DumpRoute[];
  groups: { id: string; stationIds: string[] }[];
  /**
   * Raw per-city placement masks (optional), so the offline harness can reject
   * cuts on/near water and airports exactly like the game — otherwise it runs
   * with masking off. Large (city water polygons), so only present when dumped.
   */
  water?: OceanDepthFile;
  airport?: AirportFeatureCollection;
}

const ZERO_MODE: ModeChoiceStats = { walking: 0, driving: 0, transit: 0, unknown: 0 };

/** Mod side: capture the live demand + network into a downloadable dump. */
export function buildDump(
  city: string,
  points: Iterable<DemandPoint>,
  stations: Station[],
  routes: Route[],
  groups: StationGroup[],
  water?: OceanDepthFile | null,
  airport?: AirportFeatureCollection | null,
): DumpFile {
  const dumpPoints: DumpPoint[] = [];
  for (const p of points) {
    dumpPoints.push({
      id: p.id, lon: p.location[0], lat: p.location[1],
      residents: p.residents, jobs: p.jobs,
      resMode: p.residentModeShare, jobMode: p.workerModeShare,
    });
  }
  return {
    version: 1,
    city,
    points: dumpPoints,
    stations: stations.map((s) => ({
      id: s.id, lon: s.coords[0], lat: s.coords[1], buildType: s.buildType,
      routeIds: s.routeIds ?? [], stNodeIds: s.stNodeIds ?? [],
      nearby: (s.nearbyStations ?? []).map((n) => ({ stationId: n.stationId, walkingTime: n.walkingTime })),
    })),
    routes: routes.map((r) => ({
      id: r.id,
      stationIds: (r.stations ?? []).map((s) => s.id),
      stComboTimings: r.stComboTimings,
      trainSchedule: r.trainSchedule,
      timetableSchedule: r.timetableSchedule,
      idealTrainCount: r.idealTrainCount,
    })),
    groups: groups.map((g) => ({ id: g.id, stationIds: g.stationIds })),
    ...(water ? { water } : {}),
    ...(airport ? { airport } : {}),
  };
}

export interface ParsedDump {
  city: string;
  dd: DemandData;
  stations: Station[];
  routes: Route[];
  groups: StationGroup[];
  /** Raw masks from the dump (null when absent); the harness scan-fills the
   *  blocked raster from these, matching the game. */
  waterFile: OceanDepthFile | null;
  airportFile: AirportFeatureCollection | null;
}

/** Harness side: reconstruct the model inputs from a dump. */
export function parseDump(f: DumpFile): ParsedDump {
  const points = new Map<string, DemandPoint>();
  for (const p of f.points) {
    points.set(p.id, {
      id: p.id, location: [p.lon, p.lat], residents: p.residents, jobs: p.jobs, popIds: [],
      residentModeShare: p.resMode ?? ZERO_MODE,
      workerModeShare: p.jobMode ?? ZERO_MODE,
    });
  }
  const dd: DemandData = { points, popsMap: new Map() };

  const stations: Station[] = f.stations.map((s) => ({
    id: s.id, name: s.id, coords: [s.lon, s.lat], trackIds: [], trackGroupId: '',
    buildType: s.buildType, stNodeIds: s.stNodeIds, routeIds: s.routeIds, createdAt: 0,
    nearbyStations: s.nearby.map((n) => ({ stationId: n.stationId, walkingTime: n.walkingTime })),
  } as unknown as Station));
  const byId = new Map(stations.map((s) => [s.id, s]));
  // The game API leaves `route.stations` empty; the stop order lives in
  // `stComboTimings` (by stNodeIndex), each keyed to a station via its stNodeIds.
  const byStNode = new Map<string, Station>();
  f.stations.forEach((ds, i) => { for (const n of ds.stNodeIds ?? []) byStNode.set(n, stations[i]); });

  const routes: Route[] = f.routes.map((r) => {
    let stops: Station[];
    if (r.stationIds.length > 0) {
      stops = r.stationIds.map((id) => byId.get(id)).filter((s): s is Station => !!s);
    } else {
      const timings = (r.stComboTimings as { stNodeId: string; stNodeIndex: number }[] | undefined) ?? [];
      const seen = new Set<string>();
      stops = [];
      for (const t of [...timings].sort((a, b) => a.stNodeIndex - b.stNodeIndex)) {
        const st = byStNode.get(t.stNodeId);
        if (st && !seen.has(st.id)) { seen.add(st.id); stops.push(st); }
      }
    }
    return {
      id: r.id, tempParentId: null, stations: stops,
      stComboTimings: r.stComboTimings, trainSchedule: r.trainSchedule,
      timetableSchedule: r.timetableSchedule, idealTrainCount: r.idealTrainCount,
    } as unknown as Route;
  });

  const groups: StationGroup[] = f.groups.map((g) => ({ id: g.id, stationIds: g.stationIds }));
  return {
    city: f.city, dd, stations, routes, groups,
    waterFile: f.water ?? null,
    airportFile: f.airport ?? null,
  };
}
