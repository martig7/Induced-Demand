import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Route, Station } from '../types/game-state';
import type { DemandPoint } from '../types/game-state';
import { buildStationGraph } from './stationGraph';
import {
  dijkstraStreetTimes, stationMasses, computeOpportunities, accessAt,
  type StationOpportunity,
} from './opportunity';
import { DEFAULT_CONFIG } from './config';

const cfg = DEFAULT_CONFIG;

function station(id: string, lon: number, lat: number, routeIds: string[], stNodeIds: string[]): Station {
  return {
    id, name: id, coords: [lon, lat], trackIds: [], trackGroupId: '', buildType: 'constructed',
    stNodeIds, routeIds, createdAt: 0, nearbyStations: [],
  } as unknown as Station;
}

function point(id: string, lon: number, lat: number, residents: number, jobs: number): DemandPoint {
  return {
    id, location: [lon, lat], residents, jobs, popIds: [],
    residentModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
    workerModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
  };
}

// A —(r1: 100 s)— B. Jobs concentrated at B, residents at A.
const A = station('A', 0, 0, ['r1'], ['nA']);
const B = station('B', 0.05, 0, ['r1'], ['nB']);
const r1 = {
  id: 'r1',
  stations: [A, B],
  stComboTimings: [
    { stNodeId: 'nA', stNodeIndex: 0, arrivalTime: 0, departureTime: 0 },
    { stNodeId: 'nB', stNodeIndex: 1, arrivalTime: 100, departureTime: 110 },
  ],
  trainSchedule: { highDemand: 4, mediumDemand: 1, lowDemand: 1 },
} as unknown as Route;

const pts = [
  point('p1', 0.0005, 0, 5000, 0),   // residents at A
  point('p2', 0.0505, 0, 0, 5000),   // jobs at B
];

test('dijkstraStreetTimes: reaches the other street via wait+ride', () => {
  const g = buildStationGraph([r1], [A, B], [], cfg);
  const t = dijkstraStreetTimes(g, g.streetIndex.get('A')!);
  assert.equal(t[g.streetIndex.get('A')!], 0);
  // wait 100/4/2=12.5 → clamped to MIN_WAIT 30; ride 100 → 130
  assert.ok(Math.abs(t[g.streetIndex.get('B')!] - 130) < 1e-9, `got ${t[g.streetIndex.get('B')!]}`);
});

test('stationMasses: sums residents/jobs within catchment', () => {
  const m = stationMasses([A, B], pts, cfg);
  assert.equal(m.get('A')!.res, 5000);
  assert.equal(m.get('A')!.jobs, 0);
  assert.equal(m.get('B')!.jobs, 5000);
});

test('computeOpportunities: A sees jobs through the network, B sees residents', () => {
  const g = buildStationGraph([r1], [A, B], [], cfg);
  const opps = computeOpportunities(g, stationMasses([A, B], pts, cfg), cfg);
  const oA = opps.find((o) => o.stationId === 'A')!;
  const oB = opps.find((o) => o.stationId === 'B')!;
  assert.ok(oA.oJobs > 0.5, `A reaches the job mass (got ${oA.oJobs})`);
  assert.ok(oB.oRes > 0.5, `B reaches the resident mass (got ${oB.oRes})`);
  // A has no local jobs: its jobs-opportunity is purely network-decayed, so < B's local-ish view
  assert.ok(oA.oJobs < oB.oJobs + 1e-9);
});

test('computeOpportunities: frozen (native) totals raise Ô vs live totals', () => {
  const g = buildStationGraph([r1], [A, B], [], cfg);
  const masses = stationMasses([A, B], pts, cfg);
  const live = computeOpportunities(g, masses, cfg);
  // A smaller frozen denominator (native totals before induced growth inflated
  // the live totals) must raise Ô — the curative effect of the freeze.
  const nativeTotals = { res: 3000, jobs: 3000 }; // < live totals (5000 each)
  const frozen = computeOpportunities(g, masses, cfg, nativeTotals);
  const liveB = live.find((o) => o.stationId === 'B')!;
  const frozenB = frozen.find((o) => o.stationId === 'B')!;
  assert.ok(frozenB.oRes >= liveB.oRes, `frozen ${frozenB.oRes} ≥ live ${liveB.oRes}`);
  assert.ok(frozenB.oRes > liveB.oRes || liveB.oRes === 1, 'strictly higher unless clamped');
  for (const o of frozen) { assert.ok(o.oRes <= 1 && o.oJobs <= 1, 'still clamped at 1'); }
});

