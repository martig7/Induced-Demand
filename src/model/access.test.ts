import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, type AccessStation } from './access';
import { DEFAULT_CONFIG } from './config';
import type { Coordinate } from '../types/core';

const P: Coordinate = [0, 0];

test('access: zero when no stations', () => {
  assert.equal(access(P, [], DEFAULT_CONFIG), 0);
});

test('access: zero when nearest station is beyond catchment', () => {
  const far: AccessStation = { coords: [0, 1], lineIds: ['r1'] }; // ~111km
  assert.equal(access(P, [far], DEFAULT_CONFIG), 0);
});

test('access: ~1 for an on-point station with 3+ lines', () => {
  const s: AccessStation = { coords: [0, 0], lineIds: ['r1', 'r2', 'r3'] };
  assert.ok(Math.abs(access(P, [s], DEFAULT_CONFIG) - 1) < 1e-9);
});

test('access: single-line on-point station uses the connectivity floor', () => {
  const s: AccessStation = { coords: [0, 0], lineIds: ['r1'] };
  // walkProx=1; connectivity=1/3; access = 0.5 + 0.5*(1/3)
  assert.ok(Math.abs(access(P, [s], DEFAULT_CONFIG) - (0.5 + 0.5 / 3)) < 1e-9);
});
