import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDump, parseDump } from './dump';
import { buildBlockedRasterFromFiles } from '../game/blockedRaster';
import type { OceanDepthFile } from '../game/waterIndex';
import type { AirportFeatureCollection } from '../game/airportIndex';

test('dump: carries the water mask; the raster built from it is blocked inside the polygon', () => {
  const water: OceanDepthFile = {
    cs: 1, bbox: [0, 0, 1, 1], grid: [1, 1],
    cells: [[0, 0, 0]],
    depths: [{ b: [0, 0, 1, 1], d: 5, p: [[[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]] }],
  };
  const parsed = parseDump(buildDump('T', [], [], [], [], water, null));
  assert.ok(parsed.waterFile, 'raw water carried through');
  assert.equal(parsed.airportFile, null);
  const r = buildBlockedRasterFromFiles(parsed.waterFile, parsed.airportFile, 500);
  assert.ok(r, 'raster built');
  assert.equal(r!.blockedWithin([0.5, 0.5], 0), true, 'inside the water polygon');
  assert.equal(r!.blockedWithin([0.05, 0.05], 0), false, 'outside the polygon');
});

test('dump: carries the airport mask; raster blocked inside the apron', () => {
  const airport: AirportFeatureCollection = {
    features: [{ geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.02, 0], [0.02, 0.02], [0, 0.02]]] } }],
  };
  const parsed = parseDump(buildDump('T', [], [], [], [], null, airport));
  const r = buildBlockedRasterFromFiles(parsed.waterFile, parsed.airportFile, 200);
  assert.ok(r, 'raster built from airport-only');
  assert.equal(r!.blockedWithin([0.01, 0.01], 0), true, 'inside the apron polygon');
});

test('dump: no masks → null raw + null raster (masking off, back-compat)', () => {
  const parsed = parseDump(buildDump('T', [], [], [], []));
  assert.equal(parsed.waterFile, null);
  assert.equal(parsed.airportFile, null);
  assert.equal(buildBlockedRasterFromFiles(parsed.waterFile, parsed.airportFile, 25), null);
});
