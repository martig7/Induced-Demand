import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Coordinate } from '../types/core';
import { haversine } from './geo';
import {
  hashStringToSeed, sampleCatchmentSites, jitterPosition, createSpacingIndex,
  type SpacingIndex,
} from './sampler';

const R = 300; // constant spacing for tests
const opts = (over: Partial<Parameters<typeof sampleCatchmentSites>[0]> = {}) => ({
  seedKey: 'TST:station1',
  center: [0, 0] as [number, number],
  radiusM: 1500,
  blockers: createSpacingIndex(),
  spacingAt: () => R,
  reject: () => false,
  softFactor: 0.65,
  ...over,
});

/**
 * Brute-force reference of the SpacingIndex predicate: same entries, same
 * softFactor·max(rNew, rEntry) rule, but a linear scan. The grid must be a pure
 * lookup optimization — any divergence is a bug in the cell-ring search.
 */
function bruteIndex(): SpacingIndex & { entries: { loc: Coordinate; r: number }[] } {
  const entries: { loc: Coordinate; r: number }[] = [];
  return {
    entries,
    insert: (loc, r) => { entries.push({ loc, r }); },
    blocked: (loc, rNew, softFactor) =>
      entries.some((e) => haversine(loc, e.loc) < softFactor * Math.max(rNew, e.r)),
    size: () => entries.length,
  };
}

test('deterministic: same seedKey → identical sites; different key → different', () => {
  const a = sampleCatchmentSites(opts());
  const b = sampleCatchmentSites(opts());
  assert.deepEqual(a, b);
  const c = sampleCatchmentSites(opts({ seedKey: 'TST:station2' }));
  assert.notDeepEqual(a.map((s) => s.location), c.map((s) => s.location));
});

test('golden: grid index produces byte-identical output to the brute-force reference', () => {
  // Varying spacing (wide west, dense east) + pre-seeded blockers stresses the
  // maxR-driven ring search and the per-entry radius rule.
  const spacingAt = (c: Coordinate) => (c[0] < 0 ? 600 : 150);
  const blockerLocs: Coordinate[] = [[0.002, 0.001], [-0.004, -0.003], [0.008, 0.006]];
  const run = (blockers: SpacingIndex) => {
    for (const loc of blockerLocs) blockers.insert(loc, spacingAt(loc));
    return sampleCatchmentSites(opts({ spacingAt, blockers }));
  };
  const viaGrid = run(createSpacingIndex());
  const viaBrute = run(bruteIndex());
  assert.deepEqual(viaGrid, viaBrute);
  assert.ok(viaGrid.length > 10, `got ${viaGrid.length}`);
});

test('fills the disc and respects soft spacing between samples', () => {
  const sites = sampleCatchmentSites(opts());
  assert.ok(sites.length > 10, `got ${sites.length}`);
  for (let i = 0; i < sites.length; i++) {
    assert.ok(haversine([0, 0], sites[i].location) <= 1500 + 1);
    for (let j = i + 1; j < sites.length; j++) {
      const d = haversine(sites[i].location, sites[j].location);
      assert.ok(d >= 0.65 * R - 1, `pair ${i},${j} at ${d}m`);
    }
  }
});

test('pre-seeded blockers exclude their soft-spacing neighborhood', () => {
  const blockers = createSpacingIndex();
  blockers.insert([0, 0], R);
  const sites = sampleCatchmentSites(opts({ blockers }));
  for (const s of sites) {
    assert.ok(haversine([0, 0], s.location) >= 0.65 * R - 1);
  }
});

test('the shared index carries spacing across catchments', () => {
  // Two overlapping catchments sampled with ONE index: every cross-catchment
  // pair must still respect soft spacing (this is what per-catchment priors
  // used to approximate and the shared index now guarantees).
  const blockers = createSpacingIndex();
  const a = sampleCatchmentSites(opts({ blockers }));
  const b = sampleCatchmentSites(opts({
    blockers, seedKey: 'TST:station2', center: [0.01, 0] as [number, number],
  }));
  assert.ok(a.length > 0 && b.length > 0);
  for (const sa of a) {
    for (const sb of b) {
      const d = haversine(sa.location, sb.location);
      assert.ok(d >= 0.65 * R - 1, `cross pair at ${d}m`);
    }
  }
});

test('reject predicate (water) excludes sites', () => {
  // reject everything west of the center
  const sites = sampleCatchmentSites(opts({ reject: (c) => c[0] < 0 }));
  assert.ok(sites.length > 0);
  for (const s of sites) assert.ok(s.location[0] >= 0);
});

test('site ids are stable and prefixed by seedKey', () => {
  const sites = sampleCatchmentSites(opts());
  assert.match(sites[0].id, /^TST:station1:0$/);
  assert.match(sites[1].id, /^TST:station1:1$/);
});

test('rejection honors the larger of both samples’ spacing radii', () => {
  // West half (lon < 0) wants wide spacing, east half (lon >= 0) wants dense.
  const spacingAt = (c: [number, number]) => (c[0] < 0 ? 600 : 150);
  const sites = sampleCatchmentSites(opts({ spacingAt }));
  assert.ok(sites.length > 10, `got ${sites.length}`);
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      const d = haversine(sites[i].location, sites[j].location);
      const rMax = Math.max(spacingAt(sites[i].location), spacingAt(sites[j].location));
      assert.ok(d >= 0.65 * rMax - 1, `pair ${i},${j} at ${d}m (need ${0.65 * rMax})`);
    }
  }
});

test('jitterPosition: within J·r, deterministic, re-rolls on rejection', () => {
  const nominal: [number, number] = [0, 0];
  const a = jitterPosition('induced-pt:7', nominal, R, 0.35, () => false);
  const b = jitterPosition('induced-pt:7', nominal, R, 0.35, () => false);
  assert.deepEqual(a, b);
  assert.ok(haversine(nominal, a) <= 0.35 * R + 1);
  assert.ok(haversine(nominal, a) > 0); // actually moved
  // rejecting every position falls back to the nominal
  const fallback = jitterPosition('induced-pt:7', nominal, R, 0.35, () => true);
  assert.deepEqual(fallback, nominal);
  // rejecting only the first attempt yields a different (re-rolled) position
  let calls = 0;
  const rerolled = jitterPosition('induced-pt:7', nominal, R, 0.35, () => calls++ === 0);
  assert.notDeepEqual(rerolled, a);
});
