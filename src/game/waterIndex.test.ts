import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWaterIndex, type OceanDepthFile } from './waterIndex';

/** 1°×1° world, 10×10 grid (cs=0.1). One square lake polygon covering [0.3..0.5]². */
const LAKE: OceanDepthFile = {
  cs: 0.1,
  bbox: [0, 0, 1, 1],
  grid: [10, 10],
  cells: [
    // lake spans grid cells cols 3-5, rows 3-5 (poly index 0)
    [3, 3, 0], [4, 3, 0], [5, 3, 0],
    [3, 4, 0], [4, 4, 0], [5, 4, 0],
    [3, 5, 0], [4, 5, 0], [5, 5, 0],
  ],
  depths: [{
    b: [0.3, 0.3, 0.5, 0.5],
    d: -4,
    p: [[[0.3, 0.3], [0.5, 0.3], [0.5, 0.5], [0.3, 0.5], [0.3, 0.3]]],
  }],
};

test('point inside the lake is water', () => {
  const idx = buildWaterIndex(LAKE);
  assert.equal(idx.isWater([0.4, 0.4]), true);
});

test('point on land (no cell entry) is not water', () => {
  const idx = buildWaterIndex(LAKE);
  assert.equal(idx.isWater([0.85, 0.85]), false);
});

test('point in a water-adjacent cell but outside the polygon is not water', () => {
  const idx = buildWaterIndex(LAKE);
  // cell (3,3) covers lon .3-.4 lat .3-.4 — but the polygon starts exactly at .3;
  // a point just outside the ring within the same cell must be dry:
  assert.equal(idx.isWater([0.30001, 0.29999]), false);
});

test('out-of-bbox points are not water', () => {
  const idx = buildWaterIndex(LAKE);
  assert.equal(idx.isWater([5, 5]), false);
  assert.equal(idx.isWater([-1, 0.5]), false);
});

test('polygon holes: a ring inside a ring is dry (even-odd)', () => {
  const donut: OceanDepthFile = {
    ...LAKE,
    depths: [{
      b: [0.3, 0.3, 0.5, 0.5],
      d: -4,
      p: [
        [[0.3, 0.3], [0.5, 0.3], [0.5, 0.5], [0.3, 0.5], [0.3, 0.3]],
        [[0.38, 0.38], [0.42, 0.38], [0.42, 0.42], [0.38, 0.42], [0.38, 0.38]], // island
      ],
    }],
  };
  const idx = buildWaterIndex(donut);
  assert.equal(idx.isWater([0.4, 0.4]), false); // on the island
  assert.equal(idx.isWater([0.34, 0.34]), true); // in the ring
});
