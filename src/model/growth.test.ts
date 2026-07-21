import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cap, logisticDelta } from './growth';
import { DEFAULT_CONFIG } from './config';

const cfg = DEFAULT_CONFIG;

test('cap scales baseline by (1 + K_MAX*score)', () => {
  assert.equal(cap(1000, 0.5, 1), 1500);
  assert.equal(cap(1000, 0, 1), 1000);
});

test('logisticDelta: positive below cap, zero at cap', () => {
  assert.ok(logisticDelta(1000, 1000, 1500, 0.5, cfg) > 0);
  assert.equal(logisticDelta(1000, 1500, 1500, 0.5, cfg), 0);
});

test('logisticDelta: no growth when score is 0 and under cap', () => {
  assert.equal(logisticDelta(1000, 1000, 1000, 0, cfg), 0);
});

test('logisticDelta: decays at R_DECAY when over cap, even at score 0', () => {
  // cap == baseline (access gone): band vanishes, decays fully toward baseline.
  // current 600 > cap 400 -> -R_DECAY*(600-400)
  assert.ok(Math.abs(logisticDelta(400, 600, 400, 0, cfg) - -cfg.R_DECAY * 200) < 1e-9);
});

test('logisticDelta: tolerance band scales with headroom, absorbs small over-cap', () => {
  // baseline 1000, cap 1500 → headroom 500 → band = 1500 + 0.25·500 = 1625.
  assert.equal(logisticDelta(1000, 1600, 1500, 0.5, cfg), 0, 'within band → no decay');
  assert.ok(Math.abs(logisticDelta(1000, 1700, 1500, 0.5, cfg) - -cfg.R_DECAY * 75) < 1e-9,
    'beyond band → decay toward the band edge');
});

test('logisticDelta: zero when cap is non-positive', () => {
  assert.equal(logisticDelta(0, 0, 0, 0.5, cfg), 0);
});
