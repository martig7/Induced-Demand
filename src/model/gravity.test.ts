import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng, pairByGravity } from './gravity';
import { DEFAULT_CONFIG } from './config';
import type { Coordinate } from '../types/core';

test('makeRng is deterministic for a seed', () => {
  const a = makeRng(42), b = makeRng(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});

test('pairByGravity pairs each residence with the overwhelmingly nearer job', () => {
  const loc = new Map<string, Coordinate>([
    ['H', [0, 0]],
    ['near', [0, 0.001]], // ~111m
    ['far', [0, 5]],      // ~555km, negligible weight
  ]);
  const pairs = pairByGravity(['H'], ['near', 'far'], loc, DEFAULT_CONFIG, makeRng(1));
  assert.deepEqual(pairs, [['H', 'near']]);
});

test('pairByGravity returns min(pool) pairs and consumes jobs once', () => {
  const loc = new Map<string, Coordinate>([
    ['H1', [0, 0]], ['H2', [0, 0]], ['W', [0, 0.001]],
  ]);
  const pairs = pairByGravity(['H1', 'H2'], ['W'], loc, DEFAULT_CONFIG, makeRng(1));
  assert.equal(pairs.length, 1);
});
