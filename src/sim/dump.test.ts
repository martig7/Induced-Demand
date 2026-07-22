import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDump, parseDump } from './dump';
import type { OceanDepthFile } from '../game/waterIndex';
import type { AirportFeatureCollection } from '../game/airportIndex';

test('dump: carries the water mask and parseDump rebuilds a working index', () => {
  // 1-cell grid over [0,0]-[1,1] with one square water polygon.
  const water: OceanDepthFile = {
    cs: 1, bbox: [0, 0, 1, 1], grid: [1, 1],
    cells: [[0, 0, 0]],
    depths: [{ b: [0, 0, 1, 1], d: 5, p: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }],
  };
  const parsed = parseDump(buildDump('T', [], [], [], [], water, null));
  assert.ok(parsed.water, 'water index rebuilt from the dump');
  assert.equal(parsed.water!.isWater([0.5, 0.5]), true, 'inside the water polygon');
  assert.equal(parsed.water!.isWater([2, 2]), false, 'outside the grid');
  assert.equal(parsed.airport, null, 'no airport dumped → null');
});

test('dump: carries the airport mask and parseDump rebuilds a working index', () => {
  const airport: AirportFeatureCollection = {
    features: [{ geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]]] } }],
  };
  const parsed = parseDump(buildDump('T', [], [], [], [], null, airport));
  assert.ok(parsed.airport, 'airport index rebuilt');
  assert.equal(parsed.airport!.isAirport([0.005, 0.005]), true, 'inside the apron polygon');
  assert.equal(parsed.airport!.isAirport([1, 1]), false, 'off airport');
});

test('dump: no masks → parseDump yields null indexes (masking off, back-compat)', () => {
  const parsed = parseDump(buildDump('T', [], [], [], []));
  assert.equal(parsed.water, null);
  assert.equal(parsed.airport, null);
});
