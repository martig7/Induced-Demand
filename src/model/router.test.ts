import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, DEFAULT_SPEEDS } from './router';
import { buildRoadGraph, snapToNode, type RoadFeatureCollection } from './roadGraph';
import type { Coordinate } from '../types/core';

/**
 * A detour test-bed. From A(0,0) to C(0.04,0):
 *   - direct minor road straight along the bottom (shortest distance);
 *   - a dog-leg via a highway going north, across, and back south (longer, faster).
 * Time-weighted routing must prefer the highway; distance-weighted would not.
 */
function detourWorld(): RoadFeatureCollection {
  const way = (roadClass: 'highway' | 'major' | 'minor', coordinates: Coordinate[]): never =>
    ({ type: 'Feature', properties: { roadClass }, geometry: { type: 'LineString', coordinates } }) as never;
  return {
    type: 'FeatureCollection',
    features: [
      way('minor', [[0, 0], [0.04, 0]]),                 // direct, slow
      way('highway', [[0, 0], [0, 0.005]]),              // on-ramp
      way('highway', [[0, 0.005], [0.04, 0.005]]),       // the fast link
      way('highway', [[0.04, 0.005], [0.04, 0]]),        // off-ramp
    ],
  };
}

const at = (g: ReturnType<typeof buildRoadGraph>, c: Coordinate): number => snapToNode(g, c)!.node;

test('router finds a route and reports distance, time and the road classes used', () => {
  const g = buildRoadGraph(detourWorld());
  const r = createRouter(g, DEFAULT_SPEEDS).route(at(g, [0, 0]), at(g, [0.04, 0]));
  assert.ok(r);
  assert.ok(r.distance > 0 && r.seconds > 0);
  assert.equal(r.classLengths.length, 3);
  assert.ok(Math.abs(r.classLengths.reduce((a, b) => a + b, 0) - r.distance) < 1e-6);
});

test('router minimizes TIME, taking the longer highway over the shorter minor road', () => {
  const g = buildRoadGraph(detourWorld());
  const r = createRouter(g, DEFAULT_SPEEDS).route(at(g, [0, 0]), at(g, [0.04, 0]))!;
  const direct = g.len[0]; // the minor way's own length
  assert.ok(r.distance > direct, `expected a detour, got ${r.distance} vs direct ${direct}`);
  assert.ok(r.classLengths[0] > 0, 'highway must be used');
  assert.equal(r.classLengths[2], 0, 'the slow minor road must be avoided entirely');
});

test('router takes the direct road when the detour is not worth it', () => {
  const g = buildRoadGraph(detourWorld());
  // Make the highway barely faster than the minor road: the dog-leg no longer pays.
  const r = createRouter(g, { highway: 9, major: 9, minor: 8 }).route(at(g, [0, 0]), at(g, [0.04, 0]))!;
  assert.ok(r.classLengths[2] > 0, 'minor road should now be used');
  assert.ok(Math.abs(r.distance - g.len[0]) < 1, 'should take the direct way');
});

test('router returns seconds consistent with the class speeds', () => {
  const g = buildRoadGraph(detourWorld());
  const speeds = { highway: 20, major: 12, minor: 8 };
  const r = createRouter(g, speeds).route(at(g, [0, 0]), at(g, [0.04, 0]))!;
  const expected = r.classLengths[0] / speeds.highway + r.classLengths[1] / speeds.major
    + r.classLengths[2] / speeds.minor;
  assert.ok(Math.abs(r.seconds - expected) < 1e-6);
});

test('router returns null for a disconnected pair and zero for a trivial one', () => {
  const g = buildRoadGraph({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { roadClass: 'minor' }, geometry: { type: 'LineString', coordinates: [[0, 0], [0.01, 0]] } },
      { type: 'Feature', properties: { roadClass: 'minor' }, geometry: { type: 'LineString', coordinates: [[5, 5], [5.01, 5]] } },
    ],
  });
  const router = createRouter(g, DEFAULT_SPEEDS);
  assert.equal(router.route(at(g, [0, 0]), at(g, [5, 5])), null);
  const same = router.route(at(g, [0, 0]), at(g, [0, 0]))!;
  assert.equal(same.distance, 0);
  assert.equal(same.seconds, 0);
});

test('router is reusable across queries (shared scratch state is reset)', () => {
  const g = buildRoadGraph(detourWorld());
  const router = createRouter(g, DEFAULT_SPEEDS);
  const a = router.route(at(g, [0, 0]), at(g, [0.04, 0]))!;
  router.route(at(g, [0.04, 0]), at(g, [0, 0]));
  const c = router.route(at(g, [0, 0]), at(g, [0.04, 0]))!;
  assert.deepEqual(a, c, 'repeating a query must give an identical result');
});

test('router path nodes start at the origin and end at the destination', () => {
  const g = buildRoadGraph(detourWorld());
  const from = at(g, [0, 0]), to = at(g, [0.04, 0]);
  const r = createRouter(g, DEFAULT_SPEEDS).route(from, to)!;
  assert.equal(r.nodes[0], from);
  assert.equal(r.nodes[r.nodes.length - 1], to);
});
