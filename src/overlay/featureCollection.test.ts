import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOverlay } from './featureCollection';
import { DEFAULT_CONFIG } from '../model/config';
import { newLedger, type LedgerState } from '../model/ledger';
import type { DemandData, DemandPoint, Station } from '../types/game-state';
import type { Coordinate } from '../types/core';

const ms = (transit: number) => ({ walking: 0, driving: 100 - transit, transit, unknown: 0 });
function pt(id: string, loc: Coordinate, residents: number, jobs: number, rt: number, wt: number): DemandPoint {
  return { id, location: loc, residents, jobs, popIds: [], residentModeShare: ms(rt), workerModeShare: ms(wt) };
}
function station(coords: Coordinate, routeIds: string[]): Station {
  return { id: 's', coords, routeIds } as unknown as Station;
}
function ledgerWith(baselines: Record<string, [number, number]>): LedgerState {
  const led = newLedger();
  for (const [id, [r, j]] of Object.entries(baselines)) {
    led.points[id] = { baselineResidents: r, baselineJobs: j, resAccum: 0, jobAccum: 0 };
  }
  return led;
}

test('realized combined = induced residents + induced jobs from ledger baselines', () => {
  const dd: DemandData = { points: new Map([['H', pt('H', [0, 0], 600, 600, 0, 0)]]), popsMap: new Map() };
  const led = ledgerWith({ H: [400, 400] });
  const fc = buildOverlay(dd, led, [], 'realized', 'combined', DEFAULT_CONFIG);
  assert.equal(fc.features.length, 1);
  assert.equal(fc.features[0].properties.value, 400);
  assert.equal(fc.maxValue, 400);
  assert.equal(fc.features[0].properties.t, 1);
  assert.deepEqual(fc.features[0].geometry.coordinates, [0, 0]);
});

test('realized residential vs commercial pick the right side', () => {
  const dd: DemandData = { points: new Map([['H', pt('H', [0, 0], 600, 500, 0, 0)]]), popsMap: new Map() };
  const led = ledgerWith({ H: [400, 400] });
  assert.equal(buildOverlay(dd, led, [], 'realized', 'residential', DEFAULT_CONFIG).features[0].properties.value, 200);
  assert.equal(buildOverlay(dd, led, [], 'realized', 'commercial', DEFAULT_CONFIG).features[0].properties.value, 100);
});

test('value > 0 filter drops points with no induced growth', () => {
  const dd: DemandData = { points: new Map([['Z', pt('Z', [1, 1], 400, 400, 0, 0)]]), popsMap: new Map() };
  const led = ledgerWith({ Z: [400, 400] });
  const fc = buildOverlay(dd, led, [], 'realized', 'combined', DEFAULT_CONFIG);
  assert.equal(fc.features.length, 0);
  assert.equal(fc.maxValue, 0);
});

test('targeting uses the model score (point at a served station)', () => {
  const dd: DemandData = { points: new Map([['H', pt('H', [0, 0], 400, 0, 50, 0)]]), popsMap: new Map() };
  const fc = buildOverlay(dd, newLedger(), [station([0, 0], ['r1', 'r2', 'r3'])], 'targeting', 'residential', DEFAULT_CONFIG);
  assert.equal(fc.features.length, 1);
  assert.ok(Math.abs(fc.features[0].properties.value - 0.5) < 1e-6);
});

test('normalization sets t = value / maxValue across points', () => {
  const dd: DemandData = {
    points: new Map([
      ['A', pt('A', [0, 0], 500, 400, 0, 0)],
      ['B', pt('B', [0, 1], 600, 400, 0, 0)],
    ]),
    popsMap: new Map(),
  };
  const led = ledgerWith({ A: [400, 400], B: [400, 400] });
  const fc = buildOverlay(dd, led, [], 'realized', 'residential', DEFAULT_CONFIG);
  assert.equal(fc.maxValue, 200);
  const byId = Object.fromEntries(fc.features.map((f) => [f.properties.id, f.properties.t]));
  assert.equal(byId['B'], 1);
  assert.equal(byId['A'], 0.5);
});
