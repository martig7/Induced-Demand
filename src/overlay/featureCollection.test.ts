import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOverlay } from './featureCollection';
import { DEFAULT_CONFIG } from '../model/config';
import type { DemandData, DemandPoint, Pop, Station } from '../types/game-state';
import type { Coordinate } from '../types/core';

const ms = (transit: number) => ({ walking: 0, driving: 100 - transit, transit, unknown: 0 });
function pt(id: string, loc: Coordinate, residents: number, jobs: number, rt: number, wt: number): DemandPoint {
  return { id, location: loc, residents, jobs, popIds: [], residentModeShare: ms(rt), workerModeShare: ms(wt) };
}
function station(coords: Coordinate, routeIds: string[]): Station {
  return { id: 's', coords, routeIds } as unknown as Station;
}
function inducedPop(id: string, residenceId: string, jobId: string): Pop {
  return { id, size: 200, residenceId, jobId } as Pop;
}

test('realized counts induced pop sizes anchored at each point (combined = residence + job)', () => {
  const dd: DemandData = {
    points: new Map([
      ['H', pt('H', [0, 0], 800, 0, 0, 0)],
      ['W', pt('W', [0, 0.001], 0, 800, 0, 0)],
    ]),
    popsMap: new Map([
      ['induced:0', inducedPop('induced:0', 'H', 'W')],
      ['induced:1', inducedPop('induced:1', 'H', 'W')],
    ]),
  };
  const fc = buildOverlay(dd, [], 'realized', 'combined', DEFAULT_CONFIG);
  const byId = Object.fromEntries(fc.features.map((f) => [f.properties.id, f.properties.value]));
  assert.equal(byId['H'], 400); // 2 pops reside at H -> 400 induced residents
  assert.equal(byId['W'], 400); // 2 pops work at W -> 400 induced jobs
  assert.equal(fc.maxValue, 400);
});

test('realized residential vs commercial split by anchor side', () => {
  const dd: DemandData = {
    points: new Map([
      ['H', pt('H', [0, 0], 200, 0, 0, 0)],
      ['W', pt('W', [0, 0.001], 0, 200, 0, 0)],
    ]),
    popsMap: new Map([['induced:0', inducedPop('induced:0', 'H', 'W')]]),
  };
  const res = buildOverlay(dd, [], 'realized', 'residential', DEFAULT_CONFIG);
  assert.equal(res.features.find((f) => f.properties.id === 'H')!.properties.value, 200);
  assert.equal(res.features.some((f) => f.properties.id === 'W'), false); // W has no residential induced
  const com = buildOverlay(dd, [], 'realized', 'commercial', DEFAULT_CONFIG);
  assert.equal(com.features.find((f) => f.properties.id === 'W')!.properties.value, 200);
});

test('realized ignores non-induced (base) pops', () => {
  const dd: DemandData = {
    points: new Map([['H', pt('H', [0, 0], 1000, 0, 0, 0)]]),
    popsMap: new Map([['base-7', { id: 'base-7', size: 200, residenceId: 'H', jobId: 'H' } as Pop]]),
  };
  const fc = buildOverlay(dd, [], 'realized', 'combined', DEFAULT_CONFIG);
  assert.equal(fc.features.length, 0);
  assert.equal(fc.maxValue, 0);
});

test('realized still counts pops queued for deferred removal', () => {
  const dd: DemandData = {
    points: new Map([
      ['H', pt('H', [0, 0], 400, 0, 0, 0)],
      ['W', pt('W', [0, 0.001], 0, 400, 0, 0)],
    ]),
    popsMap: new Map([
      ['induced:0', inducedPop('induced:0', 'H', 'W')],
      ['induced:1', inducedPop('induced:1', 'H', 'W')],
    ]),
  };
  const fc = buildOverlay(dd, [], 'realized', 'combined', DEFAULT_CONFIG);
  const byId = Object.fromEntries(fc.features.map((f) => [f.properties.id, f.properties.value]));
  assert.equal(byId['H'], 400);
  assert.equal(byId['W'], 400);
});

test('targeting uses the model score (point at a served station)', () => {
  const dd: DemandData = { points: new Map([['H', pt('H', [0, 0], 400, 0, 50, 0)]]), popsMap: new Map() };
  const fc = buildOverlay(dd, [station([0, 0], ['r1', 'r2', 'r3'])], 'targeting', 'residential', DEFAULT_CONFIG);
  assert.equal(fc.features.length, 1);
  // access-dominant score: access(1.0) × (0.5 + 0.5×0.5) = 0.75
  assert.ok(Math.abs(fc.features[0].properties.value - 0.75) < 1e-6);
});

test('targeting ignores stations with no routes', () => {
  const dd: DemandData = { points: new Map([['H', pt('H', [0, 0], 400, 0, 50, 0)]]), popsMap: new Map() };
  const fc = buildOverlay(dd, [station([0, 0], [])], 'targeting', 'residential', DEFAULT_CONFIG);
  assert.equal(fc.features.length, 0);
});

test('normalization sets t = value / maxValue across points', () => {
  const dd: DemandData = {
    points: new Map([
      ['A', pt('A', [0, 0], 200, 0, 0, 0)],
      ['B', pt('B', [0, 1], 400, 0, 0, 0)],
      ['J', pt('J', [0, 2], 0, 600, 0, 0)],
    ]),
    popsMap: new Map([
      ['induced:0', inducedPop('induced:0', 'A', 'J')],
      ['induced:1', inducedPop('induced:1', 'B', 'J')],
      ['induced:2', inducedPop('induced:2', 'B', 'J')],
    ]),
  };
  const fc = buildOverlay(dd, [], 'realized', 'residential', DEFAULT_CONFIG);
  const byId = Object.fromEntries(fc.features.map((f) => [f.properties.id, f.properties]));
  assert.equal(fc.maxValue, 400);
  assert.equal(byId['B'].value, 400);
  assert.equal(byId['B'].t, 1);
  assert.equal(byId['A'].value, 200);
  assert.equal(byId['A'].t, 0.5);
  assert.equal('J' in byId, false); // J is a job point, no residential induced
});
