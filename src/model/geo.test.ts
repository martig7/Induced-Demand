import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversine, walkSeconds } from './geo';
import type { Coordinate } from '../types/core';

const O: Coordinate = [0, 0];

test('haversine: zero distance for same point', () => {
  assert.equal(haversine(O, O), 0);
});

test('haversine: ~111km per degree of latitude', () => {
  const d = haversine(O, [0, 1]);
  assert.ok(Math.abs(d - 111195) < 500, `got ${d}`);
});

test('walkSeconds: distance / speed', () => {
  const d = haversine(O, [0, 1]);
  assert.ok(Math.abs(walkSeconds(O, [0, 1], 1) - d) < 1e-6);
  assert.ok(Math.abs(walkSeconds(O, [0, 1], 2) - d / 2) < 1e-6);
});
