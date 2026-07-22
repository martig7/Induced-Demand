import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPopDensity } from './localDensity';
import type { DemandPoint } from '../types/game-state';

const ZERO = { walking: 0, driving: 0, transit: 0, unknown: 0 };
const pt = (id: string, lon: number, lat: number, residents: number, jobs: number): DemandPoint => ({
  id, location: [lon, lat], residents, jobs, popIds: [], residentModeShare: ZERO, workerModeShare: ZERO,
});

test('buildPopDensity: people/m² = (residents + jobs) within the radius ÷ disc area', () => {
  const R = 600;
  const pd = buildPopDensity([pt('a', 0, 0, 3000, 5000)], R);
  assert.ok(Math.abs(pd.at([0, 0]) - 8000 / (Math.PI * R * R)) < 1e-12, 'at the point');
  assert.equal(pd.at([1, 1]), 0, 'far outside every radius → 0');
});

test('buildPopDensity: a dense cluster reads higher than a lone point', () => {
  const R = 600;
  const cluster = Array.from({ length: 5 }, (_, i) => pt(`p${i}`, i * 0.0005, 0, 1000, 0)); // ~55 m apart
  const dense = buildPopDensity(cluster, R);
  const sparse = buildPopDensity([cluster[2]], R);
  assert.ok(dense.at([0.001, 0]) > sparse.at([0.001, 0]), 'cluster is denser than one point');
});

test('buildPopDensity: empty field → 0 everywhere, no throw', () => {
  assert.equal(buildPopDensity([], 600).at([0, 0]), 0);
});
