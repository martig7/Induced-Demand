import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp, clamp01 } from './util';
import { DEFAULT_CONFIG } from './config';

test('clamp bounds a value', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(clamp(2, 0, 3), 2);
});

test('clamp01 bounds to [0,1]', () => {
  assert.equal(clamp01(1.5), 1);
  assert.equal(clamp01(-0.2), 0);
  assert.equal(clamp01(0.4), 0.4);
});

test('DEFAULT_CONFIG: pop size 200, decay slower than growth', () => {
  assert.equal(DEFAULT_CONFIG.POP_SIZE, 200);
  assert.ok(DEFAULT_CONFIG.R_DECAY < DEFAULT_CONFIG.R_GROW);
});