test('computeOpportunities: a well-connected station with NO demand still scores (bootstrap)', () => {
  const g = buildStationGraph([r1], [A, B], [], cfg);
  const opps = computeOpportunities(g, stationMasses([A, B], [], cfg), cfg); // empty city
  const oA = opps.find((o) => o.stationId === 'A')!;
  // The network-reach half gives positive Ô even with zero reachable demand, so a
  // blank area on a good line can bootstrap its cap. Bounded by the reach weight.
  assert.ok(oA.oJobs > 0 && oA.oRes > 0, `blank-but-connected scores (${oA.oJobs}, ${oA.oRes})`);
  assert.ok(oA.oJobs <= cfg.ACCESS_TRANSIT_WEIGHT + 1e-9 && oA.oRes <= cfg.ACCESS_TRANSIT_WEIGHT + 1e-9);
});

test('accessAt: directional — near job-dense B, residential access (to jobs) dominates', () => {
  const g = buildStationGraph([r1], [A, B], [], cfg);
  const opps = computeOpportunities(g, stationMasses([A, B], pts, cfg), cfg);
  const acc = accessAt([0.0502, 0], opps, cfg);
  // B's own jobs are reachable at zero cost (self-inclusion): oJobs_B = 1 > oRes_B,
  // so a location by B is more attractive for residences than for more jobs.
  assert.ok(acc.res > acc.com, `res ${acc.res} com ${acc.com}`);
  assert.ok(acc.res > 0 && acc.res <= 1);
});

test('accessAt: walkProx tapers linearly across the full catchment, 0 past the edge', () => {
  const opp: StationOpportunity = { stationId: 'S', coords: [0, 0], oJobs: 1, oRes: 0 };
  const at = (m: number): number => accessAt([0, m / 111320], [opp], cfg).res; // ~m metres north
  const near = at(100), mid = at(900), edge = at(1700), outside = at(1900);
  assert.ok(near > mid && mid > edge, `monotone taper: ${near} > ${mid} > ${edge}`);
  assert.ok(Math.abs(mid - 0.5) < 0.02, `mid-catchment ≈ 0.5 (linear), got ${mid}`);
  assert.ok(edge > 0 && edge < 0.15, `near-edge small but nonzero, got ${edge}`);
  assert.equal(outside, 0, 'past the 1800 m catchment → 0');
});

test('accessAt: out of catchment → zero', () => {
  const g = buildStationGraph([r1], [A, B], [], cfg);
  const opps = computeOpportunities(g, stationMasses([A, B], pts, cfg), cfg);
  assert.deepEqual(accessAt([2, 2], opps, cfg), { res: 0, com: 0 });
});

// --- access index equivalence ------------------------------------------------

import { buildAccessIndex } from './opportunity';

test('accessIndex: float-identical to brute-force accessAt across scattered locations', () => {
  // Mid-latitude fixture (~lat 40) exercises the cos-scaled keying: many
  // stations spread wider than one catchment, queries scattered around them.
  const stations: Station[] = [];
  const opps = [] as ReturnType<typeof computeOpportunities>;
  let s = 7;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < 40; i++) {
    const lon = -74 + rnd() * 0.3;
    const lat = 40 + rnd() * 0.3;
    opps.push({ stationId: `s${i}`, coords: [lon, lat], oJobs: rnd(), oRes: rnd() });
  }
  void stations;
  const idx = buildAccessIndex(opps, cfg);
  for (let q = 0; q < 400; q++) {
    const loc: [number, number] = [-74 + rnd() * 0.3, 40 + rnd() * 0.3];
    assert.deepEqual(idx.at(loc), accessAt(loc, opps, cfg), `query ${q} @ ${loc}`);
  }
});

test('accessIndex: station just inside the catchment radius in an adjacent cell is found', () => {
  const radiusM = cfg.CATCHMENT_SECONDS * cfg.WALK_SPEED;
  // Place a station ~99% of the radius due EAST of the query, at lat 40 where
  // unscaled lon keying used to shrink cells and miss exactly this neighbor.
  const lat = 40;
  const degPerMeterLon = 1 / (111194.9 * Math.cos((lat * Math.PI) / 180));
  const stationLon = 0.99 * radiusM * degPerMeterLon;
  const opps = [{ stationId: 'edge', coords: [stationLon, lat] as [number, number], oJobs: 1, oRes: 1 }];
  const idx = buildAccessIndex(opps, cfg);
  const got = idx.at([0, lat]);
  const want = accessAt([0, lat], opps, cfg);
  assert.deepEqual(got, want);
  assert.ok(got.res > 0, 'edge station must be visible through the index');
});
