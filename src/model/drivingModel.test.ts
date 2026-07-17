import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDrivingModel, buildDonorBands, bandIndexFor, DEFAULT_DRIVING_BANDS, DEFAULT_DRIVING_MODEL,
} from './drivingModel';
import { buildRoadGraph, type RoadFeatureCollection } from './roadGraph';
import { createRouter, DEFAULT_SPEEDS } from './router';
import type { Coordinate } from '../types/core';
import type { DemandData, DemandPoint, Pop } from '../types/game-state';

const point = (id: string, location: Coordinate): DemandPoint => ({
  id, location, residents: 0, jobs: 0, popIds: [],
  residentModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
  workerModeShare: { walking: 0, driving: 0, transit: 0, unknown: 0 },
});
const pop = (id: string, residenceId: string, jobId: string, drivingDistance: number, drivingSeconds: number): Pop =>
  ({ id, size: 200, residenceId, jobId, drivingDistance, drivingSeconds } as Pop);

/** H and W are ~1.1 km apart; a straight minor road joins them. */
function world(): DemandData {
  return {
    points: new Map([['H', point('H', [0, 0])], ['W', point('W', [0.01, 0])]]),
    popsMap: new Map(),
  };
}
const roads = (): RoadFeatureCollection => ({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: { roadClass: 'minor' },
    geometry: { type: 'LineString', coordinates: [[0, 0], [0.01, 0]] } }],
});

test('bandIndexFor buckets by straight-line distance, including the boundaries', () => {
  assert.equal(bandIndexFor(0), 0);
  assert.equal(bandIndexFor(1999), 0);
  assert.equal(bandIndexFor(2000), 1);
  assert.equal(bandIndexFor(9999), 2);
  assert.equal(bandIndexFor(20000), 4);
  assert.equal(bandIndexFor(1e9), DEFAULT_DRIVING_BANDS.length - 1);
});

test('the constant fallback follows the shipped cities: shorter trips are slower and more circuitous', () => {
  const m = DEFAULT_DRIVING_MODEL;
  const short = m.estimate('induced:1', 'H', 'W', [0, 0], [0.009, 0]);       // ~1 km
  const long = m.estimate('induced:2', 'H', 'W', [0, 0], [0.30, 0]);         // ~33 km
  const speedOf = (e: { distance: number; seconds: number }): number => e.distance / e.seconds;
  assert.ok(speedOf(short) < speedOf(long), 'short trips must be slower');
  assert.ok(short.distance / 1000 > 1.4, 'short trips are more circuitous');
  assert.ok(long.seconds > 0 && Number.isFinite(long.seconds));
});

test('buildDonorBands learns from native pops and ignores our own', () => {
  const dd = world();
  // Native pop: 1.11 km apart, 2 km of road in 200 s → detour 1.8, speed 10 m/s.
  dd.popsMap.set('0', pop('0', 'H', 'W', 2000, 200));
  dd.popsMap.set('induced:9', pop('induced:9', 'H', 'W', 999999, 1)); // must be ignored
  const bands = buildDonorBands(dd);
  const donors = bands[bandIndexFor(1113)];
  assert.equal(donors.length, 1);
  assert.ok(Math.abs(donors[0].speed - 10) < 0.01);
  assert.ok(donors[0].detour > 1.7 && donors[0].detour < 1.9);
});

test('buildDonorBands skips pops with unusable endpoints or times', () => {
  const dd = world();
  dd.popsMap.set('0', pop('0', 'H', 'GONE', 2000, 200));  // endpoint missing
  dd.popsMap.set('1', pop('1', 'H', 'W', 2000, 0));       // no time
  dd.popsMap.set('2', pop('2', 'H', 'H', 2000, 200));     // zero straight-line distance
  assert.deepEqual(buildDonorBands(dd).flat(), []);
});

