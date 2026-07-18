/**
 * Transit-network graph with REAL weights from the modding API (spec §2, §facts 4).
 * Route-aware nodes so boarding wait is paid once per boarding, not per segment:
 * a street node per station, a platform node per (route, stop).
 *
 * Weights: ride = stComboTimings deltas (fallback distance ÷ NOMINAL_TRANSIT_SPEED);
 * boarding = peak-service headway/2 from route-intrinsic schedule data — NEVER
 * getTrains(), which samples the current demand period (spec §facts 4);
 * transfer = the game's own nearbyStations walk times; interchange = constant.
 */
import type { Coordinate } from '../types/core';
import type { Route, Station, StationGroup } from '../types/game-state';
import type { InducedDemandConfig } from './config';
import { haversine } from './geo';

export interface GraphEdge { to: number; s: number }

export interface StationGraph {
  /** Street-node i ↔ stationIds[i]; platforms are nodes ≥ stationIds.length. */
  stationIds: string[];
  coords: Coordinate[];
  streetIndex: Map<string, number>;
  nodeCount: number;
  adj: GraphEdge[][];
}

/** Cycle time exactly as the game's getRouteCycleTime: last timing arrival. */
export function routeCycleSeconds(route: Route): number {
  const t = route.stComboTimings;
  return t && t.length > 0 ? t[t.length - 1].arrivalTime : 0;
}

/**
 * Peak boarding wait for a route (seconds). Timetable mode → min headway/2;
 * legacy trainSchedule counts (they ARE counts — decompile-verified) →
 * (cycle ÷ peak trains)/2; no data → DEFAULT_WAIT_SECONDS.
 */
export function peakWaitSeconds(route: Route, cycleSeconds: number, cfg: InducedDemandConfig): number {
  const clamp = (w: number): number => Math.max(cfg.MIN_WAIT_SECONDS, w);
  const tt = route.timetableSchedule;
  if (tt?.mode === 'timetable' && tt.periods?.length) {
    const headways = tt.periods.map((p) => p.headwaySeconds).filter((h) => h > 0);
    if (headways.length > 0) return clamp(Math.min(...headways) / 2);
  }
  const ts = route.trainSchedule;
  const counts = [
    ts?.highDemand ?? 0, ts?.mediumDemand ?? 0, ts?.lowDemand ?? 0,
    ts?.veryLowDemand ?? 0, route.idealTrainCount ?? 0,
  ];
  const peak = Math.max(...counts);
  if (peak > 0 && cycleSeconds > 0) return clamp(cycleSeconds / peak / 2);
  return cfg.DEFAULT_WAIT_SECONDS;
}

/**
 * Ride seconds between consecutive stops. Matches each stop's timing entry via
 * `stNodeId ∈ station.stNodeIds`; if any stop lacks a timing, the whole route
 * falls back to distance ÷ NOMINAL_TRANSIT_SPEED (structure unchanged).
 */
export function routeRideSeconds(
  route: Route,
  stops: Station[],
  cfg: InducedDemandConfig,
): number[] {
  const timings = route.stComboTimings ?? [];
  const perStop = stops.map((st) => timings.find((t) => st.stNodeIds.includes(t.stNodeId)));
  const rides: number[] = [];
  const usable = perStop.every((t) => t !== undefined);
  for (let i = 0; i + 1 < stops.length; i++) {
    if (usable) {
      const ride = perStop[i + 1]!.arrivalTime - perStop[i]!.departureTime;
      rides.push(Math.max(15, ride));
    } else {
      rides.push(haversine(stops[i].coords, stops[i + 1].coords) / cfg.NOMINAL_TRANSIT_SPEED);
    }
  }
  return rides;
}

export function buildStationGraph(
  routes: Route[],
  stations: Station[],
  groups: StationGroup[],
  cfg: InducedDemandConfig,
): StationGraph {
  const stationIds = stations.map((s) => s.id);
  const coords = stations.map((s) => s.coords);
  const streetIndex = new Map(stationIds.map((id, i) => [id, i]));
  const adj: GraphEdge[][] = stationIds.map(() => []);
  let nodeCount = stationIds.length;
  const addNode = (): number => { adj.push([]); return nodeCount++; };
  const edge = (a: number, b: number, s: number): void => { adj[a].push({ to: b, s }); };

  // Ride + boarding edges per live route.
  for (const route of routes) {
    if (route.tempParentId != null) continue;
    const stops = (route.stations ?? []).filter((s) => streetIndex.has(s.id));
    if (stops.length < 2) continue;
    const wait = peakWaitSeconds(route, routeCycleSeconds(route), cfg);
    const rides = routeRideSeconds(route, stops, cfg);
    const platforms = stops.map((st) => {
      const p = addNode();
      const street = streetIndex.get(st.id)!;
      edge(street, p, wait); // board
      edge(p, street, 0);    // alight
      return p;
    });
    for (let i = 0; i + 1 < platforms.length; i++) {
      edge(platforms[i], platforms[i + 1], rides[i]);
      edge(platforms[i + 1], platforms[i], rides[i]); // service assumed bidirectional
    }
  }

  // Transfer walks (the game's own nearbyStations basis).
  for (const st of stations) {
    const a = streetIndex.get(st.id)!;
    for (const nb of st.nearbyStations ?? []) {
      const b = streetIndex.get(nb.stationId);
      if (b !== undefined && b !== a) edge(a, b, nb.walkingTime);
    }
  }

  // Interchange groups: same complex, cheap fixed transfer.
  for (const g of groups) {
    for (const idA of g.stationIds) {
      for (const idB of g.stationIds) {
        if (idA === idB) continue;
        const a = streetIndex.get(idA);
        const b = streetIndex.get(idB);
        if (a !== undefined && b !== undefined) edge(a, b, cfg.INTERCHANGE_SECONDS);
      }
    }
  }

  return { stationIds, coords, streetIndex, nodeCount, adj };
}
