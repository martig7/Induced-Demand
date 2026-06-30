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
  // current 600 > cap 400 -> -R_DECAY*(600-400)
  assert.ok(Math.abs(logisticDelta(400, 600, 400, 0, cfg) - -cfg.R_DECAY * 200) < 1e-9);
});

test('logisticDelta: zero when cap is non-positive', () => {
  assert.equal(logisticDelta(0, 0, 0, 0.5, cfg), 0);
});
