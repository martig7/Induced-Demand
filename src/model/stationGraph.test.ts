import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Route, Station, StationGroup } from '../types/game-state';
import { buildStationGraph, peakWaitSeconds, routeRideSeconds } from './stationGraph';
import { DEFAULT_CONFIG } from './config';

const cfg = DEFAULT_CONFIG;

/** Minimal Station: only fields the graph uses. */
function station(id: string, lon: number, lat: number, routeIds: string[], stNodeIds: string[],
  nearby: { stationId: string; walkingTime: number }[] = []): Station {
  return {
    id, name: id, coords: [lon, lat], trackIds: [], trackGroupId: '', buildType: 'constructed',
    stNodeIds, routeIds, createdAt: 0, nearbyStations: nearby,
  } as unknown as Station;
}

const A = station('A', 0, 0, ['r1'], ['nA']);
const B = station('B', 0.01, 0, ['r1'], ['nB']);
const C = station('C', 0.02, 0, ['r1'], ['nC']);

/** r1: A→B→C with timings; 120 s cycle; 2 peak trains. */
const r1 = {
  id: 'r1',
  stations: [A, B, C],
  stComboTimings: [
    { stNodeId: 'nA', stNodeIndex: 0, arrivalTime: 0, departureTime: 10 },
    { stNodeId: 'nB', stNodeIndex: 1, arrivalTime: 60, departureTime: 70 },
    { stNodeId: 'nC', stNodeIndex: 2, arrivalTime: 120, departureTime: 130 },
  ],
  trainSchedule: { highDemand: 2, mediumDemand: 1, lowDemand: 1 },
} as unknown as Route;

test('peakWaitSeconds: legacy counts → cycle/peak/2', () => {
  // cycle 120, peak 2 → headway 60 → wait 30
  assert.equal(peakWaitSeconds(r1, 120, cfg), 30);
});

test('peakWaitSeconds: timetable mode wins, min headway across periods', () => {
  const tt = {
    ...r1,
    timetableSchedule: { mode: 'timetable', periods: [{ headwaySeconds: 600 }, { headwaySeconds: 240 }] },
  } as unknown as Route;
  assert.equal(peakWaitSeconds(tt, 120, cfg), 120); // 240/2
});

test('peakWaitSeconds: no service data → DEFAULT_WAIT_SECONDS', () => {
  const bare = { id: 'x', stations: [A, B] } as unknown as Route;
  assert.equal(peakWaitSeconds(bare, 0, cfg), cfg.DEFAULT_WAIT_SECONDS);
});

test('routeRideSeconds: from timings (arrival(b) − departure(a))', () => {
  const rides = routeRideSeconds(r1, [A, B, C], cfg);
  assert.deepEqual(rides, [50, 50]); // 60-10, 120-70
});

test('routeRideSeconds: missing timings → distance/NOMINAL_TRANSIT_SPEED', () => {
  const bare = { id: 'x', stations: [A, B] } as unknown as Route;
  const rides = routeRideSeconds(bare, [A, B], cfg);
  assert.equal(rides.length, 1);
  // ~1113 m / 15 m/s ≈ 74 s
  assert.ok(rides[0] > 60 && rides[0] < 90, `got ${rides[0]}`);
});

test('buildStationGraph: ride path costs wait + rides', () => {
  const g = buildStationGraph([r1], [A, B, C], [], cfg);
  assert.equal(g.stationIds.length, 3);
  // street(A) → platform(A,r1) edge exists with boarding wait 30
  const streetA = g.streetIndex.get('A')!;
  const boarding = g.adj[streetA].find((e) => e.s === 30);
  assert.ok(boarding, 'boarding edge with wait 30');
});

test('buildStationGraph: temp routes are skipped', () => {
  const temp = { ...r1, id: 't', tempParentId: 'r1' } as unknown as Route;
  const g = buildStationGraph([temp], [A, B, C], [], cfg);
  // only street nodes + walk edges, no platforms
  assert.equal(g.nodeCount, 3);
});

test('buildStationGraph: interchange group links streets cheaply', () => {
  const groups = [{ id: 'g', stationIds: ['A', 'B'] }] as StationGroup[];
  const g = buildStationGraph([], [A, B], groups, cfg);
  const streetA = g.streetIndex.get('A')!;
  const link = g.adj[streetA].find((e) => e.to === g.streetIndex.get('B') && e.s === cfg.INTERCHANGE_SECONDS);
  assert.ok(link);
});

import { dijkstraStreetTimes } from './opportunity';

test('buildStationGraph: connects a line via stComboTimings when route.stations is empty', () => {
  // The real game leaves route.stations undefined; stops must come from timings.
  const route = { ...r1, stations: undefined } as unknown as Route;
  const g = buildStationGraph([route], [A, B, C], [], cfg);
  const t = dijkstraStreetTimes(g, g.streetIndex.get('A')!);
  const tc = t[g.streetIndex.get('C')!];
  assert.ok(Number.isFinite(tc) && tc > 0, `A reaches C along the line (got ${tc})`);
});

test('buildStationGraph: coordinate walk-transfer links two lines that meet', () => {
  // Line 1 (X–P) and line 2 (Y–Q) share no stop and have no group, but X and Y
  // are ~33 m apart, so a coordinate transfer must connect the lines.
  const X = station('X', 0, 0, ['l1'], ['nX']);
  const P = station('P', 0.02, 0, ['l1'], ['nP']);
  const Y = station('Y', 0.0003, 0, ['l2'], ['nY']);
  const Q = station('Q', 0.0003, 0.02, ['l2'], ['nQ']);
  const line = (id: string, a: string, b: string): Route => ({
    id, stComboTimings: [
      { stNodeId: a, stNodeIndex: 0, arrivalTime: 0, departureTime: 10 },
      { stNodeId: b, stNodeIndex: 1, arrivalTime: 60, departureTime: 70 },
    ], trainSchedule: { highDemand: 2, mediumDemand: 1, lowDemand: 1 },
  } as unknown as Route);
  const g = buildStationGraph([line('l1', 'nX', 'nP'), line('l2', 'nY', 'nQ')], [X, P, Y, Q], [], cfg);
  const t = dijkstraStreetTimes(g, g.streetIndex.get('P')!);
  assert.ok(Number.isFinite(t[g.streetIndex.get('Q')!]), 'P (line 1) reaches Q (line 2) via the X↔Y transfer');
});