test('the donor model resamples the real distribution and is deterministic per pop id', () => {
  const dd = world();
  for (let i = 0; i < 40; i++) dd.popsMap.set(String(i), pop(String(i), 'H', 'W', 1500 + i * 20, 150));
  const m = createDrivingModel({ donors: buildDonorBands(dd) });
  const a = m.estimate('induced:1', 'H', 'W', [0, 0], [0.01, 0]);
  const b = m.estimate('induced:1', 'H', 'W', [0, 0], [0.01, 0]);
  assert.deepEqual(a, b, 'same pop id must always give the same estimate');
  const c = m.estimate('induced:2', 'H', 'W', [0, 0], [0.01, 0]);
  assert.ok(a.distance !== c.distance || a.seconds !== c.seconds, 'different pops should vary');
  // Every estimate must come from a real donor: 1500..2280 m of road over 1.11 km.
  for (let i = 0; i < 50; i++) {
    const e = m.estimate(`induced:${i}`, 'H', 'W', [0, 0], [0.01, 0]);
    assert.ok(e.distance >= 1400 && e.distance <= 2400, `got ${e.distance}`);
    assert.ok(Math.abs(e.seconds - e.distance / (e.distance / 150)) < 1e-6);
  }
});

test('a thin donor band widens to a neighbour rather than repeating one donor', () => {
  const dd = world();
  // One 1 km donor (thin), plenty of 8 km donors.
  dd.popsMap.set('0', pop('0', 'H', 'W', 1500, 150));
  dd.points.set('F', point('F', [0.072, 0])); // ~8 km from H
  for (let i = 1; i <= 30; i++) dd.popsMap.set(String(i), pop(String(i), 'H', 'F', 11000 + i, 900));
  const bands = buildDonorBands(dd);
  assert.equal(bands[0].length, 1, 'band 0 is thin');
  const m = createDrivingModel({ donors: bands, minDonors: 20 });
  const seen = new Set<number>();
  for (let i = 0; i < 40; i++) seen.add(m.estimate(`induced:${i}`, 'H', 'W', [0, 0], [0.01, 0]).distance);
  assert.ok(seen.size > 1, 'must borrow from a fuller band instead of reusing the lone donor');
});

test('the router takes precedence and its result is cached per point pair', () => {
  const graph = buildRoadGraph(roads());
  let calls = 0;
  const inner = createRouter(graph, DEFAULT_SPEEDS);
  const counting = { speeds: inner.speeds, route: (a: number, b: number) => { calls++; return inner.route(a, b); } };
  const m = createDrivingModel({ routing: { graph, router: counting } });

  const first = m.estimate('induced:1', 'H', 'W', [0, 0], [0.01, 0]);
  const second = m.estimate('induced:2', 'H', 'W', [0, 0], [0.01, 0]);
  assert.equal(calls, 1, 'the second pop on the same pair must hit the cache');
  assert.deepEqual(first, second);
  // ~1113 m of minor road at the default minor speed.
  assert.ok(Math.abs(first.distance - 1113) < 5, `got ${first.distance}`);
  assert.ok(Math.abs(first.seconds - 1113 / DEFAULT_SPEEDS.minor) < 1, `got ${first.seconds}`);
});

test('routing failure falls back to donors, then to the constants', () => {
  const graph = buildRoadGraph(roads());
  const dead = { speeds: DEFAULT_SPEEDS, route: () => null }; // never routes
  const dd = world();
  for (let i = 0; i < 40; i++) dd.popsMap.set(String(i), pop(String(i), 'H', 'W', 1500, 150));

  const withDonors = createDrivingModel({ routing: { graph, router: dead }, donors: buildDonorBands(dd) });
  assert.ok(Math.abs(withDonors.estimate('induced:1', 'H', 'W', [0, 0], [0.01, 0]).distance - 1500) < 1);

  const bare = createDrivingModel({ routing: { graph, router: dead } });
  const e = bare.estimate('induced:1', 'H', 'W', [0, 0], [0.01, 0]);
  assert.ok(e.distance > 0 && e.seconds > 0, 'constants must still produce a usable estimate');
});

test('coincident endpoints never yield a zero driving time', () => {
  // A zero drivingSeconds would make driving look instant and free to the mode choice.
  for (const m of [DEFAULT_DRIVING_MODEL, createDrivingModel({ donors: [[], [], [], [], []] })]) {
    const e = m.estimate('induced:1', 'H', 'H', [0, 0], [0, 0]);
    assert.ok(e.distance > 0, `distance ${e.distance}`);
    assert.ok(e.seconds > 0, `seconds ${e.seconds}`);
  }
});
