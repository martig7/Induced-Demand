import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Coordinate } from '../types/core';
import { buildJobDensity } from './agglomeration';
import { DEFAULT_CONFIG } from './config';

test('buildJobDensity: job cores read ~1, periphery ~0, far land 0', () => {
  const pts: { location: Coordinate; jobs: number }[] = [];
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) {
    pts.push({ location: [i * 0.001, j * 0.001], jobs: 1000 }); // dense cluster near [0,0]
  }
  pts.push({ location: [1, 1], jobs: 1000 }); // isolated lone job point
  const jd = buildJobDensity(pts, DEFAULT_CONFIG);

  const core = jd.at([0.005, 0.005]);
  const isolated = jd.at([1, 1]);
  assert.ok(core > isolated, `core ${core} > isolated ${isolated}`);
  assert.ok(core > 0.5, `core is dense (${core})`);
  assert.ok(isolated < 0.2, `isolated is sparse (${isolated})`);
  assert.equal(jd.at([5, 5]), 0, 'far from any jobs → 0');
  assert.ok(core <= 1 + 1e-9, 'normalized to ≤ 1');
});

test('buildJobDensity: empty / no-jobs input → 0 everywhere', () => {
  assert.equal(buildJobDensity([], DEFAULT_CONFIG).at([0, 0]), 0);
  assert.equal(buildJobDensity([{ location: [0, 0], jobs: 0 }], DEFAULT_CONFIG).at([0, 0]), 0);
});
