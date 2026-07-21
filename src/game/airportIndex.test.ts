import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAirportIndex, type AirportFeatureCollection } from './airportIndex';

test('airportIndex: point-in-polygon over apron/runway polygons, tolerates null geometry', () => {
  const geo: AirportFeatureCollection = {
    features: [
      // a 0.01°×0.01° apron near [0,0]
      { geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 0.01], [0.01, 0.01], [0.01, 0], [0, 0]]] } },
      { geometry: null }, // some features have null geometry — must be skipped
      // a runway multipolygon near [1,1]
      { geometry: { type: 'MultiPolygon', coordinates: [[[[1, 1], [1, 0.01 + 1], [1.01, 1.01], [1.01, 1], [1, 1]]]] } },
    ],
  };
  const idx = buildAirportIndex(geo);
  assert.equal(idx.isAirport([0.005, 0.005]), true, 'inside the apron');
  assert.equal(idx.isAirport([0.02, 0.02]), false, 'outside the apron');
  assert.equal(idx.isAirport([1.005, 1.005]), true, 'inside the runway multipolygon');
  assert.equal(idx.isAirport([-5, -5]), false, 'far away → empty grid cell, no test');
});
